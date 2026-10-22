/** D221: a fixed-time slot that passed before the workflow was switched on is not caught up; one missed while it was on still is. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { dispatchSchedules } from "./clock";
import { parseDefinition, extractManifest } from "./definition";
import { syncTriggers } from "./install";

const TZ = "America/New_York";
let companyId = "", wf = "";
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }) as DateTime<true>;
const fired = async () => (await asOperator((c) => c.query<{ k: string }>("select reentry_key as k from runs where workflow_id=$1 order by reentry_key", [wf]))).rows.map((r) => r.k.split(":").slice(1, 3).join(":"));

describe.skipIf(!process.env.DATABASE_URL)("D221: switching a scheduled workflow on", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const old = await one<{ id: string }>(c, "select id from companies where slug='d221'");
      if (old) { for (const t of ["run_steps", "runs", "events", "workflow_triggers", "workflow_versions", "workflows", "audit_log"]) await c.query(`delete from ${t} where ${t === "run_steps" ? "run_id in (select id from runs where company_id=$1)" : t === "workflow_versions" ? "workflow_id in (select id from workflows where company_id=$1)" : "company_id=$1"}`, [old.id]); await c.query("delete from companies where id=$1", [old.id]); }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D221','d221',$1) returning id", [TZ]))!.id;
      const nodes = [{ id: "t_morning", type: "trigger", event: "schedule", schedule: { at: "09:00" } }, { id: "t_evening", type: "trigger", event: "schedule", schedule: { at: "18:00" } },
        { id: "t_hourly", type: "trigger", event: "schedule", schedule: { every: "1h" } }, { id: "x1", type: "exit", reason: "done" }];
      const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "none" }, nodes, edges: [{ from: "t_morning", to: "x1" }, { from: "t_evening", to: "x1" }, { from: "t_hourly", to: "x1" }] });
      wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Clock','always',false) returning id", [companyId]))!.id;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'d221')", [wf, def, extractManifest(def)]);
      await syncTriggers(c, companyId, wf, def);
    });
  });

  it("the database stamps when it was switched on, whichever path switched it", async () => {
    expect(await asOperator((c) => one(c, "select enabled_at from workflows where id=$1", [wf]))).toEqual({ enabled_at: null });
    await asOperator((c) => c.query("update workflows set enabled=true where id=$1", [wf]));
    const r = await asOperator((c) => one<{ enabled_at: Date }>(c, "select enabled_at from workflows where id=$1", [wf]));
    expect(Math.abs(r!.enabled_at.getTime() - Date.now())).toBeLessThan(60_000);
    await asOperator((c) => c.query("update workflows set name='Clock' where id=$1", [wf]));   // another change leaves it alone
    expect((await asOperator((c) => one<{ enabled_at: Date }>(c, "select enabled_at from workflows where id=$1", [wf])))!.enabled_at).toEqual(r!.enabled_at);
  });

  it("switched on at 10 PM: the day's 9 AM and 6 PM do not fire; the hourly one starts at once; the next day's slots fire", async () => {
    await asOperator((c) => c.query("update workflows set enabled_at=$2 where id=$1", [wf, at("2026-10-21T22:07").toJSDate()]));
    await asOperator((c) => dispatchSchedules(c, at("2026-10-21T22:08"), companyId));
    expect(await fired()).toEqual([expect.stringMatching(/^t_hourly:/)]);
    await asOperator((c) => dispatchSchedules(c, at("2026-10-22T09:00"), companyId));
    expect((await fired()).filter((k) => !k.startsWith("t_hourly"))).toEqual(["t_morning:2026-10-22"]);
  });

  it("a slot missed while it was on (an outage) still sends late, once", async () => {
    await asOperator((c) => dispatchSchedules(c, at("2026-10-22T23:30"), companyId));   // 6 PM came and went with no tick
    await asOperator((c) => dispatchSchedules(c, at("2026-10-22T23:31"), companyId));
    expect((await fired()).filter((k) => !k.startsWith("t_hourly"))).toEqual(["t_evening:2026-10-22", "t_morning:2026-10-22"]);
  });

  it("switched off and on again in the afternoon: that day's passed morning is not caught up, its evening is", async () => {
    await asOperator((c) => c.query("update workflows set enabled_at=$2 where id=$1", [wf, at("2026-10-23T14:00").toJSDate()]));
    await asOperator((c) => dispatchSchedules(c, at("2026-10-23T18:01"), companyId));
    expect((await fired()).filter((k) => k.includes("2026-10-23"))).toEqual(["t_evening:2026-10-23"]);
  });
});
