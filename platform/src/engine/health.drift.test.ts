/**
 * D73: the ledger is GHL's mirror, and the hourly sweep mends it. A contact GHL added that the ledger lacks is pulled in
 * (New lead once); one GHL says is gone is marked gone; a Sales Call the booking source cancelled before its start is set to
 * cancelled in the ledger and, by the Ledger drift workflow, in GHL (test mode: only a test contact's record is written; once ever);
 * otherwise GHL's filed outcome replaces the ledger's. What cannot be repaired is one alert, resolved when nothing is left; its
 * questions are data the Health check workflow words (D88).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { loadCompany } from "@/engine/context";
import { runHealthStep, type Finding, type HealthProbes } from "@/engine/health";
import { announceDue, openAlerts } from "@/engine/alerts";
import { tick } from "@/engine/runner";
import { fakeAdapters, fakeProbes, installTemplateForTest } from "@/engine/test-install";
import type { Adapters, ContactSnapshot } from "@/adapters/types";
import type { GhlObjectRecord, GhlReads, GhlWonCard } from "@/adapters/ghl/metrics";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";
const NOW = DateTime.now();
const ago = (o: Record<string, number>) => NOW.minus(o);

// GHL as the sweep reads it
const contacts: ContactSnapshot[] = [];
const gone = new Set<string>(), flaky = new Set<string>();
const records: GhlObjectRecord[] = [];
const payments: GhlObjectRecord[] = [], won: GhlWonCard[] = [];
let ghlDown = false;
const gc = (id: string, added: DateTime, o: Partial<ContactSnapshot> = {}): ContactSnapshot => ({ id, firstName: id, tags: [], customFields: {}, dateAdded: added.toUTC().toISO()!, dateUpdated: added.toUTC().toISO()!, ...o });
const reads: GhlReads = {
  contactsAdded: async (_c, from, to) => { if (ghlDown) throw Object.assign(new Error("GHL 503 on /contacts/search"), { status: 503 }); return contacts.filter((k) => { const t = Date.parse(k.dateAdded); return t >= from.getTime() && t <= to.getTime(); }); },
  wonCards: async () => won,
  objectRecords: async (_c, key) => (key === "custom_objects.payment" ? payments : records),
  cards: async () => [], pipelines: async () => [], users: async () => [],
  getContact: async (_c, id) => { if (flaky.has(id)) throw Object.assign(new Error("GHL 503 on /contacts"), { status: 503 }); return gone.has(id) ? null : contacts.find((k) => k.id === id) ?? gc(id, ago({ days: 30 })); },
  recordContact: async (_c, id) => (id === "S-LINKED" ? "C3" : null),
  fieldCatalog: async () => [],
};
const probes: HealthProbes = { ...fakeProbes, ghl: reads };
const writes: { id: string; outcome: unknown }[] = [];
let refuse = false;
const base = fakeAdapters();
const linkWrites: { id: string; props: Record<string, unknown> }[] = [], relations: string[] = [];
const posts: { channel: string; text: string }[] = [];
const fake: Adapters = { ...base, notifier: { ...base.notifier, post: async (_t, channel, text) => { posts.push({ channel, text }); return { ts: `ts${posts.length}` }; } }, write: { ...base.write, relateRecords: async (_c, a, f, t) => { relations.push(`${a}:${f}>${t}`); }, updateRecord: async (_c, _key, id, props) => {
  if (!("outcome" in props)) { linkWrites.push({ id, props }); const r = records.find((x) => x.id === id); if (r) Object.assign(r.properties, props); return; }
  if (refuse) throw Object.assign(new Error("GHL 422 on /objects: bad value"), { status: 422 });
  writes.push({ id, outcome: props.outcome }); const r = records.find((x) => x.id === id); if (r) r.properties.outcome = props.outcome; } } };

let companyId: string, runId: string;
const sc = (id: string, ext: string, contact: string, at: DateTime, outcome: string): GhlObjectRecord => ({ id, createdAt: ago({ days: 9 }).toISO()!, properties: { external_id: ext, contact_id: contact, scheduled_at: at.toUTC().toISO(), outcome, closer: "Cara Closer" } });
const sweep = (opts: { run?: boolean } = {}) => asOperator(async (c) => { const { row } = await loadCompany(c, companyId); return runHealthStep(c, row, fake, probes, { checks: {}, min_slots: 0, slots_days: 7, run_id: opts.run === false ? undefined : runId }); });
const drift = (fs: Finding[]) => fs.filter((f) => f.check === "ledger_drift");
/** D88: the Ledger drift workflow makes the GHL writes the sweep hands it, on the next tick. */
const run = () => tick(fake, undefined, companyId, probes);
type Q = { kind: string; label?: string; name?: string };
const asked = (fs: Finding[]) => ((drift(fs).find((f) => !f.ok)?.detail as { items?: Q[] } | undefined)?.items ?? []);
/** D88: the questions as Health check words them: the open drift alert said afresh, its post's text. */
const worded = async () => {
  await asOperator((c) => c.query("update alerts set announced_at=null, announce_count=0 where company_id=$1 and key='health:ledger_drift' and resolved_at is null", [companyId]));
  const n = posts.length; await asOperator((c) => announceDue(c, fake, new Date(), companyId)); await run();
  return posts.slice(n).find((p) => /^\S+ \*Drift Co · Health check\*\n/.test(p.text) && /(didn't|doesn't|don't) match GHL/.test(p.text))?.text ?? "";
};
const outcomeOf = (ext: string) => asOperator(async (c) => (await one<{ category: string | null }>(c, "select t.category from appointments a left join company_terms t on t.id=a.outcome_term where a.company_id=$1 and a.external_id=$2", [companyId, ext]))?.category ?? null);

describe.skipIf(!process.env.DATABASE_URL)("health: the ledger follows GHL (D73)", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='drift'");
      if (co) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["step_effects", "slack_posts", "slack_connections", "sends", "poll_cursors", "messages", "crm_records", "pipeline_cards", "opportunities", "runs", "workflow_triggers", "workflows", "alerts", "health_checks", "audit_log", "events", "appointments", "calendars", "contact_identifiers", "contacts", "users", "company_terms", "bindings"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]);
      }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode) values ('Drift Co','drift',$1,'test') returning id", [TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      for (const [k, kind, v] of [["crm.location_id", "id", "LOC-DRIFT"], ["secret.ghl_pit", "secret", "pit"], ["crm.object_sales_call", "id", "custom_objects.sales_call"], ["test.domains", "text", "test.co"],
        ["sales_call.outcomes", "text", JSON.stringify({ showed: "showed", no_show: "noshow", cancelled: "cancelled", late_cancel: "cancelled" })]])
        await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4)", [companyId, k, kind, kind === "secret" ? encrypt(v) : Buffer.from(v)]);
      const wf = await installTemplateForTest(c, companyId, "health-check");   // D88: it words the alerts
      await installTemplateForTest(c, companyId, "ledger-drift");   // D88: it makes the GHL writes
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'alerts.slack_channel','channel',$2)", [companyId, Buffer.from("CALERTS")]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
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
      await appt("AP7", k2, ago({ days: 3 }).startOf("minute"), "confirmed", null, noshow);                 // GHL's record names its time only as display text
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
      sc("R6", "INV-6", "G-K1", ago({ days: 1, hours: 2 }).startOf("minute"), "no_show"),
      { ...sc("R7", "INV-7", "G-K2", ago({ days: 3 }).startOf("minute"), "showed"), properties: { external_id: "INV-7", contact_id: "G-K2", outcome: "showed", closer: "Cara Closer", scheduled_at: `${ago({ days: 3 }).setZone(TZ).toFormat("ccc LLL d")} · ${ago({ days: 3 }).setZone(TZ).toFormat("h:mm a ZZZZ")}`, call_date: ago({ days: 3 }).setZone(TZ).toISODate() } });   // the display text an outside integration writes
  });

  it("repairs what it can, logs every repair, and alerts once on what it cannot", async () => {
    const r = await sweep();
    const fs = drift(r.findings);
    const repaired = fs.filter((f) => f.ok).map((f) => f.item).sort();
    expect(repaired).toEqual(["repair:G-GONE", "repair:G-NEW", "repair:G-SOON", "repair:R1:ledger", "repair:R2:ghl", "repair:R2:ledger", "repair:R3:ledger", "repair:R4:ledger", "repair:R7:ledger"]);
    // the test contact's record is written to GHL (by the Ledger drift workflow, D88); the real contact's is held back by test mode
    expect(writes).toEqual([]);
    await run();
    expect(writes).toEqual([{ id: "R2", outcome: "cancelled" }]);
    expect(await outcomeOf("AP1")).toBe("cancelled"); expect(await outcomeOf("AP2")).toBe("cancelled");
    expect(await outcomeOf("AP3")).toBe("showed");    // GHL wins
    expect(await outcomeOf("AP7")).toBe("showed");    // matched by person and minute from "Wed Oct 7 · 2:07 PM MST"
    expect(await outcomeOf("AP4")).toBe("noshow");    // cancelled after the call: the filed no-show stands, and the ledger follows it
    expect(await outcomeOf("AP6")).toBeNull();
    const nina = await asOperator((c) => one<{ id: string; first_name: string }>(c, "select id, first_name from contacts where company_id=$1 and ghl_contact_id='G-NEW'", [companyId]));
    expect(nina?.first_name).toBe("Nina");
    // a day late or 45 minutes late, each is a lead: the event says how late, and the lead workflows decide what a late lead gets
    expect(await asOperator((c) => one<{ minutes: number }>(c, "select (data->>'minutes_late')::int as minutes from events where company_id=$1 and contact_id=$2 and event_type='lead.created'", [companyId, nina!.id]))).toEqual({ minutes: expect.any(Number) });
    expect((await asOperator((c) => one<{ minutes: number }>(c, "select (data->>'minutes_late')::int as minutes from events where company_id=$1 and contact_id=$2 and event_type='lead.created'", [companyId, nina!.id])))!.minutes).toBeGreaterThan(60 * 23);
    expect(await asOperator((c) => one<{ n: number }>(c, "select count(*)::int as n from events e join contacts ct on ct.id=e.contact_id where e.company_id=$1 and ct.ghl_contact_id='G-SOON' and e.event_type='lead.created'", [companyId]))).toEqual({ n: 1 });
    expect(await asOperator((c) => one(c, "select 1 from contacts where company_id=$1 and ghl_contact_id='G-RECENT'", [companyId]))).toBeUndefined();
    expect((await asOperator((c) => one<{ gone_at: Date | null }>(c, "select gone_at from contacts where company_id=$1 and ghl_contact_id='G-GONE'", [companyId])))?.gone_at).toBeTruthy();
    expect((await asOperator((c) => one<{ gone_at: Date | null }>(c, "select gone_at from contacts where company_id=$1 and ghl_contact_id='G-FLAKY'", [companyId])))?.gone_at).toBeNull();   // GHL did not answer: unconfirmed, untouched, unsaid
    const audit = await asOperator((c) => many<{ target_id: string; after: { repair: string } }>(c, "select target_id, after from audit_log where company_id=$1 and action='health.repaired'", [companyId]));
    expect(audit.map((a) => a.after.repair).sort()).toEqual(["booking_cancelled", "booking_cancelled", "booking_cancelled", "ghl_outcome", "ghl_outcome", "ghl_outcome", "marked_gone", "pulled_in", "pulled_in"]);
    const bad = fs.find((f) => !f.ok)!;
    expect(asked(r.findings).map((q) => q.kind).sort()).toEqual(["cancel_held_back", "cancel_time_unknown", "unmatched"]);
    // the questions as the Health check workflow words them (D88): the words the engine used to hold
    const text = await worded();
    expect(text).toMatch(/\n\d+ records in the engine didn't match GHL over the last 7 days; they've been updated from GHL\.\nExcept these, which I have questions about:\n• /);
    expect(text.split("\n").filter((l) => l.startsWith("• ")).length).toBe((bad.detail as { items: unknown[] }).items.length);   // one line each
    expect(text).toContain("• G-K1, "); expect(text).toContain("I couldn't change it (test mode: would set the outcome to \"cancelled\""); expect(text).toContain("Set it to cancelled in GHL?");
    expect(text).toContain("GHL has this Sales Call, but the engine has no booking for that person at that time.");
    expect(text).not.toContain("Nina");
    expect(text).toContain("Calendly says cancelled, GHL says no-show, and I can't tell when it was cancelled. Which is right?");
    expect(text).not.toContain("G-FLAKY");
    expect((await asOperator((c) => openAlerts(c, companyId))).filter((a) => a.key === "health:ledger_drift")).toHaveLength(1);
    expect(await asOperator((c) => one(c, "select 1 from crm_records where company_id=$1 and ghl_record_id='R2' and properties->>'outcome'='cancelled'", [companyId]))).toBeTruthy();
  });

  it("the next sweep finds the repairs holding and repeats nothing; once the rest is mended the alert resolves", async () => {
    let r = await sweep();
    expect(drift(r.findings).filter((f) => f.ok)).toEqual([]);   // nothing left to repair, nothing written again
    expect(writes).toHaveLength(1);
    expect(await asOperator((c) => one<{ n: number }>(c, "select count(*)::int as n from events where company_id=$1 and event_type='lead.created'", [companyId]))).toEqual({ n: 2 });   // Nina and Sol, once each
    // live: the real contact's record may now be written; a refusal leaves it for the next sweep, unclaimed
    await asOperator((c) => c.query("update companies set mode='live' where id=$1", [companyId]));
    refuse = true; r = await sweep(); await run(); refuse = false;
    // the workflow's write was refused: its step says so (and alerts, D77); nothing is recorded as written, so the next sweep hands it on again
    expect(writes).toHaveLength(1);
    expect(await asOperator((c) => one<{ result: Record<string, unknown> }>(c, "select s.result from run_steps s join runs r on r.id=s.run_id join workflows w on w.id=r.workflow_id where r.company_id=$1 and w.name='Ledger drift' and s.node_id='r_cancel' and s.status='skipped' order by s.started_at desc limit 1", [companyId]))).toEqual({ result: expect.objectContaining({ kind: "gave_up", class: "permanent", vendor: "ghl", why: "couldn't update the Sales Call record after 1 try; the run went on without it" }) });
    records.splice(records.findIndex((x) => x.id === "R5"), 1);
    await asOperator((c) => c.query("update appointments set source_updated_at=starts_at + interval '1 hour' where company_id=$1 and external_id='AP6'", [companyId]));
    r = await sweep(); await run();
    expect(writes).toEqual([{ id: "R2", outcome: "cancelled" }, { id: "R1", outcome: "cancelled" }]);
    expect(drift(r.findings).filter((f) => f.ok).map((f) => f.item)).toEqual(["repair:R1:ghl", "repair:R6:ledger"]);   // AP6 cancelled after its start: the filed no-show stands
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    expect((await asOperator((c) => openAlerts(c, companyId))).filter((a) => a.key === "health:ledger_drift")).toHaveLength(0);
    // a GHL record set back after the repair is not written twice: it is left for a person
    records.find((x) => x.id === "R1")!.properties.outcome = "no_show";
    r = await sweep(); await run();
    expect(writes).toHaveLength(2);
    expect(asked(r.findings).map((q) => q.kind)).toEqual(["cancel_set_back"]);
    expect(await worded()).toContain("it was set once already and GHL says otherwise again");
    records.find((x) => x.id === "R1")!.properties.outcome = "cancelled";
  });

  it("GHL that cannot be read keeps the open alert as it is", async () => {
    records.find((x) => x.id === "R2")!.properties.outcome = "no_show";
    let r = await sweep();
    expect(asked(r.findings).map((q) => q.kind)).toContain("cancel_set_back");   // written once already: a person's now
    const before = (await asOperator((c) => openAlerts(c, companyId))).find((a) => a.key === "health:ledger_drift")!;
    ghlDown = true; r = await sweep(); ghlDown = false;
    expect(drift(r.findings)).toEqual([expect.objectContaining({ ok: false, text: before.text })]);
    expect((await asOperator((c) => openAlerts(c, companyId))).find((a) => a.key === "health:ledger_drift")?.id).toBe(before.id);
  });
  it("D75: once GHL holds Payment records, a won closer card with no payment and a payment with no won closer card are asked about, one line each", async () => {
    await asOperator((c) => c.query("insert into bindings (company_id, key, kind, value) values ($1,'crm.pipeline_closer','id',$2)", [companyId, Buffer.from("PIPE-CLOSER")]));
    won.push({ id: "W-K1", pipelineId: "PIPE-CLOSER", status: "won", wonAt: ago({ days: 2 }).toUTC().toISO()!, contactId: "G-K1", contactName: "G-K1", contactTags: [] },
      { id: "W-TEST", pipelineId: "PIPE-CLOSER", status: "won", wonAt: ago({ days: 2 }).toUTC().toISO()!, contactId: "G-TEST", contactName: "G-TEST", contactTags: [] });   // the team's test contact: never asked about
    try {
      expect(asked((await sweep()).findings).map((q) => q.kind)).not.toEqual(expect.arrayContaining(["won_no_payment"]));   // no Payment records at all: nothing to compare yet
      payments.push({ id: "PAY-K2", createdAt: ago({ days: 1 }).toISO()!, properties: { contact_id: "G-K2", amount: 500, type: "deposit", status: "succeeded", occurred_at: ago({ days: 1 }).toUTC().toISO() } },
        { id: "PAY-K2b", createdAt: ago({ days: 1 }).toISO()!, properties: { contact_id: "G-K2", amount: 250, type: "installment", status: "succeeded", occurred_at: ago({ hours: 5 }).toUTC().toISO() } });
      await sweep();
      const text = await worded();
      expect(text).toMatch(/which I have questions about:\n/);
      expect(text).toMatch(/\n• G-K1: their closer card was won \w{3} \w{3} \d{1,2}, but GHL has no payment for them\. Did they pay, or should the card not be won\?/);
      expect(text).toMatch(/\n• G-K2: GHL has a \$500 payment from \w{3} \w{3} \d{1,2} but no won closer card\. Should their closer card be won\?/);
      expect(text.match(/G-K2: GHL has/g)).toHaveLength(1);
      expect(text).not.toContain("G-TEST: their closer card");
    } finally {
      won.splice(0); payments.splice(0);
      await asOperator((c) => c.query("delete from bindings where company_id=$1 and key='crm.pipeline_closer'", [companyId]));
    }
  });
  it("D76: a Sales Call missing its link to the closer card is linked (field and association) when the person has exactly one; with none or several it is a question; never twice", async () => {
    await asOperator(async (c) => {
      for (const [k, v] of [["crm.pipeline_closer", "PIPE-CLOSER"], ["crm.assoc_sales_call_opportunity", "ASSOC-OPP"], ["crm.assoc_sales_call_contact", "ASSOC-CT"]]) await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'id',$3) on conflict (company_id, key) do update set value=excluded.value", [companyId, k, Buffer.from(v)]);
      const k2 = (await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='G-K2'", [companyId]))!.id;
      const opp = (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, opened_by) values ($1,$2,'test') returning id", [companyId, k2]))!.id;
      await c.query("insert into pipeline_cards (company_id, opportunity_id, contact_id, ghl_opportunity_id, ghl_pipeline_id, ghl_stage_id, name, status) values ($1,$2,$3,'CARD-K2','PIPE-CLOSER','ST','G-K2 -- Direct','open')", [companyId, opp, k2]);
    });
    try {
      const fs = drift((await sweep()).findings);
      await run();   // D88: the Ledger drift workflow links it
      expect(linkWrites).toEqual(expect.arrayContaining([{ id: "R3", props: { opportunity_id: "CARD-K2" } }]));
      expect(relations).toContain("ASSOC-OPP:R3>CARD-K2");
      expect(fs.find((f) => f.item === "repair:R3:links")?.text).toMatch(/links the Sales Call to the closer card/);
      expect(await worded()).toMatch(/G-K1, .*: this Sales Call isn't linked to a closer card, and the person has none\. Which card is it\?/);
      const n = linkWrites.length; await sweep(); await run(); expect(linkWrites.length).toBe(n);   // a link is written once
    } finally { await asOperator((c) => c.query("delete from bindings where company_id=$1 and key in ('crm.pipeline_closer','crm.assoc_sales_call_opportunity','crm.assoc_sales_call_contact')", [companyId])); }
  });
  it("D83: GHL's outcome (the disposition) is copied too: a showed call takes it, a call GHL says did not happen has none, a deposit stays a deposit, a value nobody mapped is asked about until it is", async () => {
    const resultOf = (ext: string) => asOperator(async (c) => (await one<{ category: string | null }>(c, "select t.category from appointments a left join company_terms t on t.id=a.call_outcome_term where a.company_id=$1 and a.external_id=$2", [companyId, ext]))?.category ?? null);
    await asOperator(async (c) => {
      const closing = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      const term = async (domain: string, cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain=$2 and category=$3", [companyId, domain, cat]))!.id;
      const k3 = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, ghl_added_at) values ($1,'G-K3','G-K3',$2) returning id", [companyId, ago({ days: 3 }).toJSDate()]))!.id;
      const appt = async (ext: string, hoursAgo: number, outcome: string, result: string | null) => c.query("insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status, outcome_term, call_outcome_term) values ($1,$2,'calendly',$3,$4,$5,$5,$6,'confirmed',$7,$8)",
        [companyId, k3, ext, closing, ago({ hours: hoursAgo }).startOf("minute").toJSDate(), ago({ days: 8 }).toJSDate(), await term("appointment_outcome", outcome), result ? await term("call_outcome", result) : null]);
      await appt("AP8", 30, "showed", null);            // the old process filed closed won in GHL; the ledger only knows showed
      await appt("AP9", 40, "showed", "follow_up");     // GHL says it was a no-show after all
      await appt("AP10", 50, "showed", "deposit");      // the engine filed a deposit, which GHL holds as closed won (no deposit option declared: D119)
      await appt("AP11", 60, "showed", null);           // a disposition the engine has no meaning for
      await appt("AP12", 70, "showed", null);           // close pending: not a close
      // an offer whose dispositions have no deposit option (install writes the engine's own, which have one: D200)
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'sales_call.dispositions','text',$2) on conflict (company_id, key) do update set value=excluded.value", [companyId, Buffer.from(JSON.stringify({ closed_won: "closed", follow_up: "follow_up", lost: "lost", dq: "unqualified" }))]);
    });
    const rec = (id: string, ext: string, hoursAgo: number, outcome: string, disposition: string) => { const r = sc(id, ext, "G-K3", ago({ hours: hoursAgo }).startOf("minute"), outcome); r.properties.disposition = disposition; return r; };
    records.push(rec("R8", "Z-8", 30, "showed", "closed_won"), rec("R9", "Z-9", 40, "no_show", ""), rec("R10", "Z-10", 50, "showed", "closed_won"), rec("R11", "Z-11", 60, "showed", "financing_denied"), rec("R12", "Z-12", 70, "showed", "close_pending"));
    try {
      const fs = drift((await sweep()).findings);
      expect(await resultOf("AP8")).toBe("closed");
      expect(await resultOf("AP9")).toBeNull();
      expect(await outcomeOf("AP9")).toBe("noshow");
      expect(await resultOf("AP10")).toBe("deposit");
      expect(await resultOf("AP11")).toBeNull();
      expect(fs.filter((f) => f.ok).map((f) => f.item)).toEqual(expect.arrayContaining(["repair:R8:result", "repair:R9:result"]));
      expect(fs.some((f) => f.item === "repair:R10:result")).toBe(false);
      expect(asked(fs.length ? [...fs] : []).some((q) => q.kind === "disposition_unmapped")).toBe(true);
      expect(await worded()).toContain(`GHL's outcome is "financing_denied", and the engine hasn't been told what that means yet.`);
      // the company says what it means, with its own reason under lost; the next sweep follows
      await asOperator(async (c) => {
        await c.query("insert into bindings (company_id, key, kind, value) values ($1,'sales_call.dispositions','text',$2) on conflict (company_id, key) do update set value=excluded.value", [companyId, Buffer.from(JSON.stringify({ closed_won: "closed", follow_up: "follow_up", lost: "lost", dq: "unqualified", financing_denied: { meaning: "lost", reason: "Financing denied" }, close_pending: "pending" }))]);
        await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) values ($1,'call_outcome','Financing denied','lost',false,50)", [companyId]);
      });
      const again = drift((await sweep()).findings);
      expect(await resultOf("AP11")).toBe("lost");
      expect(await asOperator(async (c) => (await one<{ name: string }>(c, "select t.name from appointments a join company_terms t on t.id=a.call_outcome_term where a.company_id=$1 and a.external_id='AP11'", [companyId]))?.name)).toBe("Financing denied");
      expect(await resultOf("AP12")).toBe("pending");   // D228: close pending in GHL and no cash yet: pending until it is collected
      const k3 = (await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='G-K3'", [companyId])))!.id;
      await asOperator((c) => c.query("insert into agreements (company_id, contact_id, external_id, status, sent_at, signed_at) values ($1,$2,'DOC-K3','completed',now(),now())", [companyId, k3]));
      await sweep();
      expect(await resultOf("AP12")).toBe("pending");     // D228: signed, not paid: a signature alone does not close it
      await asOperator((c) => c.query("insert into payments (company_id, contact_id, whop_payment_id, amount, status, paid_at) values ($1,$2,'pay-k3',500,'succeeded',now())", [companyId, k3]));
      await sweep();
      expect(await resultOf("AP12")).toBe("closed");      // signed and paid: a close
      expect(asked(again).some((q) => q.kind === "disposition_unmapped")).toBe(false);
      expect(again.some((f) => f.item === "repair:R8:result")).toBe(false);   // nothing repeated
    } finally {
      for (const id of ["R8", "R9", "R10", "R11", "R12"]) records.splice(records.findIndex((r) => r.id === id), 1);
      await asOperator(async (c) => { await c.query("delete from bindings where company_id=$1 and key='sales_call.dispositions'", [companyId]); await c.query("delete from audit_log where company_id=$1", [companyId]); await c.query("delete from appointments where company_id=$1 and external_id in ('AP8','AP9','AP10','AP11','AP12')", [companyId]); await c.query("delete from company_terms where company_id=$1 and name='Financing denied'", [companyId]); await c.query("delete from payments where company_id=$1 and whop_payment_id='pay-k3'", [companyId]); await c.query("delete from agreements where company_id=$1 and external_id='DOC-K3'", [companyId]); });
    }
  });
});
