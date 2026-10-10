/**
 * D73: the ledger is GHL's mirror, and the hourly sweep mends it. A contact GHL added that the ledger lacks is pulled in
 * (New lead once); one GHL says is gone is marked gone; a Sales Call the booking source cancelled before its start is set to
 * cancelled in GHL (test mode: only a test contact's record is written; once, through the effects ledger) and in the ledger;
 * otherwise GHL's filed outcome replaces the ledger's. What cannot be repaired is one alert, resolved when nothing is left.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { loadCompany } from "@/engine/context";
import { runHealthStep, type Finding, type HealthProbes } from "@/engine/health";
import { openAlerts } from "@/engine/alerts";
import { fakeAdapters, fakeProbes, installTemplateForTest } from "@/engine/test-install";
import type { Adapters, ContactSnapshot } from "@/adapters/types";
import type { GhlObjectRecord, GhlReads } from "@/adapters/ghl/metrics";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";
const NOW = DateTime.now();
const ago = (o: Record<string, number>) => NOW.minus(o);

// GHL as the sweep reads it
const contacts: ContactSnapshot[] = [];
const gone = new Set<string>(), flaky = new Set<string>();
const records: GhlObjectRecord[] = [];
let ghlDown = false;
const gc = (id: string, added: DateTime, o: Partial<ContactSnapshot> = {}): ContactSnapshot => ({ id, firstName: id, tags: [], customFields: {}, dateAdded: added.toUTC().toISO()!, dateUpdated: added.toUTC().toISO()!, ...o });
const reads: GhlReads = {
  contactsAdded: async (_c, from, to) => { if (ghlDown) throw Object.assign(new Error("GHL 503 on /contacts/search"), { status: 503 }); return contacts.filter((k) => { const t = Date.parse(k.dateAdded); return t >= from.getTime() && t <= to.getTime(); }); },
  wonCards: async () => [],
  objectRecords: async () => records,
  getContact: async (_c, id) => { if (flaky.has(id)) throw Object.assign(new Error("GHL 503 on /contacts"), { status: 503 }); return gone.has(id) ? null : contacts.find((k) => k.id === id) ?? gc(id, ago({ days: 30 })); },
};
const probes: HealthProbes = { ...fakeProbes, ghl: reads };
const writes: { id: string; outcome: unknown }[] = [];
let refuse = false;
const base = fakeAdapters();
const fake: Adapters = { ...base, write: { ...base.write, updateRecord: async (_c, _key, id, props) => {
  if (refuse) throw Object.assign(new Error("GHL 422 on /objects: bad value"), { status: 422 });
  writes.push({ id, outcome: props.outcome }); const r = records.find((x) => x.id === id); if (r) r.properties.outcome = props.outcome; } } };

let companyId: string, runId: string;
const sc = (id: string, ext: string, contact: string, at: DateTime, outcome: string): GhlObjectRecord => ({ id, createdAt: ago({ days: 9 }).toISO()!, properties: { external_id: ext, contact_id: contact, scheduled_at: at.toUTC().toISO(), outcome, closer: "Cara Closer" } });
const sweep = (opts: { run?: boolean } = {}) => asOperator(async (c) => { const { row } = await loadCompany(c, companyId); return runHealthStep(c, row, fake, probes, { checks: {}, min_slots: 0, slots_days: 7, run_id: opts.run === false ? undefined : runId }); });
const drift = (fs: Finding[]) => fs.filter((f) => f.check === "ledger_drift");
const outcomeOf = (ext: string) => asOperator(async (c) => (await one<{ category: string | null }>(c, "select t.category from appointments a left join company_terms t on t.id=a.outcome_term where a.company_id=$1 and a.external_id=$2", [companyId, ext]))?.category ?? null);

describe.skipIf(!process.env.DATABASE_URL)("health: the ledger follows GHL (D73)", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='drift'");
      if (co) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["step_effects", "sends", "poll_cursors", "messages", "crm_records", "opportunities", "runs", "workflow_triggers", "workflows", "alerts", "health_checks", "audit_log", "events", "appointments", "calendars", "contact_identifiers", "contacts", "users", "company_terms", "bindings"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]);
      }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode) values ('Drift Co','drift',$1,'test') returning id", [TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      for (const [k, kind, v] of [["crm.location_id", "id", "LOC-DRIFT"], ["secret.ghl_pit", "secret", "pit"], ["crm.object_sales_call", "id", "custom_objects.sales_call"], ["test.domains", "text", "test.co"],
        ["sales_call.outcomes", "text", JSON.stringify({ showed: "showed", no_show: "noshow", cancelled: "cancelled", late_cancel: "cancelled" })]])
        await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4)", [companyId, k, kind, kind === "secret" ? encrypt(v) : Buffer.from(v)]);
      const wf = await installTemplateForTest(c, companyId, "health-check", { enabled: false });
      runId = (await one<{ id: string }>(c, "insert into runs (company_id, workflow_id, workflow_version, reentry_key) values ($1,$2,1,'drift-sweep') returning id", [companyId, wf]))!.id;
      const closing = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      const term = async (cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_outcome' and category=$2", [companyId, cat]))!.id;
      const contact = async (ghl: string, added: DateTime, tags: string[] = []) => (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, ghl_added_at, tags) values ($1,$2,$2,$3,$4) returning id", [companyId, ghl, added.toJSDate(), tags]))!.id;
      const appt = (ext: string, ct: string, starts: DateTime, status: string, updated: DateTime | null, outcome: string | null, source = "calendly") =>
        c.query("insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status, source_updated_at, outcome_term) values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10)",
          [companyId, ct, source, ext, closing, starts.toJSDate(), ago({ days: 8 }).toJSDate(), status, updated?.toJSDate() ?? null, outcome]);
      const k1 = await contact("G-K1", ago({ days: 3 })), k2 = await contact("G-K2", ago({ days: 3 })), t1 = await contact("G-TEST", ago({ days: 3 }), ["sys-test"]);
      await contact("G-GONE", ago({ days: 2 })); await contact("G-FLAKY", ago({ days: 2 }));
      const noshow = await term("noshow");
      await appt("AP1", k1, ago({ days: 3 }).startOf("minute"), "cancelled", ago({ days: 5 }), noshow);   // cancelled two days before; the closer filed no-show anyway
      await appt("AP2", t1, ago({ days: 2 }).startOf("minute"), "cancelled", ago({ days: 4 }), null);
      await appt("AP3", k2, ago({ days: 2 }).startOf("minute"), "confirmed", null, noshow);                 // the ledger says no-show; GHL says showed
      await appt("AP4", k2, ago({ days: 1 }).startOf("minute"), "cancelled", ago({ hours: 20 }), null);     // the host cleared the slot after the call
      await appt("AP6", k1, ago({ days: 1, hours: 2 }).startOf("minute"), "cancelled", null, null);        // cancelled, when unknown
    });
    contacts.push(gc("G-K1", ago({ days: 3 })), gc("G-K2", ago({ days: 3 })), gc("G-TEST", ago({ days: 3 }), { tags: ["sys-test"] }),
      gc("G-NEW", ago({ days: 1 }), { firstName: "Nina", lastName: "New", email: "nina@x.co" }),   // the poll never brought her in, and a day has passed
      gc("G-SOON", ago({ minutes: 45 }), { firstName: "Sol", lastName: "Soon", email: "sol@x.co" }),  // missed by one poll: still a fresh lead
      gc("G-RECENT", ago({ minutes: 10 })));                                                       // inside the poll's lag: not yet a difference
    gone.add("G-GONE"); flaky.add("G-FLAKY");
    records.push(
      sc("R1", "INV-1", "G-K1", ago({ days: 3 }).startOf("minute"), "no_show"),   // an outside integration's id: matched by person and minute
      sc("R2", "INV-2", "G-TEST", ago({ days: 2 }).startOf("minute"), "no_show"),
      sc("R3", "AP3", "G-K2", ago({ days: 2 }).startOf("minute"), "showed"),
      sc("R4", "INV-4", "G-K2", ago({ days: 1 }).startOf("minute"), "no_show"),
      sc("R5", "INV-5", "G-K1", ago({ days: 4 }).startOf("minute"), "showed"),    // no booking at that minute
      sc("R6", "INV-6", "G-K1", ago({ days: 1, hours: 2 }).startOf("minute"), "no_show"));
  });

  it("repairs what it can, logs every repair, and alerts once on what it cannot", async () => {
    const r = await sweep();
    const fs = drift(r.findings);
    const repaired = fs.filter((f) => f.ok).map((f) => f.item).sort();
    expect(repaired).toEqual(["repair:G-GONE", "repair:G-SOON", "repair:R1:ledger", "repair:R2:ghl", "repair:R2:ledger", "repair:R3:ledger", "repair:R4:ledger"]);
    // the test contact's record is written to GHL; the real contact's is held back by test mode
    expect(writes).toEqual([{ id: "R2", outcome: "cancelled" }]);
    expect(await outcomeOf("AP1")).toBe("cancelled"); expect(await outcomeOf("AP2")).toBe("cancelled");
    expect(await outcomeOf("AP3")).toBe("showed");    // GHL wins
    expect(await outcomeOf("AP4")).toBe("noshow");    // cancelled after the call: the filed no-show stands, and the ledger follows it
    expect(await outcomeOf("AP6")).toBeNull();
    const nina = await asOperator((c) => one<{ id: string; first_name: string }>(c, "select id, first_name from contacts where company_id=$1 and ghl_contact_id='G-NEW'", [companyId]));
    expect(nina?.first_name).toBe("Nina");
    // a day late: in the ledger, but no lead workflows; a person is told. 45 minutes late: a lead like any other
    expect(await asOperator((c) => one<{ n: number }>(c, "select count(*)::int as n from events where company_id=$1 and contact_id=$2 and event_type='lead.created'", [companyId, nina!.id]))).toEqual({ n: 0 });
    expect(await asOperator((c) => one<{ n: number }>(c, "select count(*)::int as n from events e join contacts ct on ct.id=e.contact_id where e.company_id=$1 and ct.ghl_contact_id='G-SOON' and e.event_type='lead.created'", [companyId]))).toEqual({ n: 1 });
    expect(await asOperator((c) => one(c, "select 1 from contacts where company_id=$1 and ghl_contact_id='G-RECENT'", [companyId]))).toBeUndefined();
    expect((await asOperator((c) => one<{ gone_at: Date | null }>(c, "select gone_at from contacts where company_id=$1 and ghl_contact_id='G-GONE'", [companyId])))?.gone_at).toBeTruthy();
    expect((await asOperator((c) => one<{ gone_at: Date | null }>(c, "select gone_at from contacts where company_id=$1 and ghl_contact_id='G-FLAKY'", [companyId])))?.gone_at).toBeNull();   // GHL did not answer: unconfirmed, untouched, unsaid
    const audit = await asOperator((c) => many<{ target_id: string; after: { repair: string } }>(c, "select target_id, after from audit_log where company_id=$1 and action='health.repaired'", [companyId]));
    expect(audit.map((a) => a.after.repair).sort()).toEqual(["booking_cancelled", "booking_cancelled", "booking_cancelled", "ghl_outcome", "ghl_outcome", "marked_gone", "pulled_in", "pulled_in"]);
    const bad = fs.find((f) => !f.ok)!;
    expect(bad.text).toMatch(/^GHL and the ledger disagree \(last 7 days\), not repaired: /);
    expect(bad.text).toContain("G-K1's call on"); expect(bad.text).toContain("not written to GHL: test mode: would set the outcome to \"cancelled\"");
    expect(bad.text).toContain("the Sales Call record matches no booking in the ledger");
    expect(bad.text).toMatch(/Nina New arrived in GHL .* New lead and Speed to lead did NOT run, so follow up by hand/);
    expect(bad.text).toContain("Calendly says cancelled, GHL says no-show, and when it was cancelled is unknown");
    expect(bad.text).not.toContain("G-FLAKY");
    expect((await asOperator((c) => openAlerts(c, companyId))).filter((a) => a.key === "health:ledger_drift")).toHaveLength(1);
    expect(await asOperator((c) => one<{ done: boolean }>(c, "select done_at is not null as done from step_effects where company_id=$1 and node_id='repair:R2:outcome'", [companyId]))).toEqual({ done: true });
  });

  it("the next sweep finds the repairs holding and repeats nothing; once the rest is mended the alert resolves", async () => {
    let r = await sweep();
    expect(drift(r.findings).filter((f) => f.ok)).toEqual([]);   // nothing left to repair, nothing written again
    expect(writes).toHaveLength(1);
    expect(await asOperator((c) => one<{ n: number }>(c, "select count(*)::int as n from events where company_id=$1 and event_type='lead.created'", [companyId]))).toEqual({ n: 1 });
    // live: the real contact's record may now be written; a refusal leaves it for the next sweep, unclaimed
    await asOperator((c) => c.query("update companies set mode='live' where id=$1", [companyId]));
    refuse = true; r = await sweep(); refuse = false;
    expect(drift(r.findings).find((f) => !f.ok)!.text).toContain("not written to GHL: GHL refused it (GHL 422 on /objects: bad value)");
    expect(await asOperator((c) => one(c, "select 1 from step_effects where company_id=$1 and node_id='repair:R1:outcome'", [companyId]))).toBeUndefined();
    records.splice(records.findIndex((x) => x.id === "R5"), 1);
    await asOperator((c) => c.query("update appointments set source_updated_at=starts_at + interval '1 hour' where company_id=$1 and external_id='AP6'", [companyId]));
    r = await sweep();
    expect(writes).toEqual([{ id: "R2", outcome: "cancelled" }, { id: "R1", outcome: "cancelled" }]);
    expect(drift(r.findings).filter((f) => f.ok).map((f) => f.item)).toEqual(["repair:R1:ghl", "repair:R6:ledger"]);   // AP6 cancelled after its start: the filed no-show stands
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    expect((await asOperator((c) => openAlerts(c, companyId))).filter((a) => a.key === "health:ledger_drift")).toHaveLength(0);
    // a GHL record set back after the repair is not written twice: it is left for a person
    records.find((x) => x.id === "R1")!.properties.outcome = "no_show";
    r = await sweep();
    expect(writes).toHaveLength(2);
    expect(drift(r.findings).find((f) => !f.ok)!.text).toContain("it was set once already and GHL says otherwise again");
    records.find((x) => x.id === "R1")!.properties.outcome = "cancelled";
  });

  it("no run, no CRM write; GHL that cannot be read keeps the open alert as it is", async () => {
    records.find((x) => x.id === "R2")!.properties.outcome = "no_show";
    let r = await sweep({ run: false });
    expect(drift(r.findings).find((f) => !f.ok)!.text).toContain("no run to record the write against");
    const before = (await asOperator((c) => openAlerts(c, companyId))).find((a) => a.key === "health:ledger_drift")!;
    ghlDown = true; r = await sweep(); ghlDown = false;
    expect(drift(r.findings)).toEqual([expect.objectContaining({ ok: false, text: before.text })]);
    expect((await asOperator((c) => openAlerts(c, companyId))).find((a) => a.key === "health:ledger_drift")?.id).toBe(before.id);
  });
});
