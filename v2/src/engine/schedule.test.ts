import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, db, pgPool } from "@/db/client";
import { freshEngineDb } from "@/test/engine-db";
import { chain, flow, harness, STORES } from "@/test/harness";
import { disableWorkflow, saveVersion } from "./config";
import { Engine } from "./engine";
import { FakePorts } from "./fake-ports";
import { migrateJobs, runJobsOnce } from "./jobs";
import { PgStore } from "./pg-store";
import { nextFire, periodOf } from "./schedule";
import { install, setupOffer } from "./testkit";

/**
 * Schedule triggers fire from their timers (jobs at exact times): once per period per subject, on the offer's clock,
 * for the offer or for each person with the role. A late job still runs its period once; a period the worker missed
 * entirely is not made up, as v1's clock.
 */

type N = Record<string, unknown>;
const NY = "America/New_York";
const sched = (schedule: N): N => ({ id: "t", type: "trigger@1", title: "Clock", on: { schedule } });
const post: N = { id: "m", type: "message@1", title: "Post", to: { slack: { channel: "{{setting.slack.channel.ops}}" } }, content: "c.m" };
const end: N = { id: "x", type: "end@1", title: "Done", reason: "done" };
const wf = (schedule: N, id = "w") => flow(id, [sched(schedule), post, end], chain("t", "m", "x"));
const content = { "c.m": { channel: "slack" as const, body: "{{person.name | default:the offer}} for {{event.period}}" } };
const SETTINGS = { "slack.channel.ops": "C-OPS" };

afterAll(async () => { await closeDb(); });

describe("the schedule's arithmetic", () => {
  it("names the period it is in when due: the local date once the time has passed on its days; the bucket for an interval", () => {
    const s = { at: "18:00", for: "offer" as const };
    expect(periodOf(s, new Date("2026-10-26T21:59:00Z"), NY)).toBeNull();
    expect(periodOf(s, new Date("2026-10-26T22:00:00Z"), NY)).toBe("2026-10-26");
    expect(periodOf(s, new Date("2026-10-27T03:59:00Z"), NY)).toBe("2026-10-26");
    expect(periodOf({ ...s, days: [1] }, new Date("2026-10-27T22:30:00Z"), NY)).toBeNull();
    expect(periodOf({ ...s, dayOfMonth: 1 }, new Date("2026-11-01T22:30:00Z"), NY)).toBeNull(); // 5:30 PM: the clocks went back that morning
    expect(periodOf({ ...s, dayOfMonth: 1 }, new Date("2026-11-01T23:30:00Z"), NY)).toBe("2026-11-01");
    expect(periodOf({ every: "1h", for: "offer" }, new Date("2026-10-26T14:59:00Z"), NY)).toBe(periodOf({ every: "1h", for: "offer" }, new Date("2026-10-26T14:00:00Z"), NY));
  });

  it("works out the next time on the offer's clock, across a change of the clocks", () => {
    expect(nextFire({ at: "18:00", for: "offer" }, new Date("2026-10-26T12:00:00Z"), NY).toISOString()).toBe("2026-10-26T22:00:00.000Z");
    expect(nextFire({ at: "18:00", for: "offer" }, new Date("2026-10-26T22:00:00Z"), NY).toISOString()).toBe("2026-10-27T22:00:00.000Z");
    expect(nextFire({ at: "09:00", days: [1], for: "offer" }, new Date("2026-10-27T12:00:00Z"), NY).toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(nextFire({ at: "08:00", dayOfMonth: 1, for: "offer" }, new Date("2026-10-27T12:00:00Z"), NY).toISOString()).toBe("2026-11-01T13:00:00.000Z");
    expect(nextFire({ every: "1h", for: "offer" }, new Date("2026-10-26T14:20:00Z"), NY).toISOString()).toBe("2026-10-26T15:00:00.000Z");
  });
});

describe.each(STORES)("schedule triggers, on %s", (kind) => {
  it("fire from the timer at their time, once per period, and set the next time", async () => {
    const h = await harness(kind, { start: "2026-10-26T12:00:00Z", zone: NY, settings: SETTINGS, content, workflows: [wf({ at: "18:00", for: "offer" })] });
    expect((await h.store.tx((tx) => tx.scheduleTimers({ offerId: h.offerId }))).map((t) => t.nextAt.toISOString())).toEqual(["2026-10-26T22:00:00.000Z"]);
    await h.advance("10h");
    expect((await h.runs()).map((r) => r.status)).toEqual(["completed"]);
    expect(h.fp.effects("slack").map((c) => (c.args as { text: string }).text)).toEqual(["the offer for 2026-10-26"]);
    await h.advance("23h");
    expect((await h.runs())).toHaveLength(1);
    await h.advance("2h");
    expect((await h.runs())).toHaveLength(2);
  });

  it("a job that runs late fires its period once; a day the worker missed entirely is not made up", async () => {
    const h = await harness(kind, { start: "2026-10-26T12:00:00Z", zone: NY, settings: SETTINGS, content, workflows: [wf({ at: "18:00", for: "offer" })] });
    // the worker is down from before 6pm to 11pm: the job runs then, once, for today
    h.clock.set("2026-10-27T03:00:00Z");
    await h.due();
    await h.due();
    expect(h.fp.effects("slack").map((c) => (c.args as { text: string }).text)).toEqual(["the offer for 2026-10-26"]);
    // down again from then to the morning two days later: neither missed evening is run; the next is tonight's
    h.clock.set("2026-10-29T14:00:00Z");
    await h.due();
    expect(await h.runs()).toHaveLength(1);
    expect((await h.store.tx((tx) => tx.scheduleTimers({ offerId: h.offerId })))[0]!.nextAt.toISOString()).toBe("2026-10-29T22:00:00.000Z");
    h.clock.set("2026-10-29T22:00:00Z");
    await h.due();
    expect(h.fp.effects("slack").map((c) => (c.args as { text: string }).text)).toEqual(["the offer for 2026-10-26", "the offer for 2026-10-29"]);
  });

  it("for a role: one run per active person with it, from the people projection, each once per period", async () => {
    const h = await harness(kind, { start: "2026-10-26T12:00:00Z", zone: NY, settings: SETTINGS, content, workflows: [wf({ at: "18:00", for: { role: "closer" } })] });
    await h.ingest("person.added", { contact: null, payload: { person: { id: "u1", name: "Luis", roles: ["closer"] } } });
    await h.ingest("person.added", { contact: null, payload: { person: { id: "u2", name: "Mia", roles: ["setter"] } } });
    await h.ingest("person.added", { contact: null, payload: { person: { id: "u3", name: "Ana", roles: ["closer", "setter"] } } });
    await h.ingest("person.removed", { contact: null, payload: { person: { id: "u3" } } });
    await h.advance("10h");
    const runs = await h.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.context.subjects).toMatchObject({ person: { id: "u1", name: "Luis", eod: { day: "2026-10-26", filed: false } } });
    // the same period fired again by hand starts nothing new
    expect(await h.engine.firePeriod({ workflowId: h.wfs.w!.id, node: "t", at: h.clock.now(), period: "2026-10-26" })).toEqual([]);
  });

  it("go when the workflow is turned off, and follow a new version's triggers", async () => {
    const h = await harness(kind, { start: "2026-10-26T12:00:00Z", zone: NY, settings: SETTINGS, content, workflows: [wf({ at: "18:00", for: "offer" })] });
    await h.store.tx((tx) => saveVersion(tx, { offerId: h.offerId, definition: wf({ every: "1h", for: "offer" }), by: "t", why: "hourly", now: h.clock.now() }));
    expect((await h.store.tx((tx) => tx.scheduleTimers({ offerId: h.offerId }))).map((t) => t.nextAt.toISOString())).toEqual(["2026-10-26T13:00:00.000Z"]);
    await h.store.tx((tx) => disableWorkflow(tx, h.wfs.w!.id));
    expect(await h.store.tx((tx) => tx.scheduleTimers({ offerId: h.offerId }))).toEqual([]);
    await h.advance("1d");
    expect(await h.runs()).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("the schedule's job (graphile-worker)", () => {
  beforeEach(async () => { await freshEngineDb(); await migrateJobs(pgPool()); await db().execute(sql`delete from graphile_worker._private_jobs`); });

  it("is written with the timer, at its exact time, and when it runs fires the period and writes the next", async () => {
    const store = new PgStore(db(), "graphile");
    const offerId = await setupOffer(store, { slug: "acme", zone: NY, settings: SETTINGS, content });
    const start = new Date(Date.now() - 2 * 3_600_000);
    const w = await install(store, offerId, wf({ every: "1h", for: "offer" }), { now: start, delivery: "live", crmWrites: "real" });
    const jobs = async () => (await db().execute(sql`select task_identifier as task, key, run_at from graphile_worker.jobs order by id`)).rows as { task: string; key: string; run_at: Date }[];
    const first = (await jobs()).find((j) => j.key === `schedule:${w.id}:t`)!;
    expect(first.task).toBe("fire_schedule");
    expect(new Date(first.run_at).getTime()).toBe((await store.tx((tx) => tx.scheduleTimers({ workflowId: w.id })))[0]!.nextAt.getTime());
    const engine = new Engine({ store, ports: new FakePorts().ports() });
    await runJobsOnce({ pgPool: pgPool(), engine });
    expect((await store.tx((tx) => tx.runs({ offerId })))).toHaveLength(1);
    const next = (await jobs()).find((j) => j.key === `schedule:${w.id}:t`)!;
    expect(new Date(next.run_at).getTime()).toBeGreaterThan(Date.now());
  });
});
