import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, db, pgPool } from "@/db/client";
import { freshEngineDb } from "@/test/engine-db";
import { chain, flow } from "@/test/harness";
import { Engine } from "./engine";
import { FakePorts } from "./fake-ports";
import { migrateJobs, runJobsOnce } from "./jobs";
import { PgStore } from "./pg-store";
import { install, setupOffer } from "./testkit";

/** What the database itself refuses, whatever code asks: the rules hold even for a bug or a hand-written query. */

const q = (text: string) => db().execute(sql.raw(text));
const refused = async (text: string, what: RegExp) => { await expect(q(text)).rejects.toThrow(); try { await q(text); } catch (e) { expect(String((e as { cause?: { message?: string } }).cause?.message ?? e)).toMatch(what); } };

async function oneRun() {
  const store = new PgStore(db());
  const now = new Date("2026-10-26T14:00:00Z");
  const offerId = await setupOffer(store, { slug: "acme", zone: "America/Denver", content: { "c.m1": { channel: "sms", body: "Hi" } } });
  const def = flow("w", [{ id: "t1", type: "trigger@1", title: "Start", on: { event: "appointment.booked" } }, { id: "w1", type: "wait@1", title: "Wait", for: "1h" }, { id: "m1", type: "message@1", title: "Text", to: { contact: "sms" }, content: "c.m1", kind: "transactional" }, { id: "x1", type: "end@1", title: "End", reason: "done" }], chain("t1", "w1", "m1", "x1"), { sendWindow: { zone: "contact", opens: "08:00", closes: "20:00", outside: "earlier_same_day", transactional: "any_hour" } });
  await install(store, offerId, def, { now, delivery: "live", crmWrites: "real" });
  const fp = new FakePorts(() => now);
  fp.contacts.set("c1", { id: "c1", phone: "+15550101001", email: null, dnd: {} });
  const engine = new Engine({ store, ports: fp.ports(), now: () => now });
  await engine.ingest({ offerId, type: "appointment.booked", source: "t", dedupeKey: "e1", contactId: "c1", payload: {} });
  const run = (await store.tx((tx) => tx.runs({ offerId })))[0]!;
  const step = (await store.tx((tx) => tx.steps(run.id)))[0]!;
  return { store, offerId, run, step, engine, fp };
}

describe.skipIf(!process.env.DATABASE_URL)("the database's own rules", () => {
  beforeEach(freshEngineDb);
  afterAll(async () => { await closeDb(); });

  it("refuses an outbox row without the run and the step that asked for it", async () => {
    const { offerId, run, step } = await oneRun();
    const row = (runId: string, stepId: string) => `insert into outbox (offer_id, run_id, step_id, node, kind, effect, idempotency_key, payload, created_at) values ('${offerId}', ${runId}, ${stepId}, 'm1', 'message.sms', 'contact', 'k-${Math.random()}', '{}', now())`;
    await refused(row("null", String(step.id)), /run_id/);
    await refused(row(`'${run.id}'`, "null"), /step_id/);
    await refused(row(`'${run.id}'`, "999999"), /outbox_step_of_run/);
    await expect(q(row(`'${run.id}'`, String(step.id)))).resolves.toBeDefined();
  });
  it("refuses an outbox row naming a step of another run", async () => {
    const a = await oneRun();
    await a.engine.ingest({ offerId: a.offerId, type: "appointment.booked", source: "t", dedupeKey: "e2", contactId: "c2", payload: {} });
    const other = (await a.store.tx((tx) => tx.runs({ offerId: a.offerId }))).find((r) => r.id !== a.run.id)!;
    await refused(`insert into outbox (offer_id, run_id, step_id, node, kind, effect, idempotency_key, payload, created_at) values ('${a.offerId}', '${other.id}', ${a.step.id}, 'm1', 'message.sms', 'contact', 'k1', '{}', now())`, /outbox_step_of_run/);
  });
  it("refuses a second outbox row with the same idempotency key", async () => {
    const { offerId, run, step } = await oneRun();
    const row = `insert into outbox (offer_id, run_id, step_id, node, kind, effect, idempotency_key, payload, created_at) values ('${offerId}', '${run.id}', ${step.id}, 'm1', 'message.sms', 'contact', 'same', '{}', now())`;
    await q(row);
    await refused(row, /idempotency_key/);
  });
  it("refuses a status or an effect that is not one of the known ones", async () => {
    const { offerId, run, step } = await oneRun();
    await refused(`insert into outbox (offer_id, run_id, step_id, node, kind, effect, idempotency_key, payload, status, created_at) values ('${offerId}', '${run.id}', ${step.id}, 'm1', 'message.sms', 'contact', 'k2', '{}', 'maybe', now())`, /outbox_status/);
    await refused(`update runs set status = 'sleeping' where id = '${run.id}'`, /runs_status/);
    await refused(`update workflows set delivery = 'loud'`, /workflows_delivery/);
  });
  it("never changes or removes a fact", async () => {
    await oneRun();
    await refused(`update events set type = 'x'`, /never changed or removed/);
    await refused(`delete from events`, /never changed or removed/);
  });
  it("never changes or removes a saved workflow version", async () => {
    await oneRun();
    await refused(`update workflow_versions set definition = '{}'`, /never changed or removed/);
    await refused(`delete from workflow_versions`, /never changed or removed/);
  });
  it("refuses a second run with the same reentry key in one workflow", async () => {
    const { run } = await oneRun();
    await refused(`insert into runs (offer_id, workflow_id, version_id, trigger_node, status, current_node, context, reentry_key, reentry_base, started_at, updated_at) select offer_id, workflow_id, version_id, trigger_node, 'active', current_node, context, reentry_key, reentry_base, now(), now() from runs where id = '${run.id}'`, /runs_workflow_reentry/);
  });
  it("refuses the same fact twice for an offer", async () => {
    const { offerId } = await oneRun();
    await refused(`insert into events (offer_id, type, occurred_at, source, dedupe_key, payload) values ('${offerId}', 'appointment.booked', now(), 't', 'e1', '{}')`, /events_offer_dedupe/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("the job runner (graphile-worker)", () => {
  beforeEach(async () => { await freshEngineDb(); await migrateJobs(pgPool()); await db().execute(sql`delete from graphile_worker._private_jobs`); });
  afterAll(async () => { await closeDb(); });

  it("writes a timer as a job with the run's exact wake time, in the same transaction, and a due job does the work", async () => {
    const store = new PgStore(db(), "graphile");
    const start = new Date(Date.now() - 60_000);
    const offerId = await setupOffer(store, { slug: "acme", zone: "America/Denver", content: { "c.m1": { channel: "sms", body: "Hi" } } });
    const def = flow("w", [{ id: "t1", type: "trigger@1", title: "Start", on: { event: "appointment.booked" } }, { id: "m1", type: "message@1", title: "Text", to: { contact: "sms" }, content: "c.m1", kind: "transactional" }, { id: "w1", type: "wait@1", title: "Wait", for: "3h" }, { id: "x1", type: "end@1", title: "End", reason: "done" }], chain("t1", "m1", "w1", "x1"), { sendWindow: { zone: "contact", opens: "00:00", closes: "23:59", outside: "next_open", transactional: "any_hour" } });
    await install(store, offerId, def, { now: start, delivery: "live", crmWrites: "real" });
    const fp = new FakePorts();
    fp.contacts.set("c1", { id: "c1", phone: "+15550101001", email: null, dnd: {} });
    const engine = new Engine({ store, ports: fp.ports() });
    await engine.ingest({ offerId, type: "appointment.booked", source: "t", dedupeKey: "e1", contactId: "c1", payload: {} });
    const jobs = async () => (await db().execute(sql`select task_identifier as task, key, run_at from graphile_worker.jobs order by id`)).rows as { task: string; key: string; run_at: Date }[];
    expect((await jobs()).map((j) => j.task)).toEqual(["dispatch"]);
    await runJobsOnce({ pgPool: pgPool(), engine });
    expect(fp.effects("messaging")).toHaveLength(1);
    const run = (await store.tx((tx) => tx.runs({ offerId })))[0]!;
    expect(run.status).toBe("waiting");
    const wake = (await jobs()).find((j) => j.key === `run:${run.id}`)!;
    expect(wake.task).toBe("wake_run");
    expect(new Date(wake.run_at).getTime()).toBe(run.nextWakeAt!.getTime());
  });
});
