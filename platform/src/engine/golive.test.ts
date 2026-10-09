/** Go live (D51): refused while readiness has a blocker; otherwise every shadow-born run and what it wrote is cleared and the company is live. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { dispatchEvent, emitEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { goLive } from "@/engine/golive";
import { fakeAdapters } from "@/engine/test-install";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string;
const fake = fakeAdapters();

describe.skipIf(!process.env.DATABASE_URL)("go live", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='golive'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["sends", "runs", "events", "pipeline_cards", "opportunities", "contact_identifiers", "contacts", "slack_connections", "workflow_triggers", "workflows", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
    });
    companyId = (await installCompany({ name: "Go live", slug: "golive", timezone: "America/Phoenix", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: ["new-lead"], crm: { pipeline_setter: "P", stage_setter_new_lead: "S", field_opportunity_stage_entered: "F" }, enable: true }, fake)).companyId;
  });

  it("refuses while a blocker stands, then clears shadow-born runs and goes live", async () => {
    const ct = await asOperator(async (c) => { const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GL1','Sh') returning id", [companyId]))!.id; await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone','+16025550009')", [companyId, id]); return id; });
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: {} }), { contact: { id: ct } }));
    await tick(fake, undefined, companyId);
    const born = await asOperator((c) => one<{ born_in: string; n: string }>(c, "select born_in, (select count(*)::text from run_steps s where s.run_id=r.id) as n from runs r where company_id=$1", [companyId]));
    expect(born?.born_in).toBe("shadow"); expect(Number(born?.n)).toBeGreaterThan(0);
    // no Slack connection: a blocker
    const refused = await asOperator((c) => goLive(c, companyId, "/c/golive", "test"));
    expect(refused.ok).toBe(false); if (!refused.ok) expect(refused.blockers.map((b) => b.text).join(" ")).toMatch(/Slack is not connected/);
    expect((await asOperator((c) => one<{ mode: string }>(c, "select mode from companies where id=$1", [companyId])))?.mode).toBe("shadow");
    await asOperator((c) => c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id) values ($1,'T1',$2,'U1')", [companyId, Buffer.from("x")]));
    const live = await asOperator((c) => goLive(c, companyId, "/c/golive", "test"));
    expect(live.ok).toBe(true); if (live.ok) { expect(live.cleared.runs).toBe(1); expect(live.cleared.steps).toBeGreaterThan(0); }
    expect((await asOperator((c) => one<{ mode: string }>(c, "select mode from companies where id=$1", [companyId])))?.mode).toBe("live");
    expect((await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from runs where company_id=$1", [companyId])))?.n).toBe("0");
    expect((await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from events where company_id=$1 and run_id is not null", [companyId])))?.n).toBe("0");
    // a run started live is live-born and would survive the next switch
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: {} }), { contact: { id: ct } }));
    expect((await asOperator((c) => one<{ born_in: string }>(c, "select born_in from runs where company_id=$1 order by started_at desc limit 1", [companyId])))?.born_in).toBe("live");
  });
});
