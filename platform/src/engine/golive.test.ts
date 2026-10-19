/** Go live (D51): refused while readiness has a blocker; otherwise every shadow-born run and what it wrote is cleared and the company is live. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { dispatchEvent, emitEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { clearStrayHarnessBookings, setCompanyMode } from "@/engine/golive";
import { fakeAdapters, freshGhlCheckForTest } from "@/engine/test-install";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string;
const fake = fakeAdapters();

describe.skipIf(!process.env.DATABASE_URL)("go live", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='golive'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["sends", "runs", "events", "pipeline_cards", "opportunities", "appointments", "contact_identifiers", "contacts", "slack_connections", "workflow_triggers", "workflows", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
    });
    companyId = (await installCompany({ name: "Go live", slug: "golive", timezone: "America/Phoenix", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: ["new-lead"], crm: { pipeline_setter: "P", stage_setter_new_lead: "S", field_opportunity_stage_entered: "F" }, enable: true }, fake)).companyId;
  });

  it("refuses while a blocker stands, then clears shadow-born runs and goes live", async () => {
    const ct = await asOperator(async (c) => { const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GL1','Sh') returning id", [companyId]))!.id; await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone','+16025550009')", [companyId, id]); return id; });
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: {} }), { contact: { id: ct } }));
    await tick(fake, undefined, companyId);
    const born = await asOperator((c) => one<{ born_in: string; n: string }>(c, "select born_in, (select count(*)::text from run_steps s where s.run_id=r.id) as n from runs r where company_id=$1", [companyId]));
    expect(born?.born_in).toBe("ghost"); expect(Number(born?.n)).toBeGreaterThan(0);
    // no Slack connection: a blocker
    const refused = await asOperator((c) => setCompanyMode(c, companyId, "live", "/c/golive", "test"));
    expect(refused.ok).toBe(false); if (!refused.ok) expect(refused.blockers.map((b) => b.text).join(" ")).toMatch(/Slack is not connected/);
    expect((await asOperator((c) => one<{ mode: string }>(c, "select mode from companies where id=$1", [companyId])))?.mode).toBe("ghost");
    await asOperator((c) => c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id) values ($1,'T1',$2,'U1')", [companyId, Buffer.from("x")]));
    // a synthetic booking from the test harness is rehearsal too
    const term = await asOperator((c) => one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' limit 1", [companyId]));
    await asOperator((c) => c.query("insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status) values ($1,$2,'test','test-1',$3,now(),now()+interval '45 minutes',now(),'confirmed')", [companyId, ct, term!.id]));
    const live = await asOperator(async (c) => { await freshGhlCheckForTest(c, companyId); return setCompanyMode(c, companyId, "live", "/c/golive", "test"); });
    expect(live.ok).toBe(true); if (live.ok) { expect(live.cleared!.runs).toBe(1); expect(live.cleared!.steps).toBeGreaterThan(0); expect(live.cleared!.appointments).toBe(1); }
    expect((await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from appointments where company_id=$1 and source='test'", [companyId])))?.n).toBe("0");
    expect((await asOperator((c) => one<{ mode: string }>(c, "select mode from companies where id=$1", [companyId])))?.mode).toBe("live");
    expect((await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from runs where company_id=$1", [companyId])))?.n).toBe("0");
    expect((await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from events where company_id=$1 and run_id is not null", [companyId])))?.n).toBe("0");
    // a run started live is live-born and would survive the next switch
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: {} }), { contact: { id: ct } }));
    expect((await asOperator((c) => one<{ born_in: string }>(c, "select born_in from runs where company_id=$1 order by started_at desc limit 1", [companyId])))?.born_in).toBe("live");
  });

  it("D97: a test-harness booking on a real person goes, with the rehearsal runs about it; a test contact's stays; a dry run only counts and names", async () => {
    const mk = (ghl: string, name: string, tags: string[]) => asOperator(async (c) => (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, tags) values ($1,$2,$3,$4) returning id", [companyId, ghl, name, tags]))!.id);
    const real = await mk("ST1", "Calvin", []), mine = await mk("ST2", "Tyler", ["sys-test"]);
    const term = await asOperator((c) => one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' limit 1", [companyId]));
    const book = (ct: string, ext: string) => asOperator(async (c) => (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status) values ($1,$2,'test',$3,$4,now(),now()+interval '45 minutes',now(),'confirmed') returning id", [companyId, ct, ext, term!.id]))!.id);
    const stray = await book(real, "test-st1"), kept = await book(mine, "test-st2");
    const wf = await asOperator((c) => one<{ id: string }>(c, "select id from workflows where company_id=$1 limit 1", [companyId]));
    const run = await asOperator(async (c) => (await one<{ id: string }>(c, "insert into runs (company_id, workflow_id, workflow_version, contact_id, appointment_id, status, born_in, context, reentry_key) values ($1,$2,1,$3,$4,'completed','test','{}','stray-test') returning id", [companyId, wf!.id, real, stray]))!.id);
    await asOperator((c) => emitEvent(c, { company_id: companyId, contact_id: real, opportunity_id: null, appointment_id: stray, event_type: "appointment.booked", source: "test", data: { simulated: true } }));
    expect(await asOperator((c) => clearStrayHarnessBookings(c, companyId, true))).toMatchObject({ appointments: 1, runs: 0, people: ["Calvin"] });
    expect(await asOperator((c) => one(c, "select 1 from appointments where id=$1", [stray]))).toBeTruthy();   // a dry run deletes nothing
    expect(await asOperator((c) => clearStrayHarnessBookings(c, companyId))).toMatchObject({ appointments: 1, runs: 1, people: ["Calvin"] });
    expect(await asOperator((c) => one(c, "select 1 from appointments where id=$1", [stray]))).toBeUndefined();
    expect(await asOperator((c) => one(c, "select 1 from runs where id=$1", [run]))).toBeUndefined();
    expect(await asOperator((c) => one(c, "select 1 from events where appointment_id=$1", [stray]))).toBeUndefined();
    expect(await asOperator((c) => one(c, "select 1 from appointments where id=$1", [kept]))).toBeTruthy();   // the team's own rehearsal stays
    expect(await asOperator((c) => one(c, "select 1 from audit_log where company_id=$1 and action='harness.stray_cleared'", [companyId]))).toBeTruthy();
  });
});
