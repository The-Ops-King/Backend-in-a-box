/** The mode ladder (D52): in test only sys-test or test-domain contacts start runs and receive sends; a run in flight stops when its contact no longer passes. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { dispatchEvent, emitEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { contactPasses } from "@/engine/mode";
import { fakeAdapters } from "@/engine/test-install";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string;
const fake = fakeAdapters();
const lead = (ct: string) => asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: {} }), { contact: { id: ct } }));
const setMode = (m: string) => asOperator((c) => c.query("update companies set mode=$2 where id=$1", [companyId, m]));
const contact = (ghl: string, email: string | null, tags: string[]) => asOperator(async (c) => {
  const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, tags) values ($1,$2,'T',$3) returning id", [companyId, ghl, tags]))!.id;
  await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone',$3)", [companyId, id, `+1602555${ghl.slice(-4).padStart(4, "0")}`]);
  if (email) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [companyId, id, email]);
  return id;
});

describe.skipIf(!process.env.DATABASE_URL)("mode ladder", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='ladder'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["sends", "runs", "events", "pipeline_cards", "opportunities", "contact_identifiers", "contacts", "slack_connections", "workflow_triggers", "workflows", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
    });
    companyId = (await installCompany({ name: "Ladder", slug: "ladder", timezone: "America/Phoenix", locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, bookingCalendar: "CAL", templates: ["new-lead", "speed-to-lead"], crm: { pipeline_setter: "P", stage_setter_new_lead: "S", field_opportunity_stage_entered: "F" }, testDomains: ["@JTylerRay.com"], enable: true }, fake)).companyId;
  });

  it("the domain binding is stored lower-case without the @", async () => {
    const v = await asOperator((c) => one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='test.domains'", [companyId]));
    expect(v?.value.toString("utf8")).toBe("jtylerray.com");
  });

  it("test: a tagged contact and a test-domain contact start runs; a real one does not", async () => {
    await setMode("test");
    const tagged = await contact("L1", "someone@gmail.com", ["sys-test"]);
    const domain = await contact("L2", "me@jtylerray.com", []);
    const real = await contact("L3", "client@gmail.com", ["stat-new"]);
    expect((await lead(tagged)).length).toBeGreaterThan(0); expect((await lead(domain)).length).toBeGreaterThan(0); expect(await lead(real)).toHaveLength(0);
    await tick(fake, undefined, companyId);
    const runs = await asOperator((c) => many<{ contact_id: string; born_in: string }>(c, "select contact_id, born_in from runs where company_id=$1", [companyId]));
    expect(runs.every((r) => r.born_in === "test")).toBe(true); expect(runs.some((r) => r.contact_id === real)).toBe(false);
    // the second gate: a text to the tagged contact goes (fake sender), a text to a real contact would be suppressed even inside a run
    const sends = await asOperator((c) => many<{ contact_id: string; status: string; suppressed_reason: string | null }>(c, "select contact_id, status, suppressed_reason from sends where company_id=$1 and channel in ('sms','email')", [companyId]));
    expect(sends.filter((s) => s.contact_id === tagged).map((s) => s.status)).toContain("sent");
    // the second gate on its own: the tag comes off mid-run, the next send is suppressed, not delivered
    await asOperator((c) => c.query("update contacts set tags='{}' where id=$1", [tagged]));
    await asOperator((c) => c.query("update runs set next_run_at=now() - interval '1 minute' where company_id=$1 and contact_id=$2 and status='waiting'", [companyId, tagged]));
    await tick(fake, undefined, companyId);
    const after = await asOperator((c) => many<{ status: string; suppressed_reason: string | null; exit_reason: string | null }>(c, "select s.status, s.suppressed_reason, r.exit_reason from runs r left join sends s on s.run_id=r.id where r.company_id=$1 and r.contact_id=$2", [companyId, tagged]));
    expect(after.some((x) => /not a test contact/.test(x.exit_reason ?? "") || /not a test contact/.test(x.suppressed_reason ?? ""))).toBe(true);
  });

  it("test: a run in flight about a contact that stops passing exits at its next step, before any write", async () => {
    const tagged = await contact("L4", "other@gmail.com", ["sys-test"]);
    expect((await lead(tagged)).length).toBeGreaterThan(0);   // started in test, not yet ticked
    await asOperator((c) => c.query("update contacts set tags='{}' where id=$1", [tagged]));   // the tag comes off before the first step
    await tick(fake, undefined, companyId);
    const exited = await asOperator((c) => many<{ exit_reason: string; born_in: string }>(c, "select exit_reason, born_in from runs where company_id=$1 and contact_id=$2", [companyId, tagged]));
    expect(exited.map((r) => r.exit_reason).join(" ")).toMatch(/not a test contact: test mode/); expect(exited[0].born_in).toBe("test");
    expect(await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from run_steps s join runs r on r.id=s.run_id where r.company_id=$1 and r.contact_id=$2 and s.node_type<>'trigger'", [companyId, tagged]))).toMatchObject({ n: "0" });
    expect(await asOperator((c) => contactPasses(c, companyId, tagged, "test", { "test.domains": "jtylerray.com" }))).toMatchObject({ ok: false });
  });

  it("live and shadow: everyone passes", async () => {
    for (const m of ["shadow", "live"] as const) expect(await asOperator((c) => contactPasses(c, companyId, "00000000-0000-0000-0000-000000000000", m, {}))).toEqual({ ok: true });
  });
});
