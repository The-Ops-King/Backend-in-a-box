/**
 * Edge cases a sales-ops operator gets burned by, driven through the real engine against Postgres with fake adapters.
 * The catalogue is engine/05-edge-cases.md; every `it.fails` here is a row under its "Known gaps": the test states the
 * behaviour the operator expects, the engine does something else today, and the one-line reason says where.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { installCompany } from "@/engine/install";
import { emitEvent, dispatchEvent } from "@/engine/dispatch";
import { applyAppointment } from "@/engine/poll";
import { applyPayment } from "@/engine/lifecycle";
import { loadCompany } from "@/engine/context";
import { tick } from "@/engine/runner";
import { fakeAdapters } from "@/engine/test-install";
import { recordRecording, type RecordingInput } from "@/engine/recordings";
import { companyReadiness } from "@/engine/readiness";
import { parseDefinition, extractManifest } from "@/engine/definition";
import type { Adapters, AppointmentSnapshot, Classification } from "@/adapters/types";
import { POST as slackDoor } from "../../app/api/webhooks/slack/[companyId]/route";
import { SCHEMA } from "@/db/schema.sql";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";
const SIGNING = "edge-signing-secret";

// what the fakes record, and the switches that make a vendor misbehave on cue
const sent: { kind: string; to: string; body: string }[] = [];
const tags: string[] = [];
const oppWrites: Record<string, unknown>[] = [];
const recordWrites: Record<string, unknown>[] = [];
const contactWrites: Record<string, unknown>[] = [];
const posts: { channel: string; text: string; threadTs?: string }[] = [];
const apptStore = new Map<string, AppointmentSnapshot>();   // what the booking source "has" for each appointment the tests book
let ghlDown = false;      // the CRM answers 401 (token rotated) to every live read
let smsReject = false;    // the CRM refuses to send a text (no number on the sub-account, no phone on the contact)
let slackDown = false;    // Slack refuses the bot token mid-run
const base = fakeAdapters();
const fake: Adapters = {
  ...base,
  read: { ...base.read, listUsers: async () => [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }], getContact: async (_c, id) => ({ id, firstName: id, tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() }) },
  booking: (() => { const b = { appointmentsInWindow: async () => [], listCalendars: async () => [{ id: "CAL", name: "Closer Call", teamMemberIds: ["U1"] }],
    getAppointment: async (_c: unknown, id: string) => { if (ghlDown) throw new Error("401 Unauthorized: the CRM token was rotated"); return apptStore.get(id) ?? null; } }; return { ghl: b, calendly: b }; })(),
  write: { ...base.write, addTag: async (_c, _id, t) => { tags.push(t); }, updateContact: async (_c, id, patch) => { contactWrites.push({ id, ...patch }); }, createOpportunity: async (_c, input) => { oppWrites.push({ op: "create", ...input }); return { id: `ghl-opp-${oppWrites.length}` }; }, updateOpportunity: async (_c, id, patch) => { oppWrites.push({ op: "update", id, ...patch }); },
    createRecord: async (_c, _o, props) => { recordWrites.push({ op: "create", ...props }); return { id: `rec-${recordWrites.length}` }; }, updateRecord: async (_c, _o, id, props) => { recordWrites.push({ op: "update", id, ...props }); } },
  sender: { ...base.sender,
    sendSms: async (_c, to, body) => { if (smsReject) return { externalId: "", accepted: false, error: "No numbers available in the account" }; sent.push({ kind: "sms", to, body }); return { externalId: `s${sent.length}`, accepted: true }; },
    sendEmail: async (_c, to, subject, html) => { sent.push({ kind: "email", to, body: `${subject}|${html}` }); return { externalId: `e${sent.length}`, accepted: true }; } },
  classifier: { choice: async (_s, _input, options): Promise<Classification> => { const value = options.includes("sales_call") ? "sales_call" : options.includes("closed_won") ? "closed_won" : "confirmed"; return { value, confidence: 0.95, distribution: { [value]: 0.95 }, unclear: false }; } },
  notifier: { ...base.notifier, post: async (_t, channel, text, _as, threadTs) => { if (slackDown) throw new Error("invalid_auth"); posts.push({ channel, text, threadTs }); return { ts: `ts${posts.length}` }; } },
  analyst: { analyze: async () => { const parsed = { notes: { summary: "Wants to start.", pain: ["thinning"], objections: [], disposition: "closed_won", next_step: "onboarding" }, rubric: { overall_score: 8, scores: {}, strengths: [], misses: [], coaching: [] } }; return { text: JSON.stringify(parsed), parsed, model: "fake", usage: { input: 1, output: 1, cacheRead: 0 } }; } },
};

const CRM = { pipeline_setter: "PIPE-SETTER", stage_setter_new_lead: "STAGE-NEW", field_opportunity_stage_entered: "CF-STAGE-DATE", pipeline_closer: "PIPE-CLOSER", stage_setter_direct_booked: "STAGE-DIRECT", stage_setter_appointment_set: "STAGE-SET", stage_closer_scheduled: "STAGE-SCHED", stage_setter_cancelled: "STAGE-S-CANCEL", stage_closer_cancelled: "STAGE-C-CANCEL", field_contact_appointment_date: "CF-APPT-DATE", field_contact_setter: "CF-SETTER", field_opportunity_setter_owner: "CF-SETTER-OWNER", agreement_template: "TPL-AGREE", agreement_sender: "U1", default_closer: "U1", stage_closer_agreement_sent: "STAGE-AGREE", stage_closer_closed_won: "STAGE-WON", field_contact_cash_collected: "CF-CASH", field_contact_revenue_generated: "CF-REV", assoc_payment_contact: "ASSOC-PC", assoc_payment_opportunity: "ASSOC-PO", stage_setter_showed: "STAGE-SHOWED", assoc_sales_call_contact: "ASSOC-SC", assoc_sales_call_opportunity: "ASSOC-SO" };
const TEMPLATES = ["pre-call-sequence", "call-booked", "call-cancelled", "cancellation-rebook", "payment-recorded", "call-recorded"];
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
type Run = { id: string; status: string; current_node: string | null; exit_reason: string | null; next_run_at: Date | null; contact_id: string | null; appointment_id: string | null; workflow_version: number; born_in: string };
const runsFor = (slug: string, co = companyId) => asOperator((c) => many<Run>(c, "select r.id, r.status, r.current_node, r.exit_reason, r.next_run_at, r.contact_id, r.appointment_id, r.workflow_version, r.born_in from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug=$2 order by r.started_at, r.id", [co, slug]));
const workflowId = (slug: string) => asOperator(async (c) => (await one<{ id: string }>(c, "select w.id from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug=$2", [companyId, slug]))!.id);
const wake = (runId: string) => asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [runId]));
/** A wait_for_reply deadline already past, as the engine itself stores it. */
const expireReplyWait = (runId: string, nodeId: string) => asOperator((c) => c.query("update runs set next_run_at=now(), context = jsonb_set(context, $2::text[], to_jsonb($3::text), true) where id=$1", [runId, `{vars,__wait_for_reply,${nodeId},deadline}`, new Date(Date.now() - 60e3).toISOString()]));
const newContact = (ghlId: string, email: string, phone?: string) => asOperator(async (c) => {
  const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,$2,$3,'Edge',$4) returning id", [companyId, ghlId, ghlId, TZ]))!.id;
  await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [companyId, id, email]);
  if (phone) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone',$3)", [companyId, id, phone]);
  return id;
});
const snap = (id: string, ghlContact: string, start: DateTime, over: Partial<AppointmentSnapshot> = {}): AppointmentSnapshot => ({ id, calendarId: "CAL", contactId: ghlContact, assignedUserId: "U1", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), raw: {}, ...over });
/** The poll sees a booking: the source "has" it from now on, and the engine applies it (one transaction, like one poll entity). */
const book = async (s: AppointmentSnapshot) => { apptStore.set(s.id, s); await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, s); }); };
const daysOut = (d: number, hour = 14) => DateTime.now().setZone(TZ).plus({ days: d }).set({ hour, minute: 0, second: 0, millisecond: 0 });
const pay = (contactId: string, paymentId: string, amount: number) => asOperator(async (c) => { const ev = await applyPayment(c, companyId, contactId, { whopPaymentId: paymentId, amount, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); return dispatchEvent(c, ev, { contact: { id: contactId } }); });
const sign = (raw: string, ts: string) => `v0=${createHmac("sha256", SIGNING).update(`v0:${ts}:${raw}`).digest("hex")}`;
/** One knock on the Slack door, signed the way Slack signs it. */
const knock = async (event: Record<string, unknown>, eventId: string, badSignature = false) => {
  const raw = JSON.stringify({ type: "event_callback", event_id: eventId, event }); const ts = String(Math.floor(Date.now() / 1000));
  const req = new Request(`http://engine.test/api/webhooks/slack/${companyId}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": badSignature ? "v0=deadbeef" : sign(raw, ts) } });
  const res = await slackDoor(req, { params: Promise.resolve({ companyId }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const reaction = (user: string, ts: string, over: Record<string, unknown> = {}) => ({ type: "reaction_added", user, reaction: "white_check_mark", item: { type: "message", channel: "C1", ts }, ...over });

describe("edge cases (pure)", () => {
  it("the Slack door's event source is one the events table accepts (route.ts writes source 'slack'; schema.sql and migrate.ts EVENT_SOURCES list it since D53)", () => {
    const allowed = /create table events[\s\S]*?source\s+text not null check \(source in \(([^)]*)\)\)/.exec(SCHEMA)![1];
    expect(allowed).toMatch(/'slack'/);
  });
});

describe.skipIf(!HAS_DB)("edge cases", () => {
  beforeAll(async () => {
    // the test database is shared: a sibling branch's rows may not satisfy main's event-source check (see the schema test below); the schema itself is already there
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    await wipe("edges"); await wipe("edges2");
    const input = { name: "Edges", slug: "edges", timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, enable: true, templates: TEMPLATES, crm: CRM, slack: { calls: "CCALLS" }, slackSigningSecret: SIGNING, anthropicKey: "sk-fake", contractValueDefault: 2999 };
    const r = await installCompany(input, fake);
    companyId = r.companyId;
    expect(r.installed.filter((s) => s.endsWith("enabled"))).toHaveLength(TEMPLATES.length);
    await asOperator(async (c) => {
      await c.query("update companies set send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]);
      // Slack is connected (the bot is UBOT); no bookings channel is bound, so booking posts are recorded, not posted
      await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, channels) values ($1,'T1',$2,'UBOT','{}')", [companyId, encrypt("xoxb-fake")]);
    });
    // live is a go-live (D56): readiness wants Slack connected first, so the mode comes on a second install
    await installCompany({ ...input, mode: "live" }, fake);
  });

  it("D45: a second booking for the same person supersedes the pre-call run parked for the first; the new run carries on alone", async () => {
    const id = await newContact("CE1", "e1@x.com", "+16025550001");
    await book(snap("AE1", "CE1", daysOut(3)));
    await tick(fake, undefined, companyId);
    let runs = (await runsFor("pre-call-sequence")).filter((r) => r.contact_id === id);
    expect(runs).toHaveLength(1); expect(runs[0]).toMatchObject({ status: "waiting", current_node: "w1" });
    const older = runs[0];
    await book(snap("AE2", "CE1", daysOut(5, 10)));
    runs = (await runsFor("pre-call-sequence")).filter((r) => r.contact_id === id);
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.id === older.id)).toMatchObject({ status: "exited", exit_reason: expect.stringMatching(/superseded/) });
    const newer = runs.find((r) => r.id !== older.id)!;
    expect(newer).toMatchObject({ status: "active" });
    const ev = await asOperator((c) => one<{ data: { reason: string; by_run: string } }>(c, "select data from events where run_id=$1 and event_type='run.exited'", [older.id]));
    expect(ev?.data).toMatchObject({ reason: "superseded", by_run: newer.id });
    const n = sent.length; await tick(fake, undefined, companyId);
    expect(sent.slice(n).map((s) => s.kind).sort()).toEqual(["email", "sms"]);   // the newer booking's own day-one email and text
    expect((await runsFor("pre-call-sequence")).find((r) => r.id === newer.id)).toMatchObject({ status: "waiting", current_node: "w1" });
    // the older run never wakes again, even when its own deadline would have passed
    await expireReplyWait(older.id, "w1"); const n2 = sent.length; await tick(fake, undefined, companyId);
    expect(sent.length).toBe(n2);
  });

  it("a workflow turned off while a run is parked: the run does nothing when it wakes; it exits as 'workflow turned off' so turning the switch back on starts fresh", async () => {
    const id = await newContact("CE2", "e2@x.com", "+16025550002");
    await book(snap("AE3", "CE2", daysOut(3)));
    await tick(fake, undefined, companyId);
    const run = (await runsFor("pre-call-sequence")).find((r) => r.contact_id === id)!;
    expect(run).toMatchObject({ status: "waiting", current_node: "w1" });
    const wf = await workflowId("pre-call-sequence");
    await asOperator((c) => c.query("update workflows set enabled=false where id=$1", [wf]));
    const nTags = tags.length, nSteps = Number((await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from run_steps where run_id=$1", [run.id])))!.n);
    try {
      await expireReplyWait(run.id, "w1");   // the 4-hour reply wait runs out while the workflow is off
      await tick(fake, undefined, companyId);
      expect(tags.length).toBe(nTags);   // no stat-unconfirmed written to the CRM by a workflow that is off
      expect(Number((await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from run_steps where run_id=$1", [run.id])))!.n)).toBe(nSteps);
      expect((await runsFor("pre-call-sequence")).find((r) => r.id === run.id)).toMatchObject({ status: "exited", exit_reason: "workflow turned off" });
      expect((await asOperator((c) => one<{ data: { reason: string } }>(c, "select data from events where run_id=$1 and event_type='run.exited'", [run.id])))?.data).toMatchObject({ reason: "workflow turned off" });
    } finally { await asOperator((c) => c.query("update workflows set enabled=true where id=$1", [wf])); }
  });

  it("the CRM is down (401, token rotated) at the premise check: the run stays waiting and is late, never lost; the operator is told once", async () => {
    const id = await newContact("CE3", "e3@x.com", "+16025550003");
    await book(snap("AE4", "CE3", daysOut(3)));
    await tick(fake, undefined, companyId);
    const run = (await runsFor("pre-call-sequence")).find((r) => r.contact_id === id)!;
    expect(run).toMatchObject({ status: "waiting", current_node: "w1" });
    ghlDown = true;
    try {
      await wake(run.id); await tick(fake, undefined, companyId);
      const after = (await runsFor("pre-call-sequence")).find((r) => r.id === run.id)!;
      expect(after).toMatchObject({ status: "waiting", current_node: "w1" });
      expect(after.next_run_at!.getTime()).toBeGreaterThan(Date.now() + 60e3);   // a few minutes out, not now and not never
      const open = await asOperator((c) => many<{ key: string }>(c, "select key from alerts where company_id=$1 and key like 'premise:%' and resolved_at is null", [companyId]));
      expect(open).toHaveLength(1);
      await wake(run.id); await tick(fake, undefined, companyId);   // still down: the same alert, still one
      expect(await asOperator((c) => many(c, "select 1 from alerts where company_id=$1 and key like 'premise:%'", [companyId]))).toHaveLength(1);
    } finally { ghlDown = false; }
    // the source is back: the run is looked at again as if nothing happened, and the alert closes
    await wake(run.id); await tick(fake, undefined, companyId);
    expect((await runsFor("pre-call-sequence")).find((r) => r.id === run.id)).toMatchObject({ status: "waiting", current_node: "w1" });
    expect(await asOperator((c) => many(c, "select 1 from alerts where company_id=$1 and key like 'premise:%' and resolved_at is null", [companyId]))).toHaveLength(0);
  });

  it("the CRM refuses the text (no number on the sub-account, no phone on the contact): the text is recorded as failed and the run goes on to the reply wait and the email reminders", async () => {
    const id = await newContact("CE4", "e4@x.com");   // no phone
    smsReject = true;
    try {
      await book(snap("AE5", "CE4", daysOut(3)));
      await tick(fake, undefined, companyId);
      const run = (await runsFor("pre-call-sequence")).find((r) => r.contact_id === id)!;
      const text = await asOperator((c) => one<{ status: string; error: string | null }>(c, "select status, error from sends where run_id=$1 and channel='sms'", [run.id]));
      expect(text).toMatchObject({ status: "failed", error: expect.stringMatching(/No numbers available/) });   // the ledger has the refusal
      expect(run).toMatchObject({ status: "waiting", current_node: "w1" });
      const step = await asOperator((c) => one<{ status: string; result: { kind: string; why: string } }>(c, "select status, result from run_steps where run_id=$1 and node_id='s1'", [run.id]));
      expect(step).toMatchObject({ status: "skipped", result: { kind: "blocked", why: expect.stringMatching(/refused the sms: No numbers available/) } });   // what the alert sweep turns into "step could not run" (D33)
    } finally { smsReject = false; }
  });

  it("two payments for one person in the same minute (deposit, then a fee): both are written to the CRM; D45 supersede is for per-person sequences, not `always` runs", async () => {
    const id = await newContact("CE5", "e5@x.com", "+16025550005");
    await pay(id, "PE1", 1500); await pay(id, "PE2", 99);   // two deliveries, one tick between none
    await tick(fake, undefined, companyId); await tick(fake, undefined, companyId);
    const records = await asOperator((c) => many<{ record_key: string }>(c, "select record_key from crm_records where company_id=$1 and contact_id=$2 and object_key='custom_objects.payment' order by record_key", [companyId, id]));
    expect(records.map((r) => r.record_key)).toEqual(["PE1", "PE2"]);
    const runs = (await runsFor("payment-recorded")).filter((r) => r.contact_id === id);
    expect(runs.map((r) => r.exit_reason)).toEqual(["recorded", "recorded"]);
  });

  it("a template upgraded while a run is parked: the run finishes on the version it started with; a new booking starts on the new one", async () => {
    const id = await newContact("CE6", "e6@x.com", "+16025550006");
    await book(snap("AE6", "CE6", daysOut(3)));
    await tick(fake, undefined, companyId);
    const run = (await runsFor("pre-call-sequence")).find((r) => r.contact_id === id)!;
    expect(run).toMatchObject({ status: "waiting", current_node: "w1", workflow_version: 1 });
    const wf = await workflowId("pre-call-sequence");
    // version 2 renames the reply wait: a run reading v2 would not find node w1
    const v1 = (await asOperator((c) => one<{ definition: { nodes: { id: string }[]; edges: { from: string; to: string }[] } }>(c, "select definition from workflow_versions where workflow_id=$1 and version=1", [wf])))!.definition;
    const v2 = JSON.parse(JSON.stringify(v1)) as typeof v1;
    for (const n of v2.nodes) if (n.id === "w1") n.id = "w1x";
    for (const e of v2.edges) { if (e.from === "w1") e.from = "w1x"; if (e.to === "w1") e.to = "w1x"; }
    const parsed = parseDefinition(v2);
    await asOperator(async (c) => { await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,2,$2,$3,'edge test')", [wf, parsed, extractManifest(parsed)]); await c.query("update workflows set current_version=2 where id=$1", [wf]); });
    try {
      await expireReplyWait(run.id, "w1"); await tick(fake, undefined, companyId);
      const after = (await runsFor("pre-call-sequence")).find((r) => r.id === run.id)!;
      expect(after.status).not.toBe("failed"); expect(after.exit_reason ?? "").not.toMatch(/unknown node/);
      expect(["r72", "r48", "r24"]).toContain(after.current_node);   // the timeout edge was followed on v1 and the run parked on the next reminder
      // a booking made now starts on v2 and parks on the renamed node
      const other = await newContact("CE6B", "e6b@x.com", "+16025550016");
      await book(snap("AE6B", "CE6B", daysOut(4)));
      await tick(fake, undefined, companyId);
      expect((await runsFor("pre-call-sequence")).find((r) => r.contact_id === other)).toMatchObject({ status: "waiting", current_node: "w1x", workflow_version: 2 });
    } finally { await asOperator((c) => c.query("update workflows set current_version=1 where id=$1", [wf])); }
  });

  it("the Slack door: a forged signature, the bot's own reaction, a reaction on a post the engine does not remember, a removed reaction and a redelivered event all change nothing; one real tap starts the booking decision", async () => {
    const id = await newContact("CE7", "e7@x.com", "+16025550007");
    await book(snap("AE7", "CE7", daysOut(3)));
    await tick(fake, undefined, companyId);
    const run = (await runsFor("pre-call-sequence")).find((r) => r.contact_id === id)!;
    const TS = "1700000000.000100";
    await asOperator((c) => c.query("insert into slack_posts (company_id, tag, channel, ts, run_id) values ($1,$2,'C1',$3,$4)", [companyId, `decision:${run.appointment_id}`, TS, run.id]));
    const before = Number((await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from events where company_id=$1 and event_type='slack.reaction'", [companyId])))!.n);
    expect((await knock(reaction("U1", TS), "EvForged", true)).status).toBe(401);
    expect((await knock(reaction("UBOT", TS), "EvBot")).body).toMatchObject({ ignored: "own reaction" });
    expect((await knock(reaction("U1", "999.000001"), "EvUnknown")).body).toMatchObject({ ignored: "not a post the engine remembers" });
    expect((await knock(reaction("U1", TS, { type: "reaction_removed" }), "EvRemoved")).body).toMatchObject({ ignored: "reaction_removed" });
    // D53: the question's own run is parked on the wait; the tap wakes that run and no other
    await asOperator((c) => c.query("update runs set status='waiting', current_node='w_dec', wake_on_tag=$2, next_run_at=null where id=$1", [run.id, `decision:${run.appointment_id}`]));
    const real = await knock(reaction("U1", TS), "EvReal");
    expect(real.body).toMatchObject({ runs_woken: 1 }); expect(String(real.body.event)).toMatch(/^\d+$/);
    expect((await knock(reaction("U1", TS), "EvReal")).body).toMatchObject({ duplicate_delivery: true });   // Slack retries: the same event id lands twice
    const after = Number((await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from events where company_id=$1 and event_type='slack.reaction'", [companyId])))!.n);
    expect(after - before).toBe(1);
    const nTags = tags.length; await tick(fake, undefined, companyId);
    expect(tags.slice(nTags)).toContain("stat-confirmed");
    expect((await runsFor("pre-call-sequence")).find((r) => r.id === run.id)?.current_node).not.toBe("w_dec");
  });

  it.fails("a person rebooks and the old call is then cancelled (a GHL reschedule done as cancel + new booking): the cards for the live booking stay at Scheduled and no rebook text goes out (call-cancelled and cancellation-rebook never ask whether a newer booking exists)", async () => {
    const id = await newContact("CE8", "e8@x.com", "+16025550008");
    await book(snap("AE8", "CE8", daysOut(3)));
    await tick(fake, undefined, companyId);
    const card = () => asOperator((c) => one<{ ghl_stage_id: string }>(c, "select ghl_stage_id from pipeline_cards where company_id=$1 and contact_id=$2 and ghl_pipeline_id='PIPE-CLOSER' and status='open'", [companyId, id]));
    expect(await card()).toEqual({ ghl_stage_id: "STAGE-SCHED" });
    // the person rebooked: the new booking lands first, the old one is seen cancelled on the next poll
    await book(snap("AE9", "CE8", daysOut(5, 10)));
    await tick(fake, undefined, companyId);
    expect(await card()).toEqual({ ghl_stage_id: "STAGE-SCHED" });
    await book(snap("AE8", "CE8", daysOut(3), { status: "cancelled", cancellation: { by: "CE8 Edge", reason: "found a better time" } }));
    const n = sent.length;
    await tick(fake, undefined, companyId);
    expect(sent.slice(n).filter((s) => s.kind === "sms" && /cancel/i.test(s.body))).toEqual([]);   // today: the rebook text goes to someone who already rebooked
    expect(await card()).toEqual({ ghl_stage_id: "STAGE-SCHED" });   // today: STAGE-C-CANCEL, with a live call five days out
  });

  it("Slack refuses the bot token in the middle of Sales call recorded: the post is recorded as failed and the Sales Call record is still written", async () => {
    const id = await newContact("CE9", "e9@x.com", "+16025550009");
    const rec: RecordingInput = { externalId: "fathom-edge-9", title: "CE9 and Sam", startedAt: new Date(Date.now() - 3600e3), durationMin: 40, recordedBy: { name: "Sam Closer", email: "sam@x.com" }, invitees: [{ name: "Sam Closer", email: "sam@x.com", isExternal: false }, { name: "CE9 Edge", email: "e9@x.com", isExternal: true }], transcript: [{ speaker: "CE9 Edge", text: "I want to start." }] };
    const r = await asOperator((c) => recordRecording(c, companyId, rec));
    expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
    await asOperator((c) => dispatchEvent(c, r.event, { contact: { id } }));
    slackDown = true;
    try {
      await tick(fake, undefined, companyId);
      const run = (await runsFor("call-recorded")).find((x) => x.contact_id === id)!;
      const post = await asOperator((c) => one<{ status: string; error: string | null }>(c, "select status, error from sends where run_id=$1 and channel='slack' order by scheduled_for limit 1", [run.id]));
      expect(post).toMatchObject({ status: "failed", error: expect.stringMatching(/invalid_auth/) });
      expect(await asOperator((c) => many(c, "select 1 from crm_records where company_id=$1 and contact_id=$2 and object_key='custom_objects.sales_call'", [companyId, id]))).toHaveLength(1);
      expect(run.status).toBe("completed");
    } finally { slackDown = false; }
  });

  it.fails("a call booked two hours out: the 1-hour and 10-minute texts still go (executor.ts wait_for_reply holds the run for its full 4-hour timeout; nothing caps it at the call time)", async () => {
    const id = await newContact("CE10", "e10@x.com", "+16025550010");
    const start = DateTime.now().plus({ hours: 2 });
    await book(snap("AE10", "CE10", start));
    const n = sent.length;
    await tick(fake, undefined, companyId);
    expect(sent.slice(n).map((s) => s.kind).sort()).toEqual(["email", "sms"]);   // the day-one email and text go at once
    const run = (await runsFor("pre-call-sequence")).find((r) => r.contact_id === id)!;
    expect(run).toMatchObject({ status: "waiting", current_node: "w1" });
    // eight minutes before the call, no reply ever came
    await wake(run.id); await tick(fake, DateTime.now().plus({ hours: 1, minutes: 52 }), companyId);
    const after = (await runsFor("pre-call-sequence")).find((r) => r.id === run.id)!;
    expect(after.current_node).not.toBe("w1");   // today: still w1; the reminders never run and the run exits moot when the call starts
  });

  it("a call booked three minutes out: the day-one messages are skipped as stale, nothing fails, and the run exits moot once the call has started", async () => {
    const id = await newContact("CE11", "e11@x.com", "+16025550011");
    const s = snap("AE11", "CE11", DateTime.now().plus({ minutes: 3 }));
    await book(s);
    const n = sent.length;
    await tick(fake, undefined, companyId);
    expect(sent.length).toBe(n);
    const run = (await runsFor("pre-call-sequence")).find((r) => r.contact_id === id)!;
    expect(run).toMatchObject({ status: "waiting", current_node: "w1" });
    const steps = await asOperator((c) => many<{ node_id: string; status: string }>(c, "select node_id, status from run_steps where run_id=$1 and node_id in ('e1','s1')", [run.id]));
    expect(steps.map((x) => x.status)).toEqual(["stale", "stale"]);
    // the call has started: the next wake finds the premise dead
    apptStore.set("AE11", { ...s, startTime: DateTime.now().minus({ minutes: 1 }).toISO()!, endTime: DateTime.now().plus({ minutes: 44 }).toISO()! });
    await wake(run.id); await tick(fake, undefined, companyId);
    expect((await runsFor("pre-call-sequence")).find((r) => r.id === run.id)).toMatchObject({ status: "exited", exit_reason: expect.stringMatching(/moot: appointment already happened/) });
    expect(sent.length).toBe(n);
  });

  it("placeholder copy at go-live time is a warning, not a blocker: readiness names the workflow and the count", async () => {
    const r = await asOperator((c) => companyReadiness(c, companyId, "/c/edges"));
    const warn = r.issues.filter((i) => /placeholder copy/.test(i.text));
    expect(warn.length).toBeGreaterThan(0);
    expect(warn.every((i) => i.level === "warning")).toBe(true);
    expect(warn.map((i) => i.text).join(" ")).toMatch(/Pre-call sequence: \d+ messages are still placeholder copy/);
  });

  it("re-running install with mode: live on a shadow company is a go-live: refused while readiness has a blocker, and shadow-born runs are cleared first (D51)", async () => {
    const input = { name: "Edges 2", slug: "edges2", timezone: TZ, locationId: "LOC2", pit: "pit-fake", calendars: { CAL: "closing" }, bookingCalendar: "CAL", templates: ["speed-to-lead"], enable: true };
    const co2 = (await installCompany({ ...input, mode: "shadow" }, fake)).companyId;
    const id = await asOperator(async (c) => { const x = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, timezone) values ($1,'CS1','Sh',$2) returning id", [co2, TZ]))!.id; await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','sh@x.com'),($1,$2,'phone','+16025550099')", [co2, x]); return x; });
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: co2, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: {} }), { contact: { id } }));
    await tick(fake, undefined, co2);
    expect((await runsFor("speed-to-lead", co2))[0]).toMatchObject({ status: "waiting", current_node: "n3", born_in: "shadow" });
    // no Slack yet: the same refusal the dashboard gives, and the flag does not move
    await expect(installCompany({ ...input, mode: "live" }, fake)).rejects.toThrow(/not ready to go live.*Slack is not connected/);
    expect((await asOperator((c) => one<{ mode: string }>(c, "select mode from companies where id=$1", [co2])))?.mode).toBe("shadow");
    await asOperator((c) => c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, channels) values ($1,'T2',$2,'UBOT2','{}')", [co2, encrypt("xoxb-fake")]));
    const live = await installCompany({ ...input, mode: "live" }, fake);
    expect(live.wentLive?.runs).toBe(1);
    expect((await asOperator((c) => one<{ mode: string }>(c, "select mode from companies where id=$1", [co2])))?.mode).toBe("live");
    const leftover = await asOperator((c) => many(c, "select 1 from runs where company_id=$1 and born_in<>'live' and status in ('active','waiting')", [co2]));
    expect(leftover).toHaveLength(0);
  });

  // catalogued, not yet written: each needs a template decision before the test can say what "right" is
  it("a refund (G10, fixed by D57): cash collected drops to the lower running total, a second Payment record carries the minus sign, pay-refunded is added and pay-paid-full stays", async () => {
    const id = await newContact("CEREF", "eref@x.com", "+16025550077");
    await pay(id, "PR1", 2999); await tick(fake, undefined, companyId);   // paid in full
    const nCw = contactWrites.length, nRec = recordWrites.length;
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, id, { whopPaymentId: "PR2", amount: 500, currency: "USD", status: "refunded", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id } }); });
    await tick(fake, undefined, companyId);
    const runs = (await runsFor("payment-recorded")).filter((r) => r.contact_id === id);
    expect(runs.map((r) => r.exit_reason)).toEqual(["recorded", "recorded"]);
    expect(contactWrites.slice(nCw).map((w) => w.customFields)).toEqual([[{ id: "CF-CASH", field_value: "2499" }]]);
    expect(recordWrites.slice(nRec)[0]).toMatchObject({ op: "create", transaction_id: "PR2", amount: -500, type: "refund", status: "refunded" });
    const contactTags = (await asOperator((c) => one<{ tags: string[] }>(c, "select tags from contacts where id=$1", [id])))!.tags;
    expect(contactTags).toEqual(expect.arrayContaining(["pay-paid-full", "pay-refunded"])); expect(contactTags).not.toContain("pay-plan-active");
    const slack = await asOperator((c) => many<{ rendered_body: string }>(c, "select rendered_body from sends where run_id=$1 and channel='slack'", [runs[1].id]));   // the payments-channel line, the booking thread line and the review thread line
    expect(slack.map((s) => s.rendered_body)).toContainEqual(expect.stringMatching(/^\*Refund:\* −\$500\n/));
  });
  it.todo("a closer files the same day twice: outcomes are re-recorded, Call outcome filed reacts again by design (always), the summary post does not say it is a refiling (eod-filed.json never reads event.refiled)");
  it.todo("a call moved to tomorrow after the end-of-day form opened: the submitted outcome is still recorded on an appointment that is no longer today's (eod.ts submitEod records every answered call; diffAnswers skips it silently)");
  it.todo("a reply that arrives after the reply wait ended (the person texts 'can't make it' two days before the call): message.received fires, no workflow listens, the reminders carry on");
});
