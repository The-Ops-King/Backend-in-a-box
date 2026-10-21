/** Voiding a staged booking left over from a rehearsal: off the end-of-day form and the numbers, no workflow started, a real booking refused. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { voidStagedBookings } from "./simulate";

const SLUG = "void-staged";
let co = "", staged = "", real = "", ct = "";
const wipe = () => asOperator(async (c) => {
  const old = await one<{ id: string }>(c, "select id from companies where slug=$1", [SLUG]); if (!old) return;
  for (const t of ["runs", "events", "workflows", "appointments", "contacts", "company_terms", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [old.id]);
  await c.query("delete from companies where id=$1", [old.id]);
});

describe.skipIf(!process.env.DATABASE_URL)("voiding staged bookings", () => {
  beforeAll(async () => {
    await migrate(); await wipe();
    await asOperator(async (c) => {
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('Void', $1, 'UTC') returning id", [SLUG]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [co]);
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' limit 1", [co]))!.id;
      ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GV1','Tyler') returning id", [co]))!.id;
      const appt = (src: string, ext: string) => one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status) values ($1,$2,$3,$4,$5,now() - interval '1 hour',now(),now() - interval '1 day','confirmed') returning id", [co, ct, src, ext, term]);
      staged = (await appt("test", "test-v1"))!.id; real = (await appt("calendly", "cal-v1"))!.id;
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Pre-call','always',true) returning id", [co]))!.id;
      await c.query("insert into runs (company_id, workflow_id, workflow_version, contact_id, appointment_id, status, current_node, next_run_at, context, reentry_key) values ($1,$2,1,$3,$4,'waiting','w1',now() + interval '1 hour','{}','void-test')", [co, wf, ct, staged]);
    });
  });
  afterAll(wipe);

  it("voids the staged one silently and ends its runs; refuses a real booking; a dry run changes nothing", async () => {
    const dry = await asOperator((c) => voidStagedBookings(c, co, [staged, real], "test", true));
    expect(dry.voided.map((v) => v.id)).toEqual([staged]);
    expect(dry.refused).toEqual([{ id: real, why: "a real calendly booking: only staged (test) bookings can be voided here" }]);
    expect(await asOperator((c) => one(c, "select status from appointments where id=$1", [staged]))).toEqual({ status: "confirmed" });
    const r = await asOperator((c) => voidStagedBookings(c, co, [staged, real], "test"));
    expect(r.runsEnded).toBe(1);
    expect(await asOperator((c) => many(c, "select id, status from appointments where company_id=$1 order by source desc", [co]))).toEqual([{ id: staged, status: "invalid" }, { id: real, status: "confirmed" }]);
    expect(await asOperator((c) => many(c, "select 1 from events where company_id=$1", [co]))).toEqual([]);   // no event, so no workflow
    expect(await asOperator((c) => one(c, "select status, exit_reason from runs where appointment_id=$1", [staged]))).toEqual({ status: "exited", exit_reason: "staged booking voided" });
    expect((await asOperator((c) => voidStagedBookings(c, co, [staged], "test"))).refused).toEqual([{ id: staged, why: "already void" }]);
  });
});
