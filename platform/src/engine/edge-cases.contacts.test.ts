/**
 * Contact-shaped edge cases: who the person is when a lead has no phone or email, a many-part name, a duplicate in
 * the CRM, a changed number, a garbage time zone. Driven through the real engine (the poll, the dispatcher, the
 * runner) against Postgres with a fake CRM that refuses what the real one refuses. The catalogue is
 * engine/05-edge-cases.md § "Contacts: who the person is"; every `it.fails` here is a row under its "Known gaps" (D60 fixed
 * all but G17, which waits on a decision).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { readFileSync, readdirSync } from "node:fs";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { emitEvent, dispatchEvent } from "@/engine/dispatch";
import { applyAppointment, pollAll, upsertContact } from "@/engine/poll";
import { loadCompany } from "@/engine/context";
import { recordPayment } from "@/engine/payments";
import { contactPasses } from "@/engine/mode";
import { render } from "@/engine/template";
import { tick } from "@/engine/runner";
import { fakeAdapters } from "@/engine/test-install";
import type { Adapters, AppointmentSnapshot, ContactSnapshot, MessageSnapshot } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";

// the fake CRM: what it "has" for each contact, what the next poll delivers, what the sends did
const crm = new Map<string, ContactSnapshot>();
const changed: ContactSnapshot[] = [];
const inbox: MessageSnapshot[] = [];
const sent: { kind: string; to: string; body: string }[] = [];
const refused: { kind: string; to: string; error: string }[] = [];
const tags: string[] = [];
const oppWrites: Record<string, unknown>[] = [];
const apptStore = new Map<string, AppointmentSnapshot>();
const base = fakeAdapters();
const refuse = (kind: string, to: string, error: string) => { refused.push({ kind, to, error }); return { externalId: "", accepted: false, error }; };
const fake: Adapters = {
  ...base,
  read: { ...base.read, listUsers: async () => [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }], getContact: async (_c, id) => crm.get(id) ?? null,
    contactsChangedSince: async (c) => (c.id === companyId ? changed.splice(0) : []), inboundSince: async (c) => (c.id === companyId ? inbox.splice(0) : []) },
  booking: (() => { const b = { appointmentsInWindow: async () => [], listCalendars: async () => [{ id: "CAL", name: "Closer Call", teamMemberIds: ["U1"] }], getAppointment: async (_c: unknown, id: string) => apptStore.get(id) ?? null }; return { ghl: b, calendly: b }; })(),
  write: { ...base.write, addTag: async (_c, _id, t) => { tags.push(t); }, createOpportunity: async (_c, input) => { oppWrites.push({ op: "create", ...input }); return { id: `ghl-opp-${oppWrites.length}` }; }, updateOpportunity: async (_c, id, patch) => { oppWrites.push({ op: "update", id, ...patch }); } },
  sender: { ...base.sender,
    // the CRM sends by contact id and refuses when the contact has no address for the channel, or is gone
    sendSms: async (_c, to, body) => { const s = crm.get(to); if (!s) return refuse("sms", to, `Contact with id ${to} not found`); if (!s.phone) return refuse("sms", to, `contact ${to} has no phone number`); sent.push({ kind: "sms", to, body }); return { externalId: `s${sent.length}`, accepted: true }; },
    sendEmail: async (_c, to, subject, html) => { const s = crm.get(to); if (!s) return refuse("email", to, `Contact with id ${to} not found`); if (!s.email) return refuse("email", to, `contact ${to} has no email address`); sent.push({ kind: "email", to, body: `${subject}|${html}` }); return { externalId: `e${sent.length}`, accepted: true }; } },
};

const CRM = { pipeline_setter: "PIPE-SETTER", stage_setter_new_lead: "STAGE-NEW", field_opportunity_stage_entered: "CF-STAGE-DATE", pipeline_closer: "PIPE-CLOSER", stage_setter_direct_booked: "STAGE-DIRECT", stage_setter_appointment_set: "STAGE-SET", stage_closer_scheduled: "STAGE-SCHED", stage_setter_cancelled: "STAGE-S-CANCEL", stage_closer_cancelled: "STAGE-C-CANCEL", field_contact_appointment_date: "CF-APPT-DATE", field_contact_setter: "CF-SETTER", field_opportunity_setter_owner: "CF-SETTER-OWNER", agreement_template: "TPL-AGREE", agreement_sender: "U1", default_closer: "U1", stage_closer_agreement_sent: "STAGE-AGREE", stage_closer_closed_won: "STAGE-WON", field_contact_cash_collected: "CF-CASH", field_contact_revenue_generated: "CF-REV", assoc_payment_contact: "ASSOC-PC", assoc_payment_opportunity: "ASSOC-PO", stage_setter_showed: "STAGE-SHOWED", assoc_sales_call_contact: "ASSOC-SC", assoc_sales_call_opportunity: "ASSOC-SO" };
const TEMPLATES = ["new-lead", "speed-to-lead", "pre-call-sequence", "call-booked", "payment-recorded"];
const TABLES = ["alerts", "eod_reports", "slack_posts", "agreements", "sends", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
let companyId: string;

const wipe = (slug: string) => asOperator(async (c) => {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
  await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
  await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
  await c.query("update appointments set disposition_id=null where company_id=$1", [co.id]);
  for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
  await c.query("delete from companies where id=$1", [co.id]);
});
type Run = { id: string; status: string; current_node: string | null; exit_reason: string | null; next_run_at: Date | null; contact_id: string | null; context: Record<string, unknown> };
const runsFor = (slug: string) => asOperator((c) => many<Run>(c, "select r.id, r.status, r.current_node, r.exit_reason, r.next_run_at, r.contact_id, r.context from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug=$2 order by r.started_at, r.id", [companyId, slug]));
const runOf = async (slug: string, contactId: string) => (await runsFor(slug)).filter((r) => r.contact_id === contactId).at(-1)!;
const slugsFor = (contactId: string) => asOperator((c) => many<{ slug: string }>(c, "select distinct t.slug from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where r.company_id=$1 and r.contact_id=$2 order by 1", [companyId, contactId]));
const wake = (runId: string) => asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [runId]));
const expireReplyWait = (runId: string, nodeId: string) => asOperator((c) => c.query("update runs set next_run_at=now(), context = jsonb_set(context, $2::text[], to_jsonb($3::text), true) where id=$1", [runId, `{vars,__wait_for_reply,${nodeId},deadline}`, new Date(Date.now() - 60e3).toISOString()]));
type Contact = { id: string; ghl_contact_id: string | null; first_name: string | null; last_name: string | null; timezone: string | null; timezone_source: string | null };
const contactByGhl = (ghlId: string) => asOperator((c) => one<Contact>(c, "select id, ghl_contact_id, first_name, last_name, timezone, timezone_source from contacts where company_id=$1 and ghl_contact_id=$2", [companyId, ghlId]));
const identifiers = (contactId: string) => asOperator((c) => many<{ kind: string; value: string }>(c, "select kind, value from contact_identifiers where contact_id=$1 order by kind, created_at", [contactId]));
const steps = (runId: string) => asOperator((c) => many<{ node_id: string; status: string; result: Record<string, unknown>; error: string | null }>(c, "select node_id, status, result, error from run_steps where run_id=$1 order by started_at", [runId]));
const sends = (runId: string) => asOperator((c) => many<{ channel: string; status: string; suppressed_reason: string | null; error: string | null }>(c, "select channel, status, suppressed_reason, error from sends where run_id=$1 order by idempotency_key", [runId]));
const cardNames = (contactId: string) => asOperator((c) => many<{ name: string }>(c, "select name from pipeline_cards where company_id=$1 and contact_id=$2 order by created_at", [companyId, contactId]));
const inCrm = (id: string, over: Partial<ContactSnapshot> = {}): ContactSnapshot => { const s: ContactSnapshot = { id, tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString(), ...over }; crm.set(id, s); changed.push(s); return s; };
const poll = () => pollAll(fake);
const lead = (contactId: string) => asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: {} }), { contact: { id: contactId } }));
const daysOut = (d: number, hour = 14) => DateTime.now().setZone(TZ).plus({ days: d }).set({ hour, minute: 0, second: 0, millisecond: 0 });
const snap = (id: string, over: Partial<AppointmentSnapshot> = {}): AppointmentSnapshot => { const start = daysOut(3); return { id, calendarId: "CAL", assignedUserId: "U1", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), raw: {}, ...over }; };
const book = async (s: AppointmentSnapshot) => { apptStore.set(s.id, s); await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, s); }); };
const upsert = (s: ContactSnapshot) => asOperator(async (c) => { crm.set(s.id, s); return upsertContact(c, companyId, TZ, s); });
const reply = (ghlContactId: string, body: string) => { inbox.push({ id: `m-${ghlContactId}-${Math.random().toString(36).slice(2, 8)}`, conversationId: `cv-${ghlContactId}`, contactId: ghlContactId, channel: "sms", direction: "inbound", body, dateAdded: new Date().toISOString() }); return poll(); };

describe("contacts (pure)", () => {
  it("the first_name filter takes the first whitespace-separated word, never splits a hyphen, and is used by no shipped template ({{contact.first_name}} is the CRM's own first-name field)", () => {
    const env = { tz: TZ };
    const first = (name: string) => render("{{contact.name | first_name}}", { contact: { name } }, env);
    expect(first("Mary Anne Smith")).toBe("Mary");       // the filter cannot know "Mary Anne" is one name; the CRM's first_name field can
    expect(first("Jean-Luc Picard")).toBe("Jean-Luc");
    expect(first("D'Angelo Russell")).toBe("D'Angelo");
    expect(first("  Cher  ")).toBe("Cher");
    expect(first("cher")).toBe("cher");                   // as typed, never re-cased
    expect(first("")).toBe("");
    const dir = new URL("../templates/", import.meta.url);
    const uses = readdirSync(dir).filter((f) => f.endsWith(".json")).filter((f) => /\|\s*first_name/.test(readFileSync(new URL(f, dir), "utf8")));
    expect(uses).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("contacts: who the person is", () => {
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    await wipe("edgesc");
    const r = await installCompany({ name: "Edges Contacts", slug: "edgesc", timezone: TZ, locationId: "LOC-EDGESC", pit: "pit-fake", calendars: { CAL: "closing" }, enable: true, templates: TEMPLATES, crm: CRM, anthropicKey: "sk-fake", contractValueDefault: 2999 }, fake);
    await asOperator((c) => c.query("update companies set mode='live' where id=$1", [r.companyId]));   // D56: install cannot reach live without Slack
    companyId = r.companyId;
    expect(r.installed.filter((s) => s.endsWith("enabled"))).toHaveLength(TEMPLATES.length);
    await asOperator(async (c) => {
      await c.query("update companies set send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]);
      // the baseline poll already happened: from here every poll is deltas (lead.created, message.received)
      const since = DateTime.now().minus({ days: 1 }).toISO()!;
      for (const entity of ["contacts", "conversations"]) await c.query("insert into poll_cursors (company_id, entity, cursor, last_polled_at, last_success_at) values ($1,$2,$3,now(),now())", [companyId, entity, since]);
    });
  });

  // ---- 1-3: no phone, no email ----

  it("a lead with no phone and no email: New lead parks for a day looking every 10 minutes and says why; the tick does not throw; Speed to lead's run names the missing address", async () => {
    inCrm("NP1", { firstName: "Cher" });
    const rep = await poll(); expect(rep.errors.filter((e) => e.company === "edgesc")).toEqual([]);
    const ct = (await contactByGhl("NP1"))!; expect(ct).toMatchObject({ first_name: "Cher", last_name: null });
    expect((await identifiers(ct.id)).map((i) => i.kind)).toEqual(["ghl_contact"]);   // nothing invented
    const before = Date.now();
    await tick(fake, undefined, companyId);
    const nl = await runOf("new-lead", ct.id);
    expect(nl).toMatchObject({ status: "waiting", current_node: "n1" });
    const deadline = DateTime.fromISO(((nl.context.vars as Record<string, Record<string, Record<string, string>>>).__check.n1).deadline);
    expect(Math.abs(deadline.diff(DateTime.fromMillis(before), "hours").hours - 24)).toBeLessThan(0.1);            // gives up after a day (D39)
    expect(nl.next_run_at!.getTime() - before).toBeGreaterThan(9 * 60e3); expect(nl.next_run_at!.getTime() - before).toBeLessThan(11 * 60e3);   // looks again in 10 minutes
    const st = await steps(nl.id); expect(st.find((x) => x.node_id === "n1")).toMatchObject({ node_id: "n1", status: "waiting", result: { why: expect.stringMatching(/not yet/) } });   // t1 and n1 share a timestamp; order is not the point
    expect(await cardNames(ct.id)).toEqual([]);
    const stl = await runOf("speed-to-lead", ct.id);
    // D56 (G1): a refused send no longer fails the run; the steps say why and the run goes on to its reply wait
    expect(stl.status).not.toBe("failed");
    const whys = await asOperator((c) => many<{ why: string }>(c, "select coalesce(result->>'why','') as why from run_steps where run_id=$1 and node_type in ('send_sms','send_email')", [stl.id]));
    expect(whys.map((w) => w.why).join(" | ")).toMatch(/no email|no phone|refused/);   // the run does say why, if only as the CRM's refusal
  });

  it("a lead with no phone and no email: Speed to lead records the email and the text as suppressed (no address) and goes on to its reply wait; the CRM is never asked (G11, fixed by D60)", async () => {
    const ct = (await contactByGhl("NP1"))!;
    const stl = await runOf("speed-to-lead", ct.id);
    expect(stl.status).not.toBe("failed");
    expect(refused.filter((r) => r.to === "NP1")).toEqual([]);
    expect(stl).toMatchObject({ status: "waiting", current_node: "n3" });
    const s = await sends(stl.id);
    expect(s.map((x) => [x.channel, x.status])).toEqual([["email", "suppressed"], ["sms", "suppressed"]]);
    expect(s.map((x) => x.suppressed_reason)).toEqual([expect.stringMatching(/no email/), expect.stringMatching(/no phone/)]);
  });

  it("a lead with an email but no phone: the email goes, the text is skipped for want of a number, the run waits for a reply (G11, fixed by D60)", async () => {
    inCrm("EO1", { firstName: "Mail", lastName: "Only", email: "eo1@x.com" });
    await poll(); const n = sent.length; await tick(fake, undefined, companyId);
    const ct = (await contactByGhl("EO1"))!;
    expect(sent.slice(n).filter((s) => s.to === "EO1").map((s) => s.kind)).toEqual(["email"]);
    const stl = await runOf("speed-to-lead", ct.id);
    expect((await sends(stl.id)).map((x) => [x.channel, x.status, x.suppressed_reason])).toEqual([["email", "sent", null], ["sms", "suppressed", "no phone on the contact"]]);
    expect(stl).toMatchObject({ status: "waiting", current_node: "n3" });
  });

  it("a lead with a phone but no email: the email is skipped and the text still goes (G11, fixed by D60)", async () => {
    inCrm("PO1", { firstName: "Phone", lastName: "Only", phone: "+16025550301" });
    await poll(); const n = sent.length; await tick(fake, undefined, companyId);
    const ct = (await contactByGhl("PO1"))!;
    const stl = await runOf("speed-to-lead", ct.id);
    expect(sent.slice(n).filter((s) => s.to === "PO1").map((s) => s.kind)).toEqual(["sms"]);
    expect((await sends(stl.id)).map((x) => [x.channel, x.status])).toEqual([["email", "suppressed"], ["sms", "sent"]]);
    expect(stl).toMatchObject({ status: "waiting", current_node: "n3" });
  });

  it("a lead with a phone but no email: New lead does not care about the email; the card is made and tagged", async () => {
    const ct = (await contactByGhl("PO1"))!;
    expect(await runOf("new-lead", ct.id)).toMatchObject({ status: "completed", exit_reason: "done" });
    expect(await cardNames(ct.id)).toEqual([{ name: "Phone Only -- New" }]);
  });

  it("a phone added later in the CRM: the parked New lead run is not woken by the phone's arrival; it looks again on its 10-minute clock and then continues", async () => {
    inCrm("LP1", { firstName: "Late", lastName: "Phone", email: "lp1@x.com" });
    await poll(); await tick(fake, undefined, companyId);
    const ct = (await contactByGhl("LP1"))!;
    const run = await runOf("new-lead", ct.id); expect(run).toMatchObject({ status: "waiting", current_node: "n1" });
    // the setter adds the number in the CRM; the next contacts poll brings it
    inCrm("LP1", { firstName: "Late", lastName: "Phone", email: "lp1@x.com", phone: "+16025550304", dateUpdated: new Date(Date.now() + 1000).toISOString() });
    await poll();
    expect((await identifiers(ct.id)).map((i) => i.kind).sort()).toEqual(["email", "ghl_contact", "phone"]);
    expect((await runsFor("new-lead")).filter((r) => r.contact_id === ct.id)).toHaveLength(1);   // an existing contact changing is not a new lead
    await tick(fake, undefined, companyId);
    expect(await runOf("new-lead", ct.id)).toMatchObject({ status: "waiting", current_node: "n1" });   // not due yet: the poll does not wake it
    expect(await cardNames(ct.id)).toEqual([]);
    await wake(run.id); await tick(fake, undefined, companyId);
    expect(await runOf("new-lead", ct.id)).toMatchObject({ status: "completed", exit_reason: "done" });
    expect(await cardNames(ct.id)).toEqual([{ name: "Late Phone -- New" }]);
  });

  // ---- 4: names ----

  it("names: one word, three words, a hyphen, an apostrophe, lower case, accents, CJK, an emoji — the text says the CRM's first name as typed, the card is 'First Last -- New', nothing throws", async () => {
    const people: [string, string | undefined, string | undefined][] = [
      ["NM1", "Cher", undefined], ["NM2", "Mary Anne", "Smith"], ["NM3", "Jean-Luc", "Picard"], ["NM4", "D'Angelo", "Russell"],
      ["NM5", "cher", "bono"], ["NM6", "Zoë", "Ångström"], ["NM7", "José", "Núñez"], ["NM8", "李", "雷"], ["NM9", "🔥 Mike", "Hot"],
    ];
    for (const [id, first, last] of people) inCrm(id, { firstName: first, lastName: last, email: `${id.toLowerCase()}@x.com`, phone: `+1602555${id.slice(2).padStart(4, "0")}` });
    const rep = await poll(); expect(rep.errors.filter((e) => e.company === "edgesc")).toEqual([]);
    const n = sent.length;
    await tick(fake, undefined, companyId);
    for (const [id, first, last] of people) {
      const ct = (await contactByGhl(id))!;
      const text = sent.slice(n).find((s) => s.to === id && s.kind === "sms")!;
      expect(text.body.startsWith(`Hey ${first}, it's`)).toBe(true);
      const full = [first, last].filter(Boolean).join(" ");
      expect(await cardNames(ct.id)).toEqual([{ name: `${full} -- New` }]);
      expect(await runOf("new-lead", ct.id)).toMatchObject({ status: "completed", exit_reason: "done" });
      expect(await runOf("speed-to-lead", ct.id)).toMatchObject({ status: "waiting", current_node: "n3" });
    }
  });

  it("a name with leading/trailing spaces renders trimmed: 'Hey Zed,' and 'Zed Zee -- New' (G12, fixed by D60)", async () => {
    inCrm("NS1", { firstName: "  Zed  ", lastName: " Zee ", email: "ns1@x.com", phone: "+16025550411" });
    await poll(); const n = sent.length; await tick(fake, undefined, companyId);
    const ct = (await contactByGhl("NS1"))!;
    expect(ct).toMatchObject({ first_name: "Zed", last_name: "Zee" });
    expect(sent.slice(n).find((s) => s.to === "NS1" && s.kind === "sms")!.body.startsWith("Hey Zed, it's")).toBe(true);
    expect(await cardNames(ct.id)).toEqual([{ name: "Zed Zee -- New" }]);
  });

  it("an empty name: the text says 'Hey there,' and the card is named by the contact's email, never ' -- New' (G13, fixed by D60)", async () => {
    inCrm("NE1", { firstName: "", lastName: "", email: "ne1@x.com", phone: "+16025550412" });
    await poll(); const n = sent.length; await tick(fake, undefined, companyId);
    const ct = (await contactByGhl("NE1"))!;
    const text = sent.slice(n).find((s) => s.to === "NE1" && s.kind === "sms")!;
    expect(text.body.startsWith("Hey there, it's")).toBe(true);
    const cards = await cardNames(ct.id); expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe("ne1@x.com -- New");
  });

  // ---- 5: the same person twice in the CRM ----

  it("two CRM contacts sharing an email collapse into one person: the second's CRM id attaches to the first and becomes the primary; a payment by that email and a booking under the second id land on the one person; no second New lead (D65)", async () => {
    inCrm("DUP-A", { firstName: "Dup", lastName: "One", email: "dup@x.com", phone: "+16025550501" });
    await poll(); await tick(fake, undefined, companyId);
    const a = (await contactByGhl("DUP-A"))!;
    inCrm("DUP-B", { firstName: "Dup", lastName: "Two", email: "dup@x.com", phone: "+16025550502" });
    await poll(); await tick(fake, undefined, companyId);
    expect((await contactByGhl("DUP-B"))?.id).toBe(a.id);   // no second person: the one person now answers to the live record (D65)
    expect((await identifiers(a.id)).filter((i) => i.kind === "ghl_contact").map((i) => i.value).sort()).toEqual(["DUP-A", "DUP-B"]);
    expect((await identifiers(a.id)).filter((i) => i.kind === "phone").map((i) => i.value).sort()).toEqual(["+16025550501", "+16025550502"]);
    expect(await asOperator((c) => many(c, "select 1 from contacts where company_id=$1 and id in (select contact_id from contact_identifiers where company_id=$1 and kind='email' and value='dup@x.com')", [companyId]))).toHaveLength(1);
    // D65: the second arrival is the same person, not a new lead: no second New lead run, and the record the CRM is delivering now becomes the primary id writes go to
    expect((await runsFor("new-lead")).filter((r) => r.contact_id === a.id)).toHaveLength(1);
    expect((await runsFor("speed-to-lead")).filter((r) => r.contact_id === a.id)).toHaveLength(1);
    expect((await asOperator((c) => one<{ ghl_contact_id: string }>(c, "select ghl_contact_id from contacts where id=$1", [a.id])))?.ghl_contact_id).toBe("DUP-B");
    expect(await cardNames(a.id)).toEqual([{ name: "Dup One -- New" }]);   // one card, untouched by the second record
    const p = await asOperator((c) => recordPayment(c, companyId, { providerPaymentId: "P-DUP-1", amount: 500, status: "succeeded", paidAt: new Date(), email: "Dup@x.com" }));
    expect(p.outcome).toBe("linked"); if (p.outcome === "linked") expect(p.contactId).toBe(a.id);
    await book(snap("AP-DUP-B", { contactId: "DUP-B" }));
    expect(await asOperator((c) => one<{ contact_id: string }>(c, "select contact_id from appointments where company_id=$1 and external_id='AP-DUP-B'", [companyId]))).toMatchObject({ contact_id: a.id });
  });

  it("a reply from the duplicate CRM record's thread counts as the person's reply and wakes the run parked on it (G14, fixed by D60)", async () => {
    const a = (await contactByGhl("DUP-B"))!;   // the primary is the live record (D65); DUP-A is still an identifier
    const stl = await runOf("speed-to-lead", a.id); expect(stl).toMatchObject({ status: "waiting", current_node: "n3" });
    const before = Number((await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from messages where contact_id=$1", [a.id])))!.n);
    await reply("DUP-B", "yes let's talk");
    expect(Number((await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from messages where contact_id=$1", [a.id])))!.n)).toBe(before + 1);
    expect((await runOf("speed-to-lead", a.id)).next_run_at!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  // ---- 6: two phones on one contact ----

  it("a contact's number changes in the CRM: both numbers stay on the person; a reply from the CRM thread still matches (by CRM id, whichever number it came from)", async () => {
    inCrm("PC1", { firstName: "Two", lastName: "Phones", email: "pc1@x.com", phone: "+16025550601" });
    await poll(); await tick(fake, undefined, companyId);
    inCrm("PC1", { firstName: "Two", lastName: "Phones", email: "pc1@x.com", phone: "+16025550602", dateUpdated: new Date(Date.now() + 1000).toISOString() });
    await poll();
    const ct = (await contactByGhl("PC1"))!;
    expect((await identifiers(ct.id)).filter((i) => i.kind === "phone").map((i) => i.value)).toEqual(["+16025550601", "+16025550602"]);   // the old one stays on the person's history, retired (D60)
    expect((await asOperator((c) => many<{ value: string }>(c, "select value from contact_identifiers where contact_id=$1 and kind='phone' and retired_at is null", [ct.id]))).map((r) => r.value)).toEqual(["+16025550602"]);
    const stl = await runOf("speed-to-lead", ct.id); expect(stl).toMatchObject({ status: "waiting", current_node: "n3" });
    await reply("PC1", "yes");
    expect((await runOf("speed-to-lead", ct.id)).next_run_at!.getTime()).toBeLessThanOrEqual(Date.now());
    await tick(fake, undefined, companyId);
    expect((await steps(stl.id)).at(-1)).toMatchObject({ node_id: "n3", status: "waiting", result: { replies: 1, settling_until: expect.any(String) } });   // seen; D47 settle for more pieces
    // the settle window passes: the send and the reply both move into the past, the reply still after the send
    await asOperator(async (c) => { await c.query("update sends set sent_at = sent_at - interval '3 minutes' where run_id=$1", [stl.id]); await c.query("update messages set occurred_at = occurred_at - interval '2 minutes' where company_id=$1 and contact_id=$2", [companyId, ct.id]); });
    await wake(stl.id); await tick(fake, undefined, companyId);
    expect(await runOf("speed-to-lead", ct.id)).toMatchObject({ status: "completed", exit_reason: "replied" });
  });

  it("a number that moved to a different CRM contact belongs to the new person: a new CRM contact carrying the old number is a separate contact and takes the number with them (G15, fixed by D60)", async () => {
    inCrm("PC2", { firstName: "Newt", lastName: "Owner", email: "pc2@x.com", phone: "+16025550601" });   // the number PC1 gave up
    await poll();
    const pc2 = await contactByGhl("PC2");
    expect(pc2).toBeTruthy();
    expect(pc2!.id).not.toBe((await contactByGhl("PC1"))!.id);
    expect((await identifiers(pc2!.id)).filter((i) => i.kind === "phone").map((i) => i.value)).toEqual(["+16025550601"]);
    expect((await identifiers((await contactByGhl("PC1"))!.id)).filter((i) => i.kind === "phone").map((i) => i.value)).toEqual(["+16025550602"]);
  });

  // ---- 7: bookings by strangers ----

  it("a booking whose invitee matches no contact (Calendly-shaped, no CRM id): a contact is made with the invitee's names, Call booked and the pre-call sequence start, New lead does not — until the CRM poll delivers the person and the replica joins them", async () => {
    await book(snap("AP-STR1", { contactId: undefined, assignedUserId: undefined, assignedUserEmail: "sam@x.com", invitee: { email: "stranger@x.com", phone: "(602) 555-0701", firstName: "Mary Anne", lastName: "Smith", timezone: "America/Chicago" } }));
    const ct = (await asOperator((c) => one<Contact>(c, "select id, ghl_contact_id, first_name, last_name, timezone, timezone_source from contacts where company_id=$1 and id=(select contact_id from contact_identifiers where company_id=$1 and kind='email' and value='stranger@x.com')", [companyId])))!;
    expect(ct).toMatchObject({ ghl_contact_id: null, first_name: "Mary Anne", last_name: "Smith", timezone: "America/Chicago", timezone_source: "booking" });
    expect((await identifiers(ct.id)).map((i) => [i.kind, i.value])).toEqual([["email", "stranger@x.com"], ["phone", "+16025550701"]]);
    expect((await slugsFor(ct.id)).map((r) => r.slug)).toEqual(["call-booked", "pre-call-sequence"]);
    // the CRM poll later delivers the same person (the booking widget made them a contact)
    inCrm("STR1", { firstName: "Mary Anne", lastName: "Smith", email: "stranger@x.com", phone: "+16025550701", timezone: "America/Chicago" });
    await poll();
    expect(await contactByGhl("STR1")).toMatchObject({ id: ct.id });
    expect((await slugsFor(ct.id)).map((r) => r.slug)).toEqual(["call-booked", "new-lead", "pre-call-sequence", "speed-to-lead"]);
    await tick(fake, undefined, companyId);
    expect(await runOf("new-lead", ct.id)).toMatchObject({ status: "completed", exit_reason: "done" });
  });

  it("a CRM calendar booking by a person the contacts poll has not seen: lead.created fires once, before the booking (G16, fixed by D60)", async () => {
    crm.set("GB1", { id: "GB1", firstName: "Book", lastName: "First", email: "gb1@x.com", phone: "+16025550702", tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() });
    await book(snap("AP-GB1", { contactId: "GB1" }));
    const ct = (await contactByGhl("GB1"))!; expect(ct).toMatchObject({ first_name: "Book", last_name: "First" });
    changed.push(crm.get("GB1")!); await poll();   // the contacts poll now delivers them too
    expect((await slugsFor(ct.id)).map((r) => r.slug)).toEqual(["call-booked", "new-lead", "pre-call-sequence", "speed-to-lead"]);
    expect(await asOperator((c) => many(c, "select 1 from events where company_id=$1 and contact_id=$2 and event_type='lead.created'", [companyId, ct.id]))).toHaveLength(1);
    expect((await asOperator((c) => many<{ event_type: string }>(c, "select event_type from events where company_id=$1 and contact_id=$2 and event_type in ('lead.created','appointment.booked') order by id", [companyId, ct.id]))).map((e) => e.event_type)).toEqual(["lead.created", "appointment.booked"]);
  });

  // ---- 8: payments by strangers ----

  it.fails("a payment whose email matches no contact stays unlinked; when that contact arrives through the CRM poll the orphan is linked (heal) and Payment recorded runs once for it (nothing heals on a contact's arrival: only a later payment or a hand link does, D21 — decide, then fix, G17)", async () => {
    const r = await asOperator((c) => recordPayment(c, companyId, { providerPaymentId: "P-ORP-1", amount: 1500, status: "succeeded", paidAt: new Date(), email: "orphan1@x.com" }));
    expect(r.outcome).toBe("unlinked");   // true today
    inCrm("ORP1", { firstName: "Orphan", lastName: "One", email: "orphan1@x.com", phone: "+16025550801" });
    await poll(); await tick(fake, undefined, companyId);
    const ct = (await contactByGhl("ORP1"))!;
    expect(await asOperator((c) => one<{ link_status: string; contact_id: string | null }>(c, "select link_status, contact_id from payments where company_id=$1 and whop_payment_id='P-ORP-1'", [companyId]))).toMatchObject({ link_status: "linked", contact_id: ct.id });   // today: unlinked
    expect((await runsFor("payment-recorded")).filter((x) => x.contact_id === ct.id)).toHaveLength(1);
  });

  it("an orphan healed by a later payment from the same buyer is written to the CRM too: Payment recorded runs once per payment (G18, fixed by D60)", async () => {
    const r1 = await asOperator((c) => recordPayment(c, companyId, { providerPaymentId: "P-ORP-2", amount: 1000, status: "succeeded", paidAt: new Date(), email: "orphan2@x.com" }));
    expect(r1.outcome).toBe("unlinked");
    inCrm("ORP2", { firstName: "Orphan", lastName: "Two", email: "orphan2@x.com", phone: "+16025550802" });
    await poll(); await tick(fake, undefined, companyId);
    const ct = (await contactByGhl("ORP2"))!;
    const r2 = await asOperator(async (c) => { const r = await recordPayment(c, companyId, { providerPaymentId: "P-ORP-3", amount: 1000, status: "succeeded", paidAt: new Date(), email: "orphan2@x.com" }); if (r.outcome === "linked") await dispatchEvent(c, r.event, { contact: { id: ct.id } }); return r; });
    expect(r2.outcome).toBe("linked"); if (r2.outcome === "linked") { expect(r2.contactId).toBe(ct.id); expect(r2.healed).toBe(1); }
    expect(await asOperator((c) => one<{ link_status: string; linked_by: string; kind: string }>(c, "select link_status, linked_by, kind from payments where company_id=$1 and whop_payment_id='P-ORP-2'", [companyId]))).toMatchObject({ link_status: "linked", linked_by: "heal", kind: "deposit" });
    await tick(fake, undefined, companyId);
    const runs = (await runsFor("payment-recorded")).filter((x) => x.contact_id === ct.id);
    expect(runs).toHaveLength(2);
    // both runs start in one transaction and share started_at, so never rely on their order: sort by what each one knows
    const facts = runs.map((r) => r.context.event as { prior_total: number; running_total: number; linked_by: string; kind: string }).sort((a, b) => a.prior_total - b.prior_total);
    expect(facts).toEqual([expect.objectContaining({ prior_total: 0, running_total: 1000, linked_by: "heal", kind: "deposit" }), expect.objectContaining({ prior_total: 1000, running_total: 2000, linked_by: "email", kind: "installment" })]);
  });

  // ---- 9: phone formats ----

  it("a phone with parentheses, dashes, spaces or +1 resolves to the same person in a booking; a payment matches on the last ten digits", async () => {
    inCrm("FM1", { firstName: "Form", lastName: "At", email: "fm1@x.com", phone: "+16025550901" });
    await poll();
    const ct = (await contactByGhl("FM1"))!;
    const forms = ["(602) 555-0901", "602-555-0901", "+1 602 555 0901", "+1 (602) 555-0901", "602.555.0901"];
    for (const [i, phone] of forms.entries()) {
      await book(snap(`AP-FM1-${i}`, { contactId: undefined, assignedUserId: undefined, assignedUserEmail: "sam@x.com", invitee: { phone, firstName: "Form" } }));
      expect(await asOperator((c) => one<{ contact_id: string }>(c, "select contact_id from appointments where company_id=$1 and external_id=$2", [companyId, `AP-FM1-${i}`]))).toMatchObject({ contact_id: ct.id });
    }
    expect((await identifiers(ct.id)).filter((x) => x.kind === "phone")).toEqual([{ kind: "phone", value: "+16025550901" }]);   // one normalised number, not six
    const p = await asOperator((c) => recordPayment(c, companyId, { providerPaymentId: "P-FM1", amount: 100, status: "succeeded", paidAt: new Date(), phone: "1-602-555-0901" }));
    expect(p.outcome).toBe("linked"); if (p.outcome === "linked") expect(p.contactId).toBe(ct.id);
  });

  it("a phone written with a leading 1 and no plus ('1-602-555-0901') is the same number (G19, fixed by D60)", async () => {
    const ct = (await contactByGhl("FM1"))!;
    await book(snap("AP-FM1-11", { contactId: undefined, assignedUserId: undefined, assignedUserEmail: "sam@x.com", invitee: { phone: "1-602-555-0901", firstName: "Form" } }));
    expect(await asOperator((c) => one<{ contact_id: string }>(c, "select contact_id from appointments where company_id=$1 and external_id='AP-FM1-11'", [companyId]))).toMatchObject({ contact_id: ct.id });
    expect(await asOperator((c) => many(c, "select 1 from contact_identifiers where company_id=$1 and kind='phone' and value in ('16025550901','+16025550901')", [companyId]))).toHaveLength(1);
  });

  // ---- 10: time zones ----

  it("a contact with no time zone in the CRM takes the company's; the sends go out", async () => {
    inCrm("TZ1", { firstName: "No", lastName: "Zone", email: "tz1@x.com", phone: "+16025551001" });
    await poll(); const n = sent.length; await tick(fake, undefined, companyId);
    const ct = (await contactByGhl("TZ1"))!;
    expect(ct).toMatchObject({ timezone: TZ, timezone_source: "company_default" });
    expect(sent.slice(n).filter((s) => s.to === "TZ1").map((s) => s.kind).sort()).toEqual(["email", "sms"]);
    expect(await runOf("speed-to-lead", ct.id)).toMatchObject({ status: "waiting", current_node: "n3" });
  });

  it("a contact whose CRM time zone is garbage takes the company's zone, as a contact with none does; the sends go out and nothing throws (G20, fixed by D60)", async () => {
    inCrm("TZ2", { firstName: "Bad", lastName: "Zone", email: "tz2@x.com", phone: "+16025551002", timezone: "Mars/Olympus_Mons" });
    await poll(); const n = sent.length; await tick(fake, undefined, companyId);
    const ct = (await contactByGhl("TZ2"))!;
    expect(ct).toMatchObject({ timezone: TZ, timezone_source: "company_default" });
    const stl = await runOf("speed-to-lead", ct.id);
    expect(stl.status).not.toBe("failed");
    expect(sent.slice(n).filter((s) => s.to === "TZ2").map((s) => s.kind).sort()).toEqual(["email", "sms"]);
    expect(stl).toMatchObject({ status: "waiting", current_node: "n3" });
  });

  // ---- 11: deleted in the CRM while parked ----

  it("a contact deleted in the CRM while a run is parked: the CRM's 'not found' at the next send marks the replica and raises one alert; the run exits moot at its next look instead of failing (G21, fixed by D60)", async () => {
    inCrm("DEL1", { firstName: "Gone", lastName: "Soon", email: "del1@x.com", phone: "+16025551101" });
    await poll(); await tick(fake, undefined, companyId);
    const ct = (await contactByGhl("DEL1"))!;
    const stl = await runOf("speed-to-lead", ct.id); expect(stl).toMatchObject({ status: "waiting", current_node: "n3" });
    crm.delete("DEL1");   // merged away or deleted in the CRM; contactsChangedSince never reports it
    await expireReplyWait(stl.id, "n3"); await tick(fake, undefined, companyId);
    // the send the CRM refused is on the ledger as failed with its words; the replica knows; the run was not failed
    const mid = await runOf("speed-to-lead", ct.id);
    expect(mid).toMatchObject({ status: "waiting", current_node: "n5" });
    expect((await sends(stl.id)).find((s) => s.channel === "email" && s.status === "failed")).toMatchObject({ error: expect.stringMatching(/not found/) });
    expect(await asOperator((c) => one<{ gone_at: Date | null }>(c, "select gone_at from contacts where id=$1", [ct.id]))).toMatchObject({ gone_at: expect.any(Date) });
    const alerts = await asOperator((c) => many<{ key: string; level: string }>(c, "select key, level from alerts where company_id=$1 and key=$2 and resolved_at is null", [companyId, `contact:gone:${ct.id}`]));
    expect(alerts).toEqual([{ key: `contact:gone:${ct.id}`, level: "warning" }]);
    await tick(fake, undefined, companyId);   // its next look: the premise says the contact is gone
    const after = await runOf("speed-to-lead", ct.id);
    expect(after.status).toBe("exited");
    expect(after.exit_reason).toBe("moot: contact gone");
    expect(sent.filter((s) => s.to === "DEL1" && s.kind === "email")).toHaveLength(1);   // the first email, before the deletion; nothing after
  });

  // ---- 12: a team member's own test contact ----

  it("a team member's test contact (the closer's email, tagged sys-test) is a contact like any other in live mode; the plain sys-test tag starts nothing; in test mode it is exactly what lets them through", async () => {
    inCrm("TM1", { firstName: "Sam", lastName: "Closer", email: "sam@x.com", phone: "+16025551201", tags: ["sys-test"] });
    await poll(); const n = sent.length; await tick(fake, undefined, companyId);
    const ct = (await contactByGhl("TM1"))!;
    expect((await slugsFor(ct.id)).map((r) => r.slug)).toEqual(["new-lead", "speed-to-lead"]);   // the tag.added for sys-test started nothing
    expect(await cardNames(ct.id)).toEqual([{ name: "Sam Closer -- New" }]);
    expect(sent.slice(n).filter((s) => s.to === "TM1").map((s) => s.kind).sort()).toEqual(["email", "sms"]);
    const cher = (await contactByGhl("NP1"))!;
    expect(await asOperator((c) => contactPasses(c, companyId, ct.id, "test", {}))).toEqual({ ok: true });
    expect(await asOperator((c) => contactPasses(c, companyId, cher.id, "test", {}))).toMatchObject({ ok: false });
    expect(await asOperator((c) => contactPasses(c, companyId, cher.id, "live", {}))).toEqual({ ok: true });
  });
});
