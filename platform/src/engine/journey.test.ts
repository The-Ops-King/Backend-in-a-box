/**
 * One contact's whole journey through the real templates: new lead → setter call → booked → confirmed → reminders → showed
 * (recording) → EOD filed → deposit → agreement → signed (deal closed) → paid in full; then the side roads a sales-ops
 * operator worries about (a call booked five hours out, a texted cancel, a show the closer filed with no recording, a
 * no-show who rebooks). The catalogue is engine/06-journey-sweep.md; every `it.fails` here is a Finding there: the test
 * states the behaviour the operator expects, the engine does something else today, and the title says where. The
 * findings D59 fixed (F1, F3, F4, F7, F8's recovery half, F10, F11, F13) are plain `it` now and say so.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { installCompany } from "@/engine/install";
import { emitEvent, dispatchEvent } from "@/engine/dispatch";
import { applyAppointment } from "@/engine/poll";
import { applyPayment } from "@/engine/lifecycle";
import { recordDisposition } from "@/engine/disposition";
import { loadCompany } from "@/engine/context";
import { tick } from "@/engine/runner";
import { fakeAdapters, fakeProbes } from "@/engine/test-install";
import { recordRecording, recordPhoneCall, settlePhoneCall, phoneFacts, type RecordingInput } from "@/engine/recordings";
import { simulate } from "@/engine/simulate";
import { reactionArrived } from "@/engine/webhooks/slack";
import { templates } from "@/templates";
import type { Adapters, AppointmentSnapshot, Classification, LiveCard } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";

// what the fakes record
const sent: { kind: string; to: string; body: string }[] = [];
const tags: string[] = [];
const removedTags: string[] = [];
const oppWrites: Record<string, unknown>[] = [];
const contactWrites: Record<string, unknown>[] = [];
const tasks: Record<string, unknown>[] = [];
const recordWrites: Record<string, unknown>[] = [];
const docSends: { templateId: string; contactId: string; userId?: string }[] = [];
const posts: { channel: string; text: string; threadTs?: string; as?: { name?: string } }[] = [];
const reactions: { channel: string; ts: string; emoji: string }[] = [];
const apptStore = new Map<string, AppointmentSnapshot>();   // what the booking source "has"
const liveCards = new Map<string, LiveCard[]>();            // what the CRM "has" for a contact (D41)
let replyIntent = "confirmed";
const base = fakeAdapters();
const fake: Adapters = {
  ...base,
  read: { ...base.read, openCards: async (_c, id) => liveCards.get(id) ?? [], listUsers: async () => [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }], getContact: async (_c, id) => ({ id, firstName: id, tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() }) },
  booking: (() => { const b = { appointmentsInWindow: async () => [], listCalendars: async () => [{ id: "CAL", name: "Closer Call", teamMemberIds: ["U1"] }], getAppointment: async (_c: unknown, id: string) => apptStore.get(id) ?? null }; return { ghl: b, calendly: b }; })(),
  write: { ...base.write, addTag: async (_c, _id, t) => { tags.push(t); }, removeTag: async (_c, _id, t) => { removedTags.push(t); }, updateContact: async (_c, id, patch) => { contactWrites.push({ id, ...patch }); },
    createTask: async (_c, id, task) => { tasks.push({ contactId: id, ...task }); return { id: `task-${tasks.length}` }; },
    createOpportunity: async (_c, input) => { oppWrites.push({ op: "create", ...input }); return { id: `ghl-opp-${oppWrites.length}` }; }, updateOpportunity: async (_c, id, patch) => { oppWrites.push({ op: "update", id, ...patch }); },
    createRecord: async (_c, _o, props) => { recordWrites.push({ op: "create", ...props }); return { id: `rec-${recordWrites.length}` }; }, updateRecord: async (_c, _o, id, props) => { recordWrites.push({ op: "update", id, ...props }); },
    sendDocumentTemplate: async (_c, input) => { docSends.push(input); return { id: `doc-${docSends.length}` }; } },
  sender: { ...base.sender, sendSms: async (_c, to, body) => { sent.push({ kind: "sms", to, body }); return { externalId: `s${sent.length}`, accepted: true }; }, sendEmail: async (_c, to, subject, html) => { sent.push({ kind: "email", to, body: `${subject}|${html}` }); return { externalId: `e${sent.length}`, accepted: true }; } },
  classifier: { choice: async (_s, _input, options): Promise<Classification> => { const value = options.includes("setting") ? "setting" : options.includes("sales_call") ? "sales_call" : options.includes("closed_won") ? "closed_won" : replyIntent; return { value, confidence: 0.95, distribution: { [value]: 0.95 }, unclear: false }; } },
  notifier: { ...base.notifier, post: async (_t, channel, text, as, threadTs) => { posts.push({ channel, text, threadTs, as }); return { ts: `ts${posts.length}` }; }, react: async (_t, channel, ts, emoji) => { reactions.push({ channel, ts, emoji }); return true; } },
  analyst: { analyze: async (_k, req) => { const parsed = /setter phone calls/.test(req.system) ? { digest: "Thinning for a year; took Thursday.", pains: "a year of thinning", goals: "keep it", fit_quality: 8 }
    : { notes: { summary: "Decided to start.", pain: ["crown"], objections: [], disposition: "closed_won", primary_objection: "price", next_step: "onboarding" }, rubric: { overall_score: 8, scores: {}, strengths: [], misses: [], coaching: [] } };
    return { text: JSON.stringify(parsed), parsed, model: "fake", usage: { input: 1, output: 1, cacheRead: 0 } }; } },
};

const CRM = { pipeline_setter: "PIPE-SETTER", pipeline_closer: "PIPE-CLOSER", stage_setter_new_lead: "STAGE-NEW", stage_setter_direct_booked: "STAGE-DIRECT", stage_setter_appointment_set: "STAGE-SET", stage_setter_showed: "STAGE-SHOWED", stage_setter_cancelled: "STAGE-S-CANCEL",
  stage_closer_scheduled: "STAGE-SCHED", stage_closer_agreement_sent: "STAGE-AGREE", stage_closer_closed_won: "STAGE-WON", stage_closer_cancelled: "STAGE-C-CANCEL",
  field_opportunity_stage_entered: "CF-STAGE-DATE", field_opportunity_setter_owner: "CF-SETTER-OWNER", field_contact_appointment_date: "CF-APPT-DATE", field_contact_setter: "CF-SETTER", field_contact_cash_collected: "CF-CASH", field_contact_revenue_generated: "CF-REV",
  assoc_discovery_call_contact: "ASSOC-DC", assoc_sales_call_contact: "ASSOC-SC", assoc_sales_call_opportunity: "ASSOC-SO", assoc_payment_contact: "ASSOC-PC", assoc_payment_opportunity: "ASSOC-PO", agreement_template: "TPL-AGREE", agreement_sender: "U1", default_closer: "U1" };
const SLACK = { bookings: "CBOOK", calls: "CCALLS", deals: "CDEALS", payments: "CPAY", alerts: "CALERTS", setter_calls: "CSET", eod: "CEOD", reports: "CREP" };
const TABLES = ["alerts", "eod_reports", "slack_posts", "agreements", "sends", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
let companyId: string;

type Run = { id: string; status: string; current_node: string | null; exit_reason: string | null; next_run_at: Date | null; contact_id: string | null; appointment_id: string | null };
type Card = { pipeline: string; stage: string; name: string; status: string };
const runsFor = (slug: string, contactId?: string) => asOperator((c) => many<Run>(c, "select r.id, r.status, r.current_node, r.exit_reason, r.next_run_at, r.contact_id, r.appointment_id from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug=$2 and ($3::uuid is null or r.contact_id=$3) order by r.started_at, r.id", [companyId, slug, contactId ?? null]));
const lastRun = async (slug: string, contactId: string) => (await runsFor(slug, contactId)).at(-1)!;
const stepsOf = (runId: string) => asOperator((c) => many<{ node_id: string; status: string; result: Record<string, unknown> }>(c, "select node_id, status, result from run_steps where run_id=$1 order by started_at, id", [runId]));
const stepStatus = async (runId: string, nodeIds: string[]) => Object.fromEntries((await stepsOf(runId)).filter((s) => nodeIds.includes(s.node_id)).map((s) => [s.node_id, s.status]));
const cardsOf = (contactId: string) => asOperator((c) => many<Card>(c, "select ghl_pipeline_id as pipeline, ghl_stage_id as stage, name, status from pipeline_cards where company_id=$1 and contact_id=$2 order by ghl_pipeline_id", [companyId, contactId]));
const cardOn = async (contactId: string, pipeline: string) => (await cardsOf(contactId)).find((k) => k.pipeline === pipeline);
const tagsOf = (contactId: string) => asOperator(async (c) => [...(await one<{ tags: string[] }>(c, "select tags from contacts where id=$1", [contactId]))!.tags].sort());
const apptRow = (contactId: string) => asOperator((c) => one<{ id: string; status: string; outcome: string | null; call_outcome: string | null; external_id: string }>(c, "select a.id, a.status, ot.category as outcome, cot.category as call_outcome, a.external_id from appointments a left join company_terms ot on ot.id=a.outcome_term left join company_terms cot on cot.id=a.call_outcome_term where a.company_id=$1 and a.contact_id=$2 order by a.booked_at desc, a.created_at desc limit 1", [companyId, contactId]));
const postTs = (tag: string) => asOperator(async (c) => (await one<{ ts: string }>(c, "select ts from slack_posts where company_id=$1 and tag=$2", [companyId, tag]))?.ts);
const reactionsOn = (ts: string) => reactions.filter((r) => r.ts === ts).map((r) => r.emoji);
const threadOf = (ts: string) => posts.filter((p) => p.threadTs === ts).map((p) => p.text);
const wake = (runId: string) => asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [runId]));
const inbound = (contactId: string, body: string) => asOperator((c) => c.query("insert into messages (company_id, contact_id, ghl_message_id, channel, direction, body, occurred_at) values ($1,$2,$3,'sms','inbound',$4,now())", [companyId, contactId, `m${Math.random()}`, body]));
const term = (domain: string, category: string) => asOperator(async (c) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain=$2 and category=$3", [companyId, domain, category]))!.id);
const closerUser = () => asOperator(async (c) => (await one<{ id: string }>(c, "select id from users where company_id=$1 and ghl_user_id='U1'", [companyId]))!.id);
/** The engine's clock for one tick: due-ness is the database's now(), so a parked run is woken by hand and `now` carries what the steps believe the time is. */
const tickAt = (now: DateTime) => tick(fake, now as DateTime<true>, companyId, fakeProbes);
const newContact = (ghlId: string, first: string, last: string, email: string, phone: string) => asOperator(async (c) => {
  const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone, ghl_fields) values ($1,$2,$3,$4,$5,$6) returning id", [companyId, ghlId, first, last, TZ, JSON.stringify({})]))!.id;
  await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3),($1,$2,'phone',$4)", [companyId, id, email, phone]);
  return id;
});
const leadCreated = (contactId: string) => asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: {} }), { contact: { id: contactId } }));
const snap = (id: string, ghlContact: string, start: DateTime, over: Partial<AppointmentSnapshot> = {}): AppointmentSnapshot => ({ id, calendarId: "CAL", contactId: ghlContact, assignedUserId: "U1", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), raw: {}, ...over });
const book = async (s: AppointmentSnapshot) => { apptStore.set(s.id, s); await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, s); }); };
const pay = (contactId: string, paymentId: string, amount: number) => asOperator(async (c) => { const ev = await applyPayment(c, companyId, contactId, { whopPaymentId: paymentId, amount, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); return dispatchEvent(c, ev, { contact: { id: contactId } }); });
const file = async (appointmentId: string, outcome: "showed" | "noshow", callOutcome?: "closed" | "follow_up" | "lost") =>
  asOperator(async (c) => recordDisposition(c, { companyId, appointmentId, outcomeTermId: await term("appointment_outcome", outcome), callOutcomeTermId: callOutcome ? await term("call_outcome", callOutcome) : null, notes: "filed on the end-of-day form", userId: await closerUser() }));
const daysOut = (d: number, hour = 14) => DateTime.now().setZone(TZ).plus({ days: d }).set({ hour, minute: 0, second: 0, millisecond: 0 });

describe.skipIf(!HAS_DB)("journey sweep", () => {
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='journey'"); if (!co) return;
      await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
      await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
      await c.query("update appointments set disposition_id=null where company_id=$1", [co.id]);
      for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
      await c.query("delete from companies where id=$1", [co.id]);
    });
    const r = await installCompany({ name: "Journey", slug: "journey", timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, setterRule: "question", closers: ["sam@x.com"], enable: true, crm: CRM, slack: SLACK, anthropicKey: "sk-fake", contractValueDefault: 2999 }, fake);
    await asOperator((c) => c.query("update companies set mode='live' where id=$1", [r.companyId]));   // D56: install cannot reach live without Slack; this journey asserts behaviour with Slack unbound
    companyId = r.companyId;
    expect(r.installed.filter((s) => s.endsWith("enabled"))).toHaveLength(templates.length);
    await asOperator(async (c) => {
      await c.query("update companies set send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, channels) values ($1,'T1',$2,'UBOT','{}')", [companyId, encrypt("xoxb-fake")]);
    });
  });

  // ---- the happy path: Jordan Vale, setter-booked, confirms by text, shows, pays a deposit, signs, pays the balance ----
  describe("happy path: Jordan Vale, lead to paid in full", () => {
    let jordan: string, appt: string, bookingTs: string, reviewTs: string;
    const T0 = DateTime.now();
    const A = daysOut(4, 14);   // the call: four days out at 2pm, their time

    it("lead created: setter card at New Lead named '-- New', stat-new; speed-to-lead's email and text go; no closer card yet", async () => {
      jordan = await newContact("JV1", "Jordan", "Vale", "jv@x.com", "+16025550101");
      expect(await leadCreated(jordan)).toHaveLength(2);   // new-lead + speed-to-lead
      await tickAt(T0);
      expect(await lastRun("new-lead", jordan)).toMatchObject({ status: "completed", exit_reason: "done" });
      expect(await cardsOf(jordan)).toEqual([{ pipeline: "PIPE-SETTER", stage: "STAGE-NEW", name: "Jordan Vale -- New", status: "open" }]);
      expect(await tagsOf(jordan)).toEqual(["stat-new"]);
      expect(sent.filter((s) => s.to === "JV1").map((s) => s.kind).sort()).toEqual(["email", "sms"]);
      expect(await lastRun("speed-to-lead", jordan)).toMatchObject({ status: "waiting", current_node: "n3" });
    });

    it("setter call logged: a connected 3-minute dial with a transcript, read 15 minutes after it ended → Discovery Call record linked, note, Slack; nothing moves on the cards", async () => {
      const nRec = recordWrites.length, nCards = JSON.stringify(await cardsOf(jordan));
      await asOperator(async (c) => {
        const { recording } = await recordPhoneCall(c, companyId, { externalId: "dial-1", contactId: jordan, startedAt: T0.minus({ minutes: 25 }).toJSDate(), durationSec: 184, direction: "outbound", status: "completed", callerGhlUserId: "U1" });
        const { recording: row, event } = await settlePhoneCall(c, recording, { transcript: [{ speaker: "0", text: "Hey Jordan, two minutes?" }, { speaker: "1", text: "Sure, it has been thinning for a year." }] });
        await dispatchEvent(c, event!, { contact: { id: jordan }, recording: { id: row.id, ...phoneFacts(row) } });
      });
      await tickAt(T0); await tickAt(T0);
      expect(await lastRun("setter-call-logged", jordan)).toMatchObject({ status: "completed", exit_reason: "posted" });
      expect(recordWrites.slice(nRec)).toEqual([expect.objectContaining({ op: "create", external_id: "dial-1", contact_id: "JV1", setter: "Sam Closer" })]);
      expect(posts.filter((p) => p.channel === "CSET").at(-1)?.text).toContain("No booking yet");
      expect(JSON.stringify(await cardsOf(jordan))).toBe(nCards);
    });

    it("setter books the call: setter card → Appointment Set '-- Set', closer card created at Scheduled '-- Setter Booked', stat-booked + stat-set + meta booked call, nurture tags off, date + setter on the contact, video task, Sales Call record, booking post; pre-call sends the booking email and text and waits for a reply", async () => {
      const nTags = tags.length, nRm = removedTags.length, nSent = sent.length, nTasks = tasks.length;
      await book(snap("A-JV", "JV1", A, { setBy: "Luis", tracking: { utm_source: "meta" } }));
      await tickAt(T0);
      expect(await lastRun("call-booked", jordan)).toMatchObject({ status: "completed", exit_reason: "booked" });
      appt = (await apptRow(jordan))!.id;
      expect(await cardsOf(jordan)).toEqual([
        { pipeline: "PIPE-CLOSER", stage: "STAGE-SCHED", name: "Jordan Vale -- Setter Booked", status: "open" },
        { pipeline: "PIPE-SETTER", stage: "STAGE-SET", name: "Jordan Vale -- Set", status: "open" },
      ]);
      expect(tags.slice(nTags)).toEqual(["stat-booked", "stat-set", "meta booked call"]);
      expect(removedTags.slice(nRm)).toEqual(["seq-no-show", "seq-nurture", "seq-winback", "opt-in lead"]);   // removed; nothing in any template ever adds them
      expect(await tagsOf(jordan)).toEqual(["meta booked call", "stat-booked", "stat-new", "stat-set"]);
      expect(contactWrites.filter((w) => w.id === "JV1").map((w) => w.customFields)).toEqual([[{ id: "CF-APPT-DATE", field_value: A.toFormat("yyyy-MM-dd") }], [{ id: "CF-SETTER", field_value: "Luis" }]]);
      expect(tasks.slice(nTasks)).toEqual([expect.objectContaining({ contactId: "JV1", title: "Send Jordan a personalized video", assignedUserId: "U1" })]);
      expect(recordWrites.at(-1)).toMatchObject({ op: "create", external_id: "A-JV", outcome: "scheduled", setter: "Luis" });
      bookingTs = (await postTs(`appointment:${appt}`))!;
      expect(bookingTs).toBeTruthy();
      expect(posts.find((p) => p.channel === "CBOOK" && !p.threadTs && /Jordan Vale/.test(p.text))?.text).toMatch(/\*Setter:\* Luis[\s\S]*meta · setter booked/);
      // the prospect: booking email + text, then the 4-hour reply wait
      expect(sent.slice(nSent).map((s) => s.kind)).toEqual(["email", "sms"]);
      expect(await lastRun("pre-call-sequence", jordan)).toMatchObject({ status: "waiting", current_node: "w1" });
    });

    it("speed-to-lead's 2-hour silence ends at the calendar: the lead booked an hour ago, so the check before the nudge exits the run `booked` and nothing more is sent (F3, D59)", async () => {
      const r = await lastRun("speed-to-lead", jordan);
      expect(r).toMatchObject({ status: "waiting", current_node: "n3" });
      const nSent = sent.length;
      await wake(r.id); await tickAt(T0.plus({ hours: 2, minutes: 1 }));
      expect(await lastRun("speed-to-lead", jordan)).toMatchObject({ status: "completed", exit_reason: "booked" });
      expect(await stepStatus(r.id, ["c1", "n5"])).toEqual({ c1: "ok" });   // the check ran; n5 never did
      expect(sent.length).toBe(nSent);
    });
    it("F3 (fixed, D59): a lead who books inside speed-to-lead's 2 hours does not get 'Still want to talk?'", async () => {
      expect(sent.filter((s) => s.to === "JV1" && /^Still want to talk/.test(s.body))).toHaveLength(0);
    });

    it("the prospect texts 'yes': stat-confirmed on (stat-unconfirmed removed though never set), ✅ on the booking post with the quote in its thread, the run parks on the 3-day reminder", async () => {
      const r = await lastRun("pre-call-sequence", jordan);
      await inbound(jordan, "yes see you then"); await wake(r.id);
      const nTags = tags.length, nRm = removedTags.length;
      await tickAt(T0.plus({ minutes: 3 }));   // past the 90 s settle window (D47)
      expect(await lastRun("pre-call-sequence", jordan)).toMatchObject({ status: "waiting", current_node: "r72" });
      expect(tags.slice(nTags)).toEqual(["stat-confirmed"]); expect(removedTags.slice(nRm)).toEqual(["stat-unconfirmed"]);
      expect(reactionsOn(bookingTs)).toEqual(["white_check_mark"]);
      expect(threadOf(bookingTs)).toEqual([expect.stringMatching(/^✅ Jordan's call .* is confirmed\.\n> yes see you then$/)]);
    });

    it("the reminders land at their times: 3 days, 2 days, 24h (text + email), the morning-of text at 8am for a 2pm call (F10, D59), 1 hour, 10 minutes; then the sequence is done", async () => {
      const r = await lastRun("pre-call-sequence", jordan);
      const step = async (now: DateTime, node: string, kinds: string[]) => { const n = sent.length; await wake(r.id); await tickAt(now); expect(sent.slice(n).map((s) => s.kind)).toEqual(kinds); expect((await lastRun("pre-call-sequence", jordan)).current_node).toBe(node); };
      await step(A.minus({ hours: 72 }).plus({ minutes: 1 }), "r48", ["sms"]);
      await step(A.minus({ hours: 48 }).plus({ minutes: 1 }), "r24", ["sms"]);
      await step(A.minus({ hours: 24 }).plus({ minutes: 1 }), "rm", ["email", "sms"]);
      await step(A.set({ hour: 8 }).plus({ minutes: 1 }), "r1", ["sms"]);   // bm → mm: 14 ≥ 11, the morning-of text goes
      expect((await stepsOf(r.id)).find((s) => s.node_id === "bm")?.result).toEqual({ edge: "mm" });
      await step(A.minus({ hours: 1 }).plus({ minutes: 1 }), "r10", ["sms"]);
      await step(A.minus({ minutes: 9 }), "x_done", ["sms"]);
      expect(await lastRun("pre-call-sequence", jordan)).toMatchObject({ status: "completed", exit_reason: "done" });
      expect(sent.filter((s) => s.to === "JV1").length).toBe(2 + 2 + 7);   // speed-to-lead's two (no nudge: they booked); the booking two; seven reminders (3d, 2d, 24h text + email, morning-of, 1h, 10m)
    });
    it("F10 (fixed, D59): a 2pm call gets the morning-of text at 8am; pre-call's bm compares '{{appointment.starts_at | date:HH}}' to 11, and operand() now renders a reference with a filter instead of comparing the literal string", async () => {
      const r = await lastRun("pre-call-sequence", jordan);
      expect(await stepStatus(r.id, ["mm"])).toEqual({ mm: "ok" });
      expect(sent.filter((s) => s.to === "JV1" && s.body === "[placeholder — morning-of text]")).toHaveLength(1);
    });

    it("call day, the recording lands: showed recorded (call.held), stat-showed, setter card → Showed and won, ✅ (already there) + thread line on the booking post, the review in the calls channel with its scorecard, Sales Call record updated; the closer card does not move", async () => {
      const nTags = tags.length, nOpp = oppWrites.length;
      const rec: RecordingInput = { externalId: "fathom-jv", title: "Jordan Vale and Sam Closer", startedAt: A.plus({ minutes: 2 }).toJSDate(), durationMin: 41, shareUrl: "https://fathom.video/share/jv", recordedBy: { name: "Sam Closer", email: "sam@x.com" },
        invitees: [{ name: "Sam Closer", email: "sam@x.com", isExternal: false }, { name: "Jordan Vale", email: "jv@x.com", isExternal: true }], transcript: [{ speaker: "Jordan Vale", text: "Let's do it." }] };
      const r = await asOperator((c) => recordRecording(c, companyId, rec));
      expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
      expect(r.appointmentId).toBe(appt);
      await asOperator((c) => dispatchEvent(c, r.event, { contact: { id: jordan }, appointment: { id: appt } }));
      await tickAt(A.plus({ hours: 1 }));
      expect(await lastRun("call-recorded", jordan)).toMatchObject({ status: "completed", exit_reason: "recorded" });
      expect((await apptRow(jordan))!.outcome).toBe("showed");
      expect(tags.slice(nTags)).toEqual(["stat-showed"]);
      expect(oppWrites.slice(nOpp)).toEqual([expect.objectContaining({ op: "update", stageId: "STAGE-SHOWED", status: "won" })]);
      expect(await cardOn(jordan, "PIPE-SETTER")).toMatchObject({ stage: "STAGE-SHOWED", status: "won" });
      expect(await cardOn(jordan, "PIPE-CLOSER")).toMatchObject({ stage: "STAGE-SCHED", status: "open" });   // nothing in any template moves the closer card on a show
      expect(reactionsOn(bookingTs)).toEqual(["white_check_mark", "white_check_mark"]);   // the second is Slack's already_reacted in life
      expect(threadOf(bookingTs).at(-1)).toMatch(/^✅ Showed · 41 min with Sam Closer/);
      reviewTs = (await postTs(`recording:${r.recording.id}`))!; expect(reviewTs).toBeTruthy();
      expect(threadOf(reviewTs)).toEqual([expect.stringMatching(/^\*Scorecard:\* 8\/10/)]);
      expect(recordWrites.at(-1)).toMatchObject({ op: "update", external_id: "A-JV", outcome: "showed", disposition: "closed_won" });
      expect(await runsFor("post-call-follow-up", jordan)).toHaveLength(0);   // the engine's call.held carries no call outcome
    });
    it.fails("F6: the closer card should leave Scheduled when the call shows; the only closer stages any template knows are Scheduled, Agreement Sent, Closed - Won and Cancelled, so a show, a no-show, a loss or a follow-up leaves it where booking put it", async () => {
      expect((await cardOn(jordan, "PIPE-CLOSER"))!.stage).not.toBe("STAGE-SCHED");
    });

    it("end of day, the closer files 'showed, closed': Call outcome filed adds stat-closed-won, ✅ ensured, a second thread line, the Sales Call record says showed / closed_won (F7, D59); it writes no card", async () => {
      const nTags = tags.length, nOpp = oppWrites.length, nRec = recordWrites.length;
      await file(appt, "showed", "closed");
      await tickAt(A.plus({ hours: 5 }));
      expect(await lastRun("call-outcome", jordan)).toMatchObject({ status: "completed", exit_reason: "noted" });
      expect(tags.slice(nTags)).toEqual(["stat-showed", "stat-closed-won"]);
      expect(threadOf(bookingTs).at(-1)).toBe("✅ Showed, per Sam Closer: closed.");
      expect(oppWrites.length).toBe(nOpp);
      expect(recordWrites.slice(nRec)).toEqual([{ op: "update", id: expect.any(String), external_id: "A-JV", outcome: "showed", disposition: "closed_won" }]);
      expect((await apptRow(jordan))!.call_outcome).toBe("closed");
    });

    it("the deposit: cash collected and revenue stamped, pay-plan-active, the agreement goes out and stat-agreement-sent, closer card → Agreement Sent, Payment record linked, 💵 on the booking post and the review, the chase and the close gate start", async () => {
      const nTags = tags.length, nDocs = docSends.length, nSent = sent.length;
      expect(await pay(jordan, "pay-jv-1", 1500)).toHaveLength(3);   // payment-recorded, deal-closed (gate), agreement-chase
      await tickAt(A.plus({ hours: 6 }));
      expect(await lastRun("payment-recorded", jordan)).toMatchObject({ status: "completed", exit_reason: "recorded" });
      expect(contactWrites.filter((w) => w.id === "JV1").slice(-2).map((w) => w.customFields)).toEqual([[{ id: "CF-CASH", field_value: "1500" }], [{ id: "CF-REV", field_value: "2999" }]]);
      expect(tags.slice(nTags)).toEqual(["pay-plan-active", "stat-agreement-sent"]);
      expect(docSends.slice(nDocs)).toEqual([{ templateId: "TPL-AGREE", contactId: "JV1", userId: "U1" }]);
      expect(await cardOn(jordan, "PIPE-CLOSER")).toMatchObject({ stage: "STAGE-AGREE", status: "open" });
      expect(recordWrites.filter((w) => w.transaction_id === "pay-jv-1")).toEqual([expect.objectContaining({ op: "create", amount: 1500, type: "deposit", closer: "Sam Closer", setter: "Luis" })]);
      expect(recordWrites.at(-1)).toMatchObject({ op: "update", cash_collected: "1500" });   // the Sales Call record
      expect(sent.length).toBe(nSent);   // nothing to the customer from here (D54)
      expect(reactionsOn(bookingTs).at(-1)).toBe("dollar"); expect(reactionsOn(reviewTs)).toEqual(["dollar"]);
      expect(threadOf(bookingTs).at(-1)).toBe("💵 Paid $1,500 · deposit. Details in the payments channel.");   // F13 (D59)
      expect(await lastRun("deal-closed", jordan)).toMatchObject({ status: "completed", exit_reason: "not_yet" });
      expect(await lastRun("agreement-chase", jordan)).toMatchObject({ status: "waiting", current_node: "w1" });
    });

    it("the signature: stat-agreement-signed and the deals post; Deal closed runs for real: stat-customer, closer card → Closed - Won (won), welcome email + text, NEW CLOSE post; the chase sees it and ends; nothing lands on the booking post", async () => {
      const nTags = tags.length, nSent = sent.length, nReact = reactions.length;
      const signed = await asOperator((c) => simulate({ c, company: { id: companyId, mode: "live", timezone: TZ } as never, contactId: jordan, force: true }, "sign"));
      expect(signed).toMatchObject({ ok: true, detail: { events: ["agreement.signed"] } });
      await tickAt(A.plus({ hours: 7 })); await tickAt(A.plus({ hours: 7 }));
      expect(await lastRun("agreement-signed", jordan)).toMatchObject({ status: "completed", exit_reason: "recorded" });
      expect(await lastRun("deal-closed", jordan)).toMatchObject({ status: "completed", exit_reason: "closed" });
      expect(tags.slice(nTags).sort()).toEqual(["stat-agreement-signed", "stat-customer"]);
      expect(await cardOn(jordan, "PIPE-CLOSER")).toMatchObject({ stage: "STAGE-WON", status: "won" });
      expect(await cardOn(jordan, "PIPE-SETTER")).toMatchObject({ stage: "STAGE-SHOWED", status: "won" });
      expect(sent.slice(nSent).map((s) => s.kind)).toEqual(["email", "sms"]); expect(sent.slice(nSent)[0].body).toContain("Welcome — Let's Get You Ready");
      expect(posts.filter((p) => p.channel === "CDEALS").map((p) => p.text.split("\n")[0]).sort()).toEqual(["*Agreement signed:*", "*NEW CLOSE!* Well done Sam Closer!"]);   // two runs in one tick: order is the heap's
      expect(reactions.length).toBe(nReact);   // the close is silent on the booking post and the review
      expect(recordWrites.at(-1)).toMatchObject({ op: "update", disposition: "closed_won", outcome: "showed", cash_collected: "1500" });
      const chase = await lastRun("agreement-chase", jordan);
      await asOperator((c) => c.query("update runs set next_run_at=now(), context = jsonb_set(context, '{vars,__wait,w1,until}', to_jsonb($2::text), true) where id=$1", [chase.id, A.plus({ hours: 7 }).toISO()]));
      await tickAt(A.plus({ days: 1, hours: 7 }));
      expect(await lastRun("agreement-chase", jordan)).toMatchObject({ status: "completed", exit_reason: "signed" });
      expect(tasks.filter((t) => /Chase the unsigned/.test(String(t.title)) && t.contactId === "JV1")).toHaveLength(0);
    });

    it("paid in full: pay-paid-full on and pay-plan-active off, 💵 again; payment.paid_in_full is written to the ledger and nothing listens to it", async () => {
      const nTags = tags.length, nRm = removedTags.length;
      expect(await pay(jordan, "pay-jv-2", 1499)).toHaveLength(1);   // payment-recorded only: deal-closed and the chase already spent their once
      await tickAt(A.plus({ days: 30 }));
      expect(tags.slice(nTags)).toEqual(["pay-paid-full"]); expect(removedTags.slice(nRm)).toEqual(["pay-plan-active"]);
      expect(await tagsOf(jordan)).toEqual(["meta booked call", "pay-paid-full", "stat-agreement-sent", "stat-agreement-signed", "stat-booked", "stat-closed-won", "stat-confirmed", "stat-customer", "stat-new", "stat-set", "stat-showed"]);
      const pif = await asOperator((c) => many<{ id: number }>(c, "select id from events where company_id=$1 and contact_id=$2 and event_type='payment.paid_in_full'", [companyId, jordan]));
      expect(pif).toHaveLength(1);
      expect(await asOperator((c) => many(c, "select 1 from runs where company_id=$1 and triggered_by_event=$2", [companyId, pif[0].id]))).toHaveLength(0);
      expect(await cardOn(jordan, "PIPE-CLOSER")).toMatchObject({ stage: "STAGE-WON", status: "won" });
    });
    it.fails("F12: paid in full should close the loop (a fulfilment hand-off, a stage or a tag): no template listens to payment.paid_in_full (payments.ts dispatches it since D59 / F11, so a listener would start)", async () => {
      const pif = await asOperator((c) => one<{ id: number }>(c, "select id from events where company_id=$1 and contact_id=$2 and event_type='payment.paid_in_full'", [companyId, jordan]));
      expect(await asOperator((c) => many(c, "select 1 from runs where company_id=$1 and triggered_by_event=$2", [companyId, pif!.id]))).not.toHaveLength(0);
    });
  });

  // ---- a call booked five hours out ----
  describe("a call booked five hours out: what the prospect receives", () => {
    let kai: string, run: Run, bookingTs: string;
    const A = daysOut(1, 15);          // tomorrow 3pm, their time (so "the morning of" applies: the call is at 11am or later)
    const T0 = A.minus({ hours: 5 });  // booked at 10am the same day

    it("at booking: the day-one email and text go (both inside their min_lead), then the 4-hour reply wait holds the run", async () => {
      kai = await newContact("KAI1", "Kai", "Moreno", "kai@x.com", "+16025550102");
      const n = sent.length;
      await book(snap("A-KAI", "KAI1", A));
      await tickAt(T0);
      expect(sent.slice(n).filter((s) => s.to === "KAI1").map((s) => s.kind)).toEqual(["email", "sms"]);
      run = await lastRun("pre-call-sequence", kai);
      expect(run).toMatchObject({ status: "waiting", current_node: "w1" });
      bookingTs = (await postTs(`appointment:${run.appointment_id}`))!;
    });

    it("no reply by 2pm (one hour before the call): stat-unconfirmed and ⏳; the 3-day, 2-day and 24-hour messages are stale by then and skipped, the morning-of branch is taken (F10) but its text is stale too (G7); the 1-hour text goes at once; the 10-minute text at 2:50", async () => {
      const n = sent.length;
      await wake(run.id); await tickAt(A.minus({ minutes: 59 }));
      expect(tags.filter((t) => t === "stat-unconfirmed")).toHaveLength(1);
      expect(reactionsOn(bookingTs)).toEqual(["hourglass_flowing_sand"]);
      expect(await stepStatus(run.id, ["m72", "m48", "m24e", "m24s", "mm", "m1"])).toEqual({ m72: "stale", m48: "stale", m24e: "stale", m24s: "stale", mm: "stale", m1: "ok" });
      expect((await stepsOf(run.id)).find((s) => s.node_id === "bm")?.result).toEqual({ edge: "mm" });
      expect(sent.slice(n).map((s) => s.body)).toEqual(["[placeholder — 1-hour text]"]);
      expect(await lastRun("pre-call-sequence", kai)).toMatchObject({ status: "waiting", current_node: "r10" });
      await wake(run.id); await tickAt(A.minus({ minutes: 9 }));
      expect(sent.slice(n).map((s) => s.body)).toEqual(["[placeholder — 1-hour text]", "[placeholder — 10-minute text]"]);
      expect(await lastRun("pre-call-sequence", kai)).toMatchObject({ status: "completed", exit_reason: "done" });
      // what Kai received, in order: the booking email, the booking text, the 1-hour text, the 10-minute text
      expect(sent.filter((s) => s.to === "KAI1").map((s) => (s.kind === "email" ? "email:" + s.body.split("|")[0].slice(0, 13) : "sms:" + s.body))).toEqual(["email:You're booked", "sms:[placeholder — immediate text]", "sms:[placeholder — 1-hour text]", "sms:[placeholder — 10-minute text]"]);
    });
    it("F10 (fixed, D59): for a 3pm call the morning-of branch takes the mm edge; what stops the text here is the reply wait, not the branch", async () => {
      expect((await stepsOf(run.id)).find((s) => s.node_id === "bm")?.result).toEqual({ edge: "mm" });
    });
    it.fails("F5 (G7): the morning-of text was valid until 1pm and should have gone at booking; the 4-hour reply wait held the run until 2pm, past the text's 2-hour min_lead (nothing caps wait_for_reply at the appointment)", async () => {
      expect(await stepStatus(run.id, ["mm"])).toEqual({ mm: "ok" });
    });

    it("the closer drags the call to next week (a GHL reschedule, same appointment): Call booked reacts 🔁 with the new time in the thread and posts no new card; the finished pre-call is not revived, a fresh one starts for the new time (F4, D59)", async () => {
      const moved = snap("A-KAI", "KAI1", A.plus({ days: 7 }));
      await book(moved);
      await tickAt(A.minus({ minutes: 5 }));
      const booked = await lastRun("call-booked", kai);
      expect(booked).toMatchObject({ status: "completed", exit_reason: "booked" });
      expect(await stepStatus(booked.id, ["k3", "n4", "n4r"])).toEqual({ k3: "skipped", n4: "skipped", n4r: "ok" });
      expect(reactionsOn(bookingTs).at(-1)).toBe("repeat"); expect(threadOf(bookingTs).at(-1)).toMatch(/^🔁 Rescheduled to /);
      expect((await runsFor("pre-call-sequence", kai)).map((r) => r.status)).toEqual(["completed", "waiting"]);
    });
    it("F4 (fixed, D59): a call rescheduled after its sequence ended gets a fresh pre-call sequence for the new time: pre-call also starts on appointment.rescheduled, its reentry key carries the start time, the booking email and text go for the new time and the run waits for the reply", async () => {
      const fresh = await lastRun("pre-call-sequence", kai);
      expect(fresh).toMatchObject({ status: "waiting", current_node: "w1", appointment_id: run.appointment_id });
      expect(fresh.id).not.toBe(run.id);
      expect(sent.filter((s) => s.to === "KAI1").slice(-2).map((s) => (s.kind === "email" ? "email:" + s.body.split("|")[0].slice(0, 13) : "sms:" + s.body))).toEqual(["email:You're booked", "sms:[placeholder — immediate text]"]);
      expect(await asOperator((c) => many(c, "select reentry_key from runs where id in ($1,$2) order by started_at", [run.id, fresh.id]))).toEqual([{ reentry_key: `appointment:${run.appointment_id}@${A.toUTC().toISO()}` }, { reentry_key: `appointment:${run.appointment_id}@${A.plus({ days: 7 }).toUTC().toISO()}` }]);
    });
  });

  // ---- the prospect cancels by text ----
  describe("the prospect texts that they cannot make it", () => {
    let mina: string, run: Run;
    it("pre-call reads the reply as cancelled, a closer taps ❌: the appointment is cancelled at the source and on our row, ❌ with the quote on the booking post, the run exits; appointment.status_changed is emitted by the step (F1, D59) and Call cancelled + Cancellation rebook run from it", async () => {
      replyIntent = "cancelled";
      mina = await newContact("MINA1", "Mina", "Osei", "mina@x.com", "+16025550103");
      await book(snap("A-MINA", "MINA1", daysOut(4, 14)));
      await tickAt(DateTime.now());
      run = await lastRun("pre-call-sequence", mina);
      await inbound(mina, "sorry, I need to cancel"); await wake(run.id);
      await tickAt(DateTime.now().plus({ minutes: 3 }));
      replyIntent = "confirmed";
      // D55: Jev's cancel read is a question for the closers, not an action; the run waits for the tap
      expect(await lastRun("pre-call-sequence", mina)).toMatchObject({ status: "waiting", current_node: "w_dec" });
      expect((await apptRow(mina))!.status).not.toBe("cancelled");
      const qTs = (await postTs(`decision:${run.appointment_id}`))!; expect(qTs).toBeTruthy();
      await asOperator((c) => reactionArrived(c, companyId, { kind: "reaction", eventId: `EvMina${qTs}`, user: "UTYLER", reaction: "x", channel: "CBOOK", ts: qTs, removed: false }));
      await tickAt(DateTime.now().plus({ minutes: 4 }));
      expect(await lastRun("pre-call-sequence", mina)).toMatchObject({ status: "completed", exit_reason: "cancelled" });
      expect((await apptRow(mina))!.status).toBe("cancelled");
      const ts = (await postTs(`appointment:${run.appointment_id}`))!;
      expect(reactionsOn(ts)).toEqual(["x"]); expect(threadOf(ts).at(-1)).toMatch(/^❌ Mina's call is cancelled\.\n> sorry, I need to cancel\nDecided by /);   // D55: a person decided
      const cx = await asOperator((c) => many<{ source: string; data: Record<string, unknown> }>(c, "select source, data from events where company_id=$1 and appointment_id=$2 and event_type='appointment.status_changed' order by id", [companyId, run.appointment_id]));
      expect(cx).toEqual([{ source: "engine", data: { source: "ghl", status: { from: "confirmed", to: "cancelled" }, by: "workflow", node: "n_cx" } }]);
      // the next poll sees the source agree: cancelled → cancelled is no change, so the step's event stays the only one
      await book({ ...apptStore.get("A-MINA")!, status: "cancelled" });
      await tickAt(DateTime.now());
      expect(await asOperator((c) => many(c, "select 1 from events where company_id=$1 and appointment_id=$2 and event_type='appointment.status_changed'", [companyId, run.appointment_id]))).toHaveLength(1);
      expect(await lastRun("call-cancelled", mina)).toMatchObject({ status: "completed", exit_reason: "cancelled_recorded" });
      expect(await lastRun("cancellation-rebook", mina)).toMatchObject({ status: "completed", exit_reason: "sent" });
    });
    it("F1 (fixed, D59): a cancel the prospect texted runs Call cancelled (cards → Cancelled, date cleared, rebook task, stat-cancelled, booked tags off) and Cancellation rebook (the rebook text and email), as a cancel at the source does", async () => {
      expect(await runsFor("call-cancelled", mina)).toHaveLength(1);
      expect(await runsFor("cancellation-rebook", mina)).toHaveLength(1);
      expect(await cardsOf(mina)).toEqual([expect.objectContaining({ pipeline: "PIPE-CLOSER", stage: "STAGE-C-CANCEL", name: "Mina Osei -- Cancelled", status: "open" }), expect.objectContaining({ pipeline: "PIPE-SETTER", stage: "STAGE-S-CANCEL", name: "Mina Osei -- Cancelled", status: "open" })]);
      expect(await tagsOf(mina)).toEqual(["meta booked call", "stat-cancelled"]);
      expect(tasks.filter((t) => t.contactId === "MINA1" && /^Rebook/.test(String(t.title))).map((t) => t.title)).toEqual(["Rebook Mina Osei — cancelled"]);
      expect(sent.filter((s) => s.to === "MINA1").slice(-2).map((s) => s.kind).sort()).toEqual(["email", "sms"]);
    });
  });

  // ---- a show the closer filed with no recording ----
  describe("the call showed but nothing recorded it: the closer files 'showed, follow-up' on the end-of-day form", () => {
    let pat: string, appt: string;
    it("Call outcome filed: stat-showed + stat-follow-up, ✅ and the thread line, the Sales Call record says showed / follow_up (F7, D59); Post-call follow-up parks for 9am; the setter card stays at Direct Booked (open), the closer card at Scheduled", async () => {
      pat = await newContact("PAT1", "Pat", "Lindqvist", "pat@x.com", "+16025550104");
      const A = daysOut(4, 14);
      await book(snap("A-PAT", "PAT1", A));
      await tickAt(DateTime.now());
      appt = (await apptRow(pat))!.id;
      const nOpp = oppWrites.length, nRec = recordWrites.length;
      await file(appt, "showed", "follow_up");
      await tickAt(A.plus({ hours: 5 }));
      expect(await lastRun("call-outcome", pat)).toMatchObject({ status: "completed", exit_reason: "noted" });
      expect(await tagsOf(pat)).toEqual(["meta booked call", "stat-booked", "stat-follow-up", "stat-self-booked", "stat-showed"]);
      const ts = (await postTs(`appointment:${appt}`))!;
      expect(reactionsOn(ts)).toEqual(["white_check_mark"]); expect(threadOf(ts).at(-1)).toBe("✅ Showed, per Sam Closer: follow up.");
      expect(await lastRun("post-call-follow-up", pat)).toMatchObject({ status: "waiting", current_node: "n1" });
      expect(oppWrites.length).toBe(nOpp);
      expect(recordWrites.slice(nRec)).toEqual([{ op: "update", id: expect.any(String), external_id: "A-PAT", outcome: "showed", disposition: "follow_up" }]);
      expect(await cardsOf(pat)).toEqual([{ pipeline: "PIPE-CLOSER", stage: "STAGE-SCHED", name: "Pat Lindqvist -- Direct", status: "open" }, { pipeline: "PIPE-SETTER", stage: "STAGE-DIRECT", name: "Pat Lindqvist -- Direct", status: "open" }]);
    });
    it.fails("F2: a show the closer confirmed should move the setter card to Showed and mark it won, as the recording path does (Sales call recorded o3); Call outcome filed only tags, so a setter card for an unrecorded show sits at Set / Direct Booked for good", async () => {
      expect(await cardOn(pat, "PIPE-SETTER")).toMatchObject({ stage: "STAGE-SHOWED", status: "won" });
    });
    it("F7 (fixed, D59): the Sales Call record says showed / follow_up once the closer filed it (Call outcome filed updates the record call-booked created, keyed by the appointment)", async () => {
      expect(recordWrites.some((w) => w.op === "update" && w.external_id === "A-PAT" && w.outcome === "showed" && w.disposition === "follow_up")).toBe(true);
    });
  });

  // ---- a no-show who rebooks ----
  describe("a no-show who rebooks a week later", () => {
    let quinn: string, first: string;
    const A = daysOut(4, 14);
    it("the no-show: 👻 and stat-no-show, No-show recovery texts and emails the rebook link after 10 minutes and waits a day for a reply; the booked tags and both cards stay as booking left them", async () => {
      quinn = await newContact("QUINN1", "Quinn", "Adebayo", "quinn@x.com", "+16025550105");
      await book(snap("A-Q1", "QUINN1", A));
      await tickAt(DateTime.now());
      first = (await apptRow(quinn))!.id;
      await file(first, "noshow");
      await tickAt(A.plus({ hours: 5 }));
      expect(await lastRun("call-outcome", quinn)).toMatchObject({ status: "completed", exit_reason: "noted" });
      expect(reactionsOn((await postTs(`appointment:${first}`))!)).toEqual(["ghost"]);
      let rec = await lastRun("no-show-recovery", quinn);
      expect(rec).toMatchObject({ status: "waiting", current_node: "n1" });
      const n = sent.length;
      await wake(rec.id); await tickAt(A.plus({ hours: 5, minutes: 11 }));
      expect(sent.slice(n).filter((s) => s.to === "QUINN1").map((s) => s.kind)).toEqual(["sms", "email"]);
      rec = await lastRun("no-show-recovery", quinn); expect(rec).toMatchObject({ status: "waiting", current_node: "n4" });
      expect(await tagsOf(quinn)).toEqual(["meta booked call", "stat-booked", "stat-no-show", "stat-self-booked"]);
      expect(await cardsOf(quinn)).toEqual([expect.objectContaining({ pipeline: "PIPE-CLOSER", stage: "STAGE-SCHED", status: "open" }), expect.objectContaining({ pipeline: "PIPE-SETTER", stage: "STAGE-DIRECT", status: "open" })]);
    });
    it("they book again: Call booked moves the same two cards back to Scheduled / Direct Booked, re-adds stat-booked (stat-no-show stays, F9); the parked recovery run wakes a day later, sees the new call on the calendar and exits `rebooked` without the 'Want to reschedule?' email (F8, D59)", async () => {
      await book(snap("A-Q2", "QUINN1", daysOut(11, 10)));
      await tickAt(DateTime.now());
      expect(await runsFor("call-booked", quinn)).toHaveLength(2);
      expect(await cardsOf(quinn)).toHaveLength(2);
      expect(await tagsOf(quinn)).toEqual(["meta booked call", "stat-booked", "stat-no-show", "stat-self-booked"]);
      const rec = await lastRun("no-show-recovery", quinn);
      expect(rec).toMatchObject({ status: "waiting", current_node: "n4" });
      const n = sent.length;
      await asOperator((c) => c.query("update runs set next_run_at=now(), context = jsonb_set(context, '{vars,__wait_for_reply,n4,deadline}', to_jsonb($2::text), true) where id=$1", [rec.id, A.plus({ days: 1, hours: 5 }).toISO()]));
      await tickAt(A.plus({ days: 1, hours: 6 }));
      expect(sent.slice(n).filter((s) => s.to === "QUINN1")).toEqual([]);
      expect(await lastRun("no-show-recovery", quinn)).toMatchObject({ status: "completed", exit_reason: "rebooked" });
      expect(await stepStatus(rec.id, ["c1", "c2", "n6"])).toEqual({ c1: "ok", c2: "ok" });   // both checks ran; n6 never did
    });
    it("F8 (fixed, D59): a new booking ends the no-show recovery; the check before each send reads the calendar", async () => {
      expect(sent.filter((s) => s.to === "QUINN1" && /^Want to reschedule\?/.test(s.body))).toHaveLength(0);
    });
    it.fails("F8 / F9 (open, the owner's call): stat-no-show should come off on the new booking; Call booked removes seq-no-show, a tag nothing sets, and the owner asked for the GHL-side tags to be left alone until the stat-* tags are declared cumulative or current", async () => {
      expect(await tagsOf(quinn)).not.toContain("stat-no-show");
    });
  });

  // ---- tag churn, read off the templates themselves ----
  describe("tags across every template (pure)", () => {
    const l = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    const adds = new Map<string, string[]>(), removes = new Map<string, string[]>();
    for (const t of templates) for (const n of t.definition.nodes as unknown as Record<string, unknown>[]) {
      const touched = n.type === "tags" ? { a: l(n.add as string[]), r: l(n.remove as string[]) } : n.type === "set_tag" ? { a: l(n.tag as string | string[]), r: [] } : n.type === "remove_tag" ? { a: [], r: l(n.tag as string | string[]) } : null;
      if (!touched) continue;
      for (const tag of touched.a) adds.set(tag, [...(adds.get(tag) ?? []), `${t.slug}:${n.id}`]);
      for (const tag of touched.r) removes.set(tag, [...(removes.get(tag) ?? []), `${t.slug}:${n.id}`]);
    }
    it("no step adds and removes the same tag", () => {
      for (const t of templates) for (const n of t.definition.nodes as unknown as Record<string, unknown>[]) if (n.type === "tags") expect(l(n.add as string[]).filter((x) => l(n.remove as string[]).includes(x))).toEqual([]);
    });
    it("tags a template removes that no template ever adds: the nurture tags Call booked clears (set by the CRM, if at all; the CRM spells 'opt-in lead' as 'optin lead', D50) and the manual send-agreement trigger", () => {
      expect([...removes.keys()].filter((t) => !adds.has(t)).sort()).toEqual(["opt-in lead", "seq-no-show", "seq-nurture", "seq-winback", "sys-send-agreement-manually"]);
    });
    it("tags a template adds that nothing ever removes (F9): every stat-* milestone, meta booked call, pay-paid-full; stat-no-show, stat-cancelled and stat-unconfirmed are not cleared by the booking or the confirmation that outdates them, and stat-agreement-unsigned is not cleared by the signature", () => {
      expect([...adds.keys()].filter((t) => !removes.has(t)).sort()).toEqual(["meta booked call", "pay-paid-full", "pay-refunded", "stat-agreement-sent", "stat-agreement-signed", "stat-agreement-unsigned", "stat-cancelled", "stat-closed-won", "stat-customer", "stat-disqualified", "stat-follow-up", "stat-lost", "stat-new", "stat-no-show", "stat-showed"]);
      expect(removes.get("stat-unconfirmed")).toEqual(["pre-call-sequence:n_conf"]);
      expect(removes.get("stat-booked")).toEqual(["call-cancelled:n5"]);
    });
  });
});
