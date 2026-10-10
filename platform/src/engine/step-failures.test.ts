/**
 * Every step, every error (D67). One company (`stepf`) with a fake CRM, Slack, classifier and analyst that can be told
 * to fail per method — `fail("addTag", { status: 503, times: 2 })`, `fail("createOpportunity", { after: true })` for a
 * crash after the vendor already did the thing — and that count every call, so a test can say "asked once", "one card",
 * "one message". The catalogue is engine/07-step-failures.md; every test here is one of its rows, written to the
 * policy there (transient → retried in place at 1 min, 5 min, 15 min, 1 h, then paused; auth → paused at once, one
 * alert per vendor; permanent → paused with the vendor's words; unknown → one try, then permanent; a retry never
 * repeats a side effect; nothing re-runs from the top). Where today's engine does something else the test is
 * `it.fails` and its title says what today does; the retry work flips them.
 *
 * The four bad bugs Tyler named — 20 runs, 20 cards, 20 messages, 20 charges — each have a test that asserts
 * "exactly one" (or zero) under a 503-twice-then-ok and under a crash after the vendor call.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { emitEvent, startRun } from "@/engine/dispatch";
import { upsertContact } from "@/engine/poll";
import { tick, type TickReport } from "@/engine/runner";
import { collectThisTick } from "@/engine/alerts";
import { applyPayment } from "@/engine/lifecycle";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { encrypt } from "@/engine/crypto";
import { fakeAdapters } from "@/engine/test-install";
import type { PollReport } from "@/engine/poll";
import { GhlError } from "@/adapters/ghl/client";
import type { Adapters, AppointmentSnapshot, Classification, ContactSnapshot, LiveCard, SendResult } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";

// ---- the switches: which vendor method fails, how, how many times; and how often each was asked ----
type Plan = { status?: number; times: number; after?: boolean; message?: string };
const calls = new Map<string, number>();
const plans = new Map<string, Plan>();
/** `status` absent = a network error (or `message`); `after` = the vendor did the thing, then the call died. */
const fail = (method: string, p: Partial<Plan> = {}) => { plans.set(method, { times: 1, ...p }); };
const callsTo = (method: string) => calls.get(method) ?? 0;
const GHL = new Set(["openCards", "getContact", "addTag", "removeTag", "addNote", "createTask", "createRecord", "updateRecord", "relateRecords", "createOpportunity", "updateOpportunity", "updateContact", "updateAppointment", "sendSms", "sendEmail"]);
const WORDS: Record<number, string> = { 400: '{"message":"Invalid request: phone is not a valid number"}', 401: '{"message":"Invalid JWT"}', 403: '{"message":"The token does not have access to this location."}', 404: '{"message":"Contact with id X not found"}', 422: '{"message":"Unprocessable Entity"}', 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 529: '{"type":"overloaded_error"}' };
const errorFor = (method: string, p: Plan): Error => {
  if (p.status === undefined) return new Error(p.message ?? "fetch failed: ECONNRESET");
  if (GHL.has(method)) return new GhlError(p.status, p.message ?? WORDS[p.status] ?? "", `/${method}`);
  return Object.assign(new Error(p.message ?? `${p.status} ${WORDS[p.status] ?? ""}`.trim()), { status: p.status });
};
async function vendor<T>(method: string, effect: () => T | Promise<T>): Promise<T> {
  calls.set(method, callsTo(method) + 1);
  const p = plans.get(method);
  if (p && p.times > 0 && !p.after) { p.times--; throw errorFor(method, p); }
  const out = await effect();
  if (p && p.times > 0 && p.after) { p.times--; throw errorFor(method, p); }
  return out;
}

// ---- the fake vendors' memory ----
const crm = new Map<string, ContactSnapshot>();
const cards = new Map<string, LiveCard>();
const messages: { kind: "sms" | "email"; to: string; body: string }[] = [];
const notes: { to: string; body: string }[] = [];
const tasks: { to: string; title: string }[] = [];
const records = new Map<string, Record<string, unknown>>();
const tagsOn = new Map<string, string[]>();
const posts: { channel: string; text: string }[] = [];
const apptStore = new Map<string, AppointmentSnapshot>();
let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

const base = fakeAdapters();
/** The real sender catches the CRM's refusal and answers `accepted: false` (sender.ts:10); a crash after the CRM accepted (`after`) is not something it can catch. */
const send = async (kind: "sms" | "email", method: string, to: string, body: string): Promise<SendResult> => {
  const p = plans.get(method);
  try { return await vendor(method, () => { if (!crm.has(to)) throw new GhlError(404, `{"message":"Contact with id ${to} not found"}`, "/conversations/messages"); messages.push({ kind, to, body }); return { externalId: nextId(kind), accepted: true }; }); }
  catch (e) { if (p?.after) throw e; return { externalId: "", accepted: false, error: String((e as Error).message) }; }
};
const gone = (what: string, id: string) => new GhlError(404, `{"message":"${what} with id ${id} not found"}`, `/${what.toLowerCase()}s/${id}`);
const fake: Adapters = {
  ...base,
  read: { ...base.read, listUsers: async () => [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }], getContact: async (_c, id) => vendor("getContact", () => crm.get(id) ?? null),
    openCards: async (_c, ghlId) => vendor("openCards", () => [...cards.values()].filter((k) => k.contactId === ghlId).map((k) => ({ ...k }))) },
  booking: (() => { const b = { appointmentsInWindow: async () => [], listCalendars: async () => [{ id: "CAL", name: "Closer Call", teamMemberIds: ["U1"] }], getAppointment: async (_c: unknown, id: string) => apptStore.get(id) ?? null }; return { ghl: b, calendly: b }; })(),
  write: { ...base.write,
    addTag: async (_c, id, tag) => vendor("addTag", () => { const t = tagsOn.get(id) ?? []; if (!t.includes(tag)) t.push(tag); tagsOn.set(id, t); }),
    removeTag: async (_c, id, tag) => vendor("removeTag", () => { tagsOn.set(id, (tagsOn.get(id) ?? []).filter((x) => x !== tag)); }),
    addNote: async (_c, id, body) => vendor("addNote", () => { notes.push({ to: id, body }); }),
    createTask: async (_c, id, t) => vendor("createTask", () => { tasks.push({ to: id, title: t.title }); return { id: nextId("task") }; }),
    createRecord: async (_c, _o, props) => vendor("createRecord", () => { const id = nextId("rec"); records.set(id, { ...props }); return { id }; }),
    updateRecord: async (_c, _o, id, props) => vendor("updateRecord", () => { const r = records.get(id); if (!r) throw gone("Record", id); Object.assign(r, props); }),
    relateRecords: async () => vendor("relateRecords", () => {}),
    updateContact: async (_c, id, patch) => vendor("updateContact", () => { const s = crm.get(id); if (!s) throw gone("Contact", id); if (patch.firstName) s.firstName = patch.firstName; }),
    updateAppointment: async (_c, id, patch) => vendor("updateAppointment", () => { const a = apptStore.get(id); if (!a) throw gone("Appointment", id); if (patch.status) a.status = patch.status; }),
    createOpportunity: async (_c, input) => vendor("createOpportunity", () => { const id = nextId("opp"); cards.set(id, { id, pipelineId: input.pipelineId, stageId: input.stageId, status: input.status, name: input.name, assignedUserId: input.assignedUserId, updatedAt: new Date().toISOString(), contactId: input.contactId }); return { id }; }),
    updateOpportunity: async (_c, id, patch) => vendor("updateOpportunity", () => { const k = cards.get(id); if (!k) throw gone("Opportunity", id); Object.assign(k, { stageId: patch.stageId ?? k.stageId, name: patch.name ?? k.name, status: patch.status ?? k.status, updatedAt: new Date().toISOString() }); }),
  },
  sender: { ...base.sender, sendSms: (_c, to, body) => send("sms", "sendSms", to, body), sendEmail: (_c, to, subject, html) => send("email", "sendEmail", to, `${subject}|${html}`) },
  // the real classifier turns every HTTP failure (401, 5xx, a timeout) into "unclear, confidence 0" (classifier.ts:36): the engine cannot tell a dead key from a vague reply
  classifier: { choice: async (): Promise<Classification> => { calls.set("classify", callsTo("classify") + 1); const p = plans.get("classify"); if (p && p.times > 0) { p.times--; return { value: "unclear", confidence: 0, distribution: {}, unclear: true }; } return { value: "confirmed", confidence: 0.97, distribution: { confirmed: 0.97 }, unclear: false }; } },
  notifier: { ...base.notifier, post: async (_t, channel, text) => vendor("slackPost", () => { posts.push({ channel, text }); return { ts: `${posts.length}.000100` }; }) },
  analyst: { analyze: async () => vendor("analyze", () => ({ text: '{"summary":"fine"}', parsed: { summary: "fine" }, model: "fake", usage: { input: 1, output: 1, cacheRead: 0 } })) },
};

// ---- the company, its workflows, and the probes (one step each, so a row is one run) ----
const CRM = { pipeline_setter: "PIPE-SETTER", stage_setter_new_lead: "STAGE-NEW", field_opportunity_stage_entered: "CF-STAGE-DATE", pipeline_closer: "PIPE-CLOSER", stage_closer_scheduled: "STAGE-SCHED", default_closer: "U1" };
const TABLES = ["alerts", "slack_posts", "sends", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "payments", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
let companyId: string, closingTerm: string;
let wfNewLead: string, wfS2L: string, wfTag: string, wfCard: string, wfCardSkip: string, wfCardStatus: string, wfNote: string, wfTask: string, wfRecord: string, wfContact: string, wfSlack: string, wfNotify: string, wfClassify: string, wfAnalyze: string, wfAnalyzeOpt: string, wfAppt: string, wfBranch: string, wfRecordEv: string, wfCheck: string;

const wipe = (slug: string) => asOperator(async (c) => {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
  await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
  await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
  for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
  await c.query("delete from companies where id=$1", [co.id]);
});
const T1 = { id: "t1", type: "trigger", event: "lead.created" }, X1 = { id: "x1", type: "exit", reason: "done" };
async function probe(name: string, middle: Record<string, unknown>[], opts: { edges?: Record<string, unknown>[]; premise?: string } = {}): Promise<string> {
  const nodes = [T1, ...middle, X1];
  const edges = opts.edges ?? nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id }));
  const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: opts.premise ?? "contact_exists" }, nodes, edges });
  return asOperator(async (c) => {
    const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,$2,'always',true) returning id", [companyId, name]))!;
    await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'stepf probe')", [wf.id, def, extractManifest(def)]);
    return wf.id;
  });
}
const templateWf = (slug: string) => asOperator(async (c) => (await one<{ id: string }>(c, "select w.id from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug=$2", [companyId, slug]))!.id);

// ---- people, runs, ticks ----
const person = async (ghlId: string, over: Partial<ContactSnapshot> = {}): Promise<string> => {
  const iso = new Date().toISOString();
  const s: ContactSnapshot = { id: ghlId, firstName: "Pat", lastName: ghlId, email: `${ghlId.toLowerCase()}@x.com`, phone: `+1602555${String(1000 + ++seq).slice(-4)}`, tags: [], customFields: {}, dateUpdated: iso, dateAdded: iso, ...over };
  crm.set(ghlId, s);
  return (await asOperator((c) => upsertContact(c, companyId, TZ, s))).id;
};
const nameOf = (ghlId: string) => `Pat ${ghlId}`;
const start = (workflowId: string, contactId: string, data: Record<string, unknown> = {}, appointmentId?: string) => asOperator(async (c) => {
  const ev = await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: appointmentId ?? null, event_type: "lead.created", source: "test", data });
  const id = await startRun(c, { companyId, workflowId, triggerNodeId: "t1", event: ev, contactId, appointmentId });
  if (!id) throw new Error("run not started"); return id;
});
const tickOnce = () => tick(fake, undefined, companyId);
type Run = { id: string; status: string; current_node: string | null; exit_reason: string | null; next_run_at: Date | null; context: Record<string, unknown> };
const RUN_COLS = "id, status, current_node, exit_reason, next_run_at, context";
const runRow = async (id: string) => (await asOperator((c) => one<Run>(c, `select ${RUN_COLS} from runs where id=$1`, [id])))!;
const runsOf = (wf: string, contactId: string) => asOperator((c) => many<Run>(c, `select ${RUN_COLS} from runs where workflow_id=$1 and contact_id=$2 order by started_at, id`, [wf, contactId]));
const steps = (runId: string) => asOperator((c) => many<{ node_id: string; status: string; result: Record<string, unknown>; error: string | null }>(c, "select node_id, status, result, error from run_steps where run_id=$1 order by started_at, id", [runId]));
const sendsOf = (runId: string) => asOperator((c) => many<{ channel: string; status: string; suppressed_reason: string | null; error: string | null; idempotency_key: string }>(c, "select channel, status, suppressed_reason, error, idempotency_key from sends where run_id=$1 order by idempotency_key", [runId]));
const replicaCards = (contactId: string) => asOperator((c) => many<{ ghl_opportunity_id: string | null; ghl_stage_id: string; status: string; name: string }>(c, "select ghl_opportunity_id, ghl_stage_id, status, name from pipeline_cards where company_id=$1 and contact_id=$2 order by created_at", [companyId, contactId]));
const openAlerts = () => asOperator((c) => many<{ key: string; level: string; text: string }>(c, "select key, level, text from alerts where company_id=$1 and resolved_at is null order by key", [companyId]));
const wake = (id: string) => asOperator((c) => c.query("update runs set next_run_at=now(), claimed_at=null where id=$1 and status in ('active','waiting')", [id]));
/** What "Retry this step" will do from the dashboard: back to active at the step it stopped on. Today that is a stopped run's only way forward. */
const retryByHand = (id: string) => asOperator((c) => c.query("update runs set status='active', next_run_at=now(), claimed_at=null, finished_at=null where id=$1", [id]));
/** Ticks, waking the run between, so a run parked on a retry is looked at again without waiting for its clock. */
const spin = async (id: string, n = 3) => { for (let i = 0; i < n; i++) { await tickOnce(); await wake(id); } };
const dueIn = (r: Run) => (r.next_run_at ? (r.next_run_at.getTime() - Date.now()) / 60e3 : null);
const cardsIn = (ghlId: string) => [...cards.values()].filter((k) => k.contactId === ghlId);
const pollRep: PollReport = { companies: 1, contacts: 0, appointmentsNew: 0, appointmentsChanged: 0, inbound: 0, calls: 0, agreements: 0, cardsMoved: 0, eventsDispatched: 0, baselined: 0, errors: [] };
const tickRep: TickReport = { claimed: 0, completed: 0, waiting: 0, exited: 0, failed: 0, paused: 0, recovery: false, staleExits: 0, sends: 0 };
const collect = () => asOperator((c) => collectThisTick(c, pollRep, tickRep, new Date()));
const resetAlerts = () => asOperator(async (c) => { await c.query("delete from alerts where company_id=$1", [companyId]); await c.query("insert into engine_state (key, value, updated_at) values ('alerts_cursor', $1, now()) on conflict (key) do update set value=$1", [{ since: new Date().toISOString() }]); });
const handCard = (ghlId: string, over: Partial<LiveCard> = {}): LiveCard => { const k: LiveCard = { id: nextId("hand"), pipelineId: CRM.pipeline_setter, stageId: "STAGE-OTHER", status: "open", name: `${nameOf(ghlId)} -- By hand`, updatedAt: new Date(Date.now() - 60e3).toISOString(), contactId: ghlId, ...over }; cards.set(k.id, k); return k; };
const appointment = (contactId: string, ghlId: string, source: "ghl" | "calendly") => asOperator(async (c) => {
  const ext = nextId("appt"); const starts = new Date(Date.now() + 3 * 864e5);
  apptStore.set(ext, { id: ext, calendarId: "CAL", contactId: ghlId, startTime: starts.toISOString(), endTime: new Date(starts.getTime() + 45 * 60e3).toISOString(), status: "confirmed", raw: {} });
  return (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status) values ($1,$2,$3,$4,$5,$6,$7,now(),'confirmed') returning id", [companyId, contactId, source, ext, closingTerm, starts, new Date(starts.getTime() + 45 * 60e3)]))!.id;
});

describe.skipIf(!HAS_DB)("step failures: every step, every error", () => {
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    await wipe("stepf");
    const r = await installCompany({ name: "Step Failures", slug: "stepf", timezone: TZ, locationId: "LOC-STEPF", pit: "pit-fake", calendars: { CAL: "closing" }, enable: true, templates: ["new-lead", "speed-to-lead"], crm: CRM, anthropicKey: "sk-fake", jevKey: "jev-fake", slack: { bookings: "C-BOOK" }, contractValueDefault: 2999 }, fake);
    companyId = r.companyId;
    await asOperator(async (c) => {
      await c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, channels) values ($1,'T1',$2,'UBOT','{}')", [companyId, encrypt("xoxb-fake")]);
      closingTerm = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
    });
    wfNewLead = await templateWf("new-lead"); wfS2L = await templateWf("speed-to-lead");
    wfTag = await probe("Probe: tag", [{ id: "n1", type: "set_tag", tag: "stat-probe" }]);
    wfCard = await probe("Probe: card", [{ id: "n1", type: "pipeline_card", pipeline: "{{crm.pipeline_setter}}", stage: "{{crm.stage_setter_new_lead}}", name: "{{contact.name}} -- New" }]);
    wfCardSkip = await probe("Probe: card, skip when missing", [{ id: "n1", type: "pipeline_card", pipeline: "{{crm.pipeline_setter}}", stage: "{{crm.stage_setter_new_lead}}", if_missing: "skip" }]);
    wfCardStatus = await probe("Probe: card status only", [{ id: "n1", type: "pipeline_card", pipeline: "{{crm.pipeline_setter}}", status: "lost" }]);
    wfNote = await probe("Probe: note", [{ id: "n1", type: "note", template: "Probe note for {{contact.name}}" }]);
    wfTask = await probe("Probe: task", [{ id: "n1", type: "create_task", title: "Call {{contact.name}}", due: "+1d" }]);
    wfRecord = await probe("Probe: record", [{ id: "n1", type: "crm_record", object: "custom_objects.probe", key: "{{event.key}}", properties: { amount: "100", note: "{{contact.name}}" } }]);
    wfContact = await probe("Probe: update contact", [{ id: "n1", type: "update_contact", set: { first_name: "Probed" } }]);
    wfSlack = await probe("Probe: slack", [{ id: "n1", type: "slack_post", channel: "{{slack.channel.bookings}}", template: "Probe post for {{contact.name}}" }, { id: "n2", type: "slack_post", channel: "{{slack.channel.bookings}}", template: "Second post for {{contact.name}}" }]);
    wfNotify = await probe("Probe: notify owner", [{ id: "n1", type: "notify_owner", template: "Owner, look at {{contact.name}}", fallback_channel: "{{slack.channel.bookings}}", task: { title: "Follow up with {{contact.name}}", due: "+1d" } }]);
    wfClassify = await probe("Probe: classify", [{ id: "n1", type: "classify", input: "{{event.text}}", domain: "reply_intent", into: "vars.intent", threshold: 0.8 }]);
    wfAnalyze = await probe("Probe: analyze", [{ id: "n1", type: "analyze", prompt: "Summarize the call.", input: "{{event.text}}", into: "summary" }]);
    wfAnalyzeOpt = await probe("Probe: analyze, optional", [{ id: "n1", type: "analyze", prompt: "Summarize the call.", input: "{{event.text}}", into: "summary", optional: true }]);
    wfAppt = await probe("Probe: update appointment", [{ id: "n1", type: "update_appointment", set: { status: "confirmed" } }], { premise: "none" });
    wfBranch = await probe("Probe: branch with no else", [{ id: "n1", type: "branch" }], { edges: [{ from: "t1", to: "n1" }, { from: "n1", to: "x1", when: { eq: ["{{event.never}}", "yes"] } }] });
    wfRecordEv = await probe("Probe: record", [{ id: "n1", type: "record", event: "call.logged", data: { nothing: "{{vars.absent.path}}", name: "{{contact.name}}" } }]);
    wfCheck = await probe("Probe: check on an absent path", [{ id: "n1", type: "check", when: { exists: "contact.fields.no_such_field" }, else_exit: "no_such_field" }]);
  });
  beforeEach(() => { calls.clear(); plans.clear(); });

  // ================================================================================================================
  describe("the four bad bugs: one run, one card, one message, zero charges", () => {
    it.fails("20 cards (503 twice, then ok): the card step is retried in place at 1 min then 5 min, one card is made, the run completes — today the run fails on the first 503 and no card is made", async () => {
      fail("createOpportunity", { status: 503, times: 2 });
      const ct = await person("CARD503");
      const id = await start(wfNewLead, ct);
      await tickOnce();
      let r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n2" }); expect(dueIn(r)).toBeGreaterThan(0.7); expect(dueIn(r)).toBeLessThan(1.3);
      await wake(id); await tickOnce();
      r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n2" }); expect(dueIn(r)).toBeGreaterThan(4.5); expect(dueIn(r)).toBeLessThan(5.5);
      await wake(id); await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      expect(callsTo("createOpportunity")).toBe(3);
      expect(cardsIn("CARD503")).toHaveLength(1);
      expect(await replicaCards(ct)).toHaveLength(1);
      expect(await runsOf(wfNewLead, ct)).toHaveLength(1);
    });

    it("20 cards, the invariant that holds today: a card step that keeps failing never makes a second run, never re-runs the trigger, and the CRM holds at most one card for the person", async () => {
      fail("createOpportunity", { status: 503, times: 2 });
      const ct = await person("CARDINV");
      const id = await start(wfNewLead, ct);
      await spin(id, 4);
      expect(await runsOf(wfNewLead, ct)).toHaveLength(1);
      expect((await steps(id)).filter((s) => s.node_id === "t1")).toHaveLength(1);
      expect(cardsIn("CARDINV").length).toBeLessThanOrEqual(1);
      expect((await replicaCards(ct)).length).toBeLessThanOrEqual(1);
    });

    it("20 cards (crash after the CRM made the card): however many looks follow, the CRM holds exactly one card and createOpportunity was asked once", async () => {
      fail("createOpportunity", { after: true, message: "connection terminated after the CRM answered" });
      const ct = await person("CARDCRASH");
      const id = await start(wfNewLead, ct);
      await spin(id, 3);
      expect(callsTo("createOpportunity")).toBe(1);
      expect(cardsIn("CARDCRASH")).toHaveLength(1);
      expect(await runsOf(wfNewLead, ct)).toHaveLength(1);
    });

    it.fails("20 cards (crash after the CRM made the card): the retry reads the CRM first (D41), adopts the card the crashed attempt made, and the run completes with one card on both sides — today the run is failed for good and the replica never learns of the card", async () => {
      fail("createOpportunity", { after: true, message: "connection terminated after the CRM answered" });
      const ct = await person("CARDADOPT");
      const id = await start(wfNewLead, ct);
      await spin(id, 3);
      expect((await runRow(id)).status).toBe("completed");
      const [made] = cardsIn("CARDADOPT"); expect(cardsIn("CARDADOPT")).toHaveLength(1);
      expect(await replicaCards(ct)).toEqual([expect.objectContaining({ ghl_opportunity_id: made.id, ghl_stage_id: CRM.stage_setter_new_lead })]);
      expect(callsTo("createOpportunity")).toBe(1);
    });

    it.fails("20 messages (503 twice, then ok): the text is retried in place and goes out once; one sent row for that step — today the refusal is written as failed and the step is skipped, so the text never goes", async () => {
      fail("sendSms", { status: 503, times: 2 });
      const ct = await person("SMS503");
      const id = await start(wfS2L, ct);
      await tickOnce();
      let r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n2" }); expect(dueIn(r)).toBeGreaterThan(0.7); expect(dueIn(r)).toBeLessThan(1.3);
      await wake(id); await tickOnce();
      r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n2" }); expect(dueIn(r)).toBeGreaterThan(4.5); expect(dueIn(r)).toBeLessThan(5.5);
      await wake(id); await tickOnce();
      expect((await runRow(id))).toMatchObject({ status: "waiting", current_node: "n3" });   // on to the reply wait
      expect(callsTo("sendSms")).toBe(3);
      expect(messages.filter((m) => m.to === "SMS503" && m.kind === "sms")).toHaveLength(1);
      expect((await sendsOf(id)).filter((s) => s.channel === "sms")).toEqual([expect.objectContaining({ status: "sent" })]);
    });

    it("20 messages, the invariant that holds today: a text whose send keeps failing is never sent twice, and the ledger holds one row for that step however many ticks pass", async () => {
      fail("sendSms", { status: 503, times: 2 });
      const ct = await person("SMSINV");
      const id = await start(wfS2L, ct);
      await spin(id, 4);
      expect(messages.filter((m) => m.to === "SMSINV" && m.kind === "sms").length).toBeLessThanOrEqual(1);
      expect((await sendsOf(id)).filter((s) => s.channel === "sms")).toHaveLength(1);
      expect(await runsOf(wfS2L, ct)).toHaveLength(1);
    });

    it("20 messages (crash after the CRM accepted the text): the person got exactly one text, whatever happens to the run afterwards", async () => {
      fail("sendSms", { after: true, message: "connection terminated after the CRM accepted" });
      const ct = await person("SMSCRASH");
      const id = await start(wfS2L, ct);
      await spin(id, 3);
      expect(callsTo("sendSms")).toBe(1);
      expect(messages.filter((m) => m.to === "SMSCRASH" && m.kind === "sms")).toHaveLength(1);
      expect(await runsOf(wfS2L, ct)).toHaveLength(1);
    });

    it.fails("20 messages (crash after the CRM accepted the text): the retry finds the send row and skips the step as already sent; the run goes on to the reply wait with one text out — today the run is failed for good", async () => {
      fail("sendSms", { after: true, message: "connection terminated after the CRM accepted" });
      const ct = await person("SMSRESUME");
      const id = await start(wfS2L, ct);
      await spin(id, 3);
      expect(await runRow(id)).toMatchObject({ status: "waiting", current_node: "n3" });
      expect(messages.filter((m) => m.to === "SMSRESUME" && m.kind === "sms")).toHaveLength(1);
      expect(callsTo("sendSms")).toBe(1);
    });

    it("20 runs: the same lead.created delivered twice starts Speed to lead once (once_per_contact); a failing step never starts a second run of the same workflow", async () => {
      const ct = await person("RUNS2");
      const a = await start(wfS2L, ct);
      await expect(start(wfS2L, ct)).rejects.toThrow(/not started/);
      fail("sendEmail", { status: 503, times: 99 });
      await spin(a, 3);
      expect(await runsOf(wfS2L, ct)).toHaveLength(1);
      expect((await steps(a)).filter((s) => s.node_id === "t1")).toHaveLength(1);
    });

    it("20 charges: the engine has no way to move money (no adapter does, no adapter file mentions it), and a payment delivered twice is recorded once", async () => {
      const methods = Object.values(fake).flatMap((group) => (group && typeof group === "object" ? Object.keys(group) : []));
      expect(methods.filter((m) => /charge|refund|invoice|checkout|bill/i.test(m))).toEqual([]);
      const dir = new URL("../adapters/", import.meta.url);
      const walk = (u: URL): URL[] => readdirSync(u).flatMap((f) => { const p = new URL(f + (statSync(new URL(f, u)).isDirectory() ? "/" : ""), u); return p.pathname.endsWith("/") ? walk(p) : [p]; });
      const mentions = walk(dir).filter((u) => /\.ts$/.test(u.pathname) && !/\.test\.ts$/.test(u.pathname)).filter((u) => /\bcharge\b|\/payments\b.*POST|create_charge|createCharge/i.test(readFileSync(u, "utf8")));
      expect(mentions.map((u) => u.pathname)).toEqual([]);
      const ct = await person("PAY2");
      const first = await asOperator((c) => applyPayment(c, companyId, ct, { whopPaymentId: "pay_stepf_1", amount: 500, currency: "usd", status: "succeeded", paidAt: new Date(), raw: {} }));
      const again = await asOperator((c) => applyPayment(c, companyId, ct, { whopPaymentId: "pay_stepf_1", amount: 500, currency: "usd", status: "succeeded", paidAt: new Date(), raw: {} }));
      expect(Number(first.id)).toBeGreaterThan(0); expect(again.id).toBe(-1);
      expect(await asOperator((c) => many(c, "select id from payments where company_id=$1 and whop_payment_id='pay_stepf_1'", [companyId]))).toHaveLength(1);
    });
  });

  // ================================================================================================================
  describe("how an error is classified (a tag write, the simplest CRM step)", () => {
    it.fails("401: the run pauses at the step with the vendor's words, the CRM is asked once per run, and two runs that hit it are one alert for the vendor — today both runs fail and each workflow is its own alert", async () => {
      await resetAlerts();
      fail("addTag", { status: 401, times: 99 });
      const a = await person("AUTH1"), b = await person("AUTH2");
      const r1 = await start(wfTag, a), r2 = await start(wfNewLead, b);
      await tickOnce(); await collect();
      expect(await runRow(r1)).toMatchObject({ status: "paused", current_node: "n1", exit_reason: expect.stringMatching(/401|Invalid JWT/) });
      expect(await runRow(r2)).toMatchObject({ status: "paused", current_node: "n3" });
      expect(callsTo("addTag")).toBe(2);
      expect(await openAlerts()).toHaveLength(1);
    });

    it("400: never retried — three looks, one call, one run (true today because the run fails for good)", async () => {
      fail("addTag", { status: 400, times: 99 });
      const ct = await person("BAD400");
      const id = await start(wfTag, ct);
      await spin(id, 3);
      expect(callsTo("addTag")).toBe(1);
      expect((await runRow(id)).status).not.toBe("completed");
      expect(await runsOf(wfTag, ct)).toHaveLength(1);
    });

    it.fails("400: the run pauses at the step with the vendor's words, never fails — today it is failed", async () => {
      fail("addTag", { status: 400, times: 99 });
      const ct = await person("BAD400P");
      const id = await start(wfTag, ct);
      await tickOnce();
      expect(await runRow(id)).toMatchObject({ status: "paused", current_node: "n1", exit_reason: expect.stringMatching(/Invalid request|400/), next_run_at: null });
      expect(callsTo("addTag")).toBe(1);
    });

    it.fails("404 on a tag write (the CRM has no such contact): the run stops at once, is not failed, and the CRM is asked once — today the run is failed", async () => {
      fail("addTag", { status: 404, times: 99 });
      const ct = await person("GONE404");
      const id = await start(wfTag, ct);
      await spin(id, 2);
      expect(["paused", "exited"]).toContain((await runRow(id)).status);
      expect(callsTo("addTag")).toBe(1);
    });

    it.fails("503 that never clears: retried at 1 min, 5 min, 15 min and 1 h on the same step, then paused; five calls, one run — today the first 503 fails the run", async () => {
      fail("addTag", { status: 503, times: 99 });
      const ct = await person("DOWN503");
      const id = await start(wfTag, ct);
      for (const minutes of [1, 5, 15, 60]) {
        await tickOnce();
        const r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n1" });
        expect(dueIn(r)).toBeGreaterThan(minutes * 0.8); expect(dueIn(r)).toBeLessThan(minutes * 1.2);
        await wake(id);
      }
      await tickOnce();
      expect(await runRow(id)).toMatchObject({ status: "paused", current_node: "n1" });
      expect(callsTo("addTag")).toBe(5);
      expect(await runsOf(wfTag, ct)).toHaveLength(1);
    });

    it.fails("429 (the client already waited 1.5 s and 3 s, client.ts:19): transient, retried a minute later, the run completes when the CRM answers — today the run fails", async () => {
      fail("addTag", { status: 429 });
      const ct = await person("RATE429");
      const id = await start(wfTag, ct);
      await tickOnce();
      const r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n1" }); expect(dueIn(r)).toBeGreaterThan(0.7); expect(dueIn(r)).toBeLessThan(1.3);
      await wake(id); await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      expect(callsTo("addTag")).toBe(2); expect(tagsOn.get("RATE429")).toEqual(["stat-probe"]);
    });

    it.fails("a network error (ECONNRESET, no status): transient, retried a minute later — today the run fails", async () => {
      fail("addTag", { message: "fetch failed: ECONNRESET" });
      const ct = await person("NET1");
      const id = await start(wfTag, ct);
      await tickOnce();
      const r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n1" }); expect(dueIn(r)).toBeGreaterThan(0.7); expect(dueIn(r)).toBeLessThan(1.3);
      await wake(id); await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      expect(callsTo("addTag")).toBe(2);
    });

    it.fails("an error nobody classified (no status, not a network word): one retry a minute later, then the run pauses — today the run fails at once", async () => {
      fail("addTag", { message: "TypeError: Cannot read properties of undefined (reading 'id')", times: 99 });
      const ct = await person("UNK1");
      const id = await start(wfTag, ct);
      await tickOnce();
      const r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n1" }); expect(dueIn(r)).toBeGreaterThan(0.7); expect(dueIn(r)).toBeLessThan(1.3);
      await wake(id); await tickOnce();
      expect(await runRow(id)).toMatchObject({ status: "paused", current_node: "n1" });
      expect(callsTo("addTag")).toBe(2);
    });

    it("a stopped run retried by hand resumes at the step that stopped it, never from the top: the trigger ran once, the tag went on once", async () => {
      fail("addTag", { status: 503 });
      const ct = await person("HAND1");
      const id = await start(wfTag, ct);
      await tickOnce();
      expect((await runRow(id)).status).not.toBe("completed");
      await retryByHand(id); await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      expect((await steps(id)).filter((s) => s.node_id === "t1")).toHaveLength(1);
      expect(callsTo("addTag")).toBe(2);
      expect(tagsOn.get("HAND1")).toEqual(["stat-probe"]);
    });

    it.fails("a contact with no CRM id yet: a tag step pauses with the reason (nothing to write to), never fails — today the run is failed", async () => {
      const ct = await asOperator(async (c) => (await one<{ id: string }>(c, "insert into contacts (company_id, first_name, last_name) values ($1,'Form','Only') returning id", [companyId]))!.id);
      const id = await start(wfTag, ct);
      await tickOnce();
      expect(await runRow(id)).toMatchObject({ status: "paused", current_node: "n1", exit_reason: expect.stringMatching(/no CRM id/) });
      expect(callsTo("addTag")).toBe(0);
    });
  });

  // ================================================================================================================
  describe("pipeline_card", () => {
    it("the setter card is already on the board in another column (made by a hand or a CRM workflow): it is read, adopted and moved; nothing is created", async () => {
      const ct = await person("MOVED1");
      const hand = handCard("MOVED1");
      const id = await start(wfNewLead, ct);
      await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      expect(callsTo("createOpportunity")).toBe(0); expect(callsTo("updateOpportunity")).toBe(1);
      expect(cardsIn("MOVED1")).toEqual([expect.objectContaining({ id: hand.id, stageId: CRM.stage_setter_new_lead })]);
      expect(await replicaCards(ct)).toEqual([expect.objectContaining({ ghl_opportunity_id: hand.id, ghl_stage_id: CRM.stage_setter_new_lead })]);
      expect((await steps(id)).find((s) => s.node_id === "n2")!.result).toMatchObject({ card: "moved", from_stage: "STAGE-OTHER" });
    });

    it("the card is already where the step would put it (same stage, same name): no CRM write at all (D61)", async () => {
      const ct = await person("THERE1");
      handCard("THERE1", { stageId: CRM.stage_setter_new_lead, name: `${nameOf("THERE1")} -- New` });
      const id = await start(wfCard, ct);
      await tickOnce();
      expect((await steps(id)).find((s) => s.node_id === "n1")).toMatchObject({ status: "skipped", result: expect.objectContaining({ why: "already there" }) });
      expect(callsTo("createOpportunity")).toBe(0); expect(callsTo("updateOpportunity")).toBe(0);
      expect((await runRow(id)).status).toBe("completed");
    });

    it("two open cards on the same board: one is moved, the other left alone, nothing is created", async () => {
      const ct = await person("TWO1");
      handCard("TWO1"); handCard("TWO1", { name: `${nameOf("TWO1")} -- Second` });
      const id = await start(wfCard, ct);
      await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      expect(callsTo("createOpportunity")).toBe(0); expect(callsTo("updateOpportunity")).toBe(1);
      expect(cardsIn("TWO1").filter((k) => k.stageId === CRM.stage_setter_new_lead)).toHaveLength(1);
      expect(cardsIn("TWO1")).toHaveLength(2);
    });

    it("no card and the step says if_missing: skip — nothing is made, the run goes on", async () => {
      const ct = await person("SKIP1");
      const id = await start(wfCardSkip, ct);
      await tickOnce();
      expect((await steps(id)).find((s) => s.node_id === "n1")).toMatchObject({ status: "skipped", result: expect.objectContaining({ why: expect.stringMatching(/never creates one/) }) });
      expect(callsTo("createOpportunity")).toBe(0); expect((await runRow(id)).status).toBe("completed");
    });

    it("a status-only step (mark lost) with no open card on the board: nothing to mark, nothing made", async () => {
      const ct = await person("STAT1");
      const id = await start(wfCardStatus, ct);
      await tickOnce();
      expect((await steps(id)).find((s) => s.node_id === "n1")).toMatchObject({ status: "skipped", result: expect.objectContaining({ why: expect.stringMatching(/no open card on this board to mark lost/) }) });
      expect(callsTo("createOpportunity")).toBe(0); expect(callsTo("updateOpportunity")).toBe(0);
    });

    it("the closer closed the card by hand (won): it is history, not the open card; a step with a stage makes a fresh open card", async () => {
      const ct = await person("WON1");
      const won = handCard("WON1", { status: "won" });
      const id = await start(wfCard, ct);
      await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      expect(callsTo("updateOpportunity")).toBe(0); expect(callsTo("createOpportunity")).toBe(1);
      expect(cardsIn("WON1").map((k) => k.status).sort()).toEqual(["open", "won"]);
      expect(cards.get(won.id)!.status).toBe("won");
    });

    it("a card the closer moved by hand since the engine last wrote it: the run's read sees the hand (one card.moved event), no new card is made", async () => {
      const ct = await person("HAND2");
      const first = await start(wfCard, ct); await tickOnce();
      expect((await runRow(first)).status).toBe("completed");
      const [made] = cardsIn("HAND2"); expect(made.stageId).toBe(CRM.stage_setter_new_lead);
      Object.assign(made, { stageId: "STAGE-OTHER", updatedAt: new Date(Date.now() + 5000).toISOString(), updatedBy: "U1" });
      const second = await start(wfCard, ct); await tickOnce();
      expect((await runRow(second)).status).toBe("completed");
      const moved = await asOperator((c) => many<{ data: Record<string, unknown> }>(c, "select data from events where company_id=$1 and contact_id=$2 and event_type='card.moved'", [companyId, ct]));
      expect(moved).toHaveLength(1); expect(moved[0].data).toMatchObject({ from_stage: CRM.stage_setter_new_lead, to_stage: "STAGE-OTHER", by: "crm" });
      expect(callsTo("createOpportunity")).toBe(1); expect(cardsIn("HAND2")).toHaveLength(1);
    });

    it.fails("the CRM cannot be read for the contact's cards (503): the step is retried, not failed; one card when the CRM answers — today the step fails the run (executor.ts:404)", async () => {
      fail("openCards", { status: 503 });
      const ct = await person("READ503");
      const id = await start(wfCard, ct);
      await tickOnce();
      const r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n1" }); expect(dueIn(r)).toBeGreaterThan(0.7); expect(dueIn(r)).toBeLessThan(1.3);
      await wake(id); await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      expect(callsTo("createOpportunity")).toBe(1); expect(cardsIn("READ503")).toHaveLength(1);
    });

    it.fails("the card was deleted in the CRM between the read and the write (updateOpportunity 404): the run pauses with the CRM's words, asked once — today the run is failed", async () => {
      const ct = await person("DEL404");
      handCard("DEL404");
      fail("updateOpportunity", { status: 404, times: 99 });
      const id = await start(wfCard, ct);
      await spin(id, 2);
      expect(await runRow(id)).toMatchObject({ status: "paused", current_node: "n1", exit_reason: expect.stringMatching(/not found|404/) });
      expect(callsTo("updateOpportunity")).toBe(1); expect(callsTo("createOpportunity")).toBe(0);
    });

    it("shadow: the CRM is read (cards first, D41) but never written; a replica card with no CRM id, the run completes", async () => {
      await asOperator((c) => c.query("update companies set mode='shadow' where id=$1", [companyId]));
      try {
        const ct = await person("SHADOW1");
        const id = await start(wfNewLead, ct);
        await tickOnce();
        expect((await runRow(id)).status).toBe("completed");
        expect(callsTo("openCards")).toBeGreaterThan(0); expect(callsTo("createOpportunity")).toBe(0); expect(callsTo("addTag")).toBe(0);
        expect(await replicaCards(ct)).toEqual([expect.objectContaining({ ghl_opportunity_id: null, ghl_stage_id: CRM.stage_setter_new_lead })]);
      } finally { await asOperator((c) => c.query("update companies set mode='live' where id=$1", [companyId])); }
    });
  });

  // ================================================================================================================
  describe("send_sms / send_email", () => {
    it("no phone on the contact: the text is suppressed with the reason, the CRM is never asked, the run goes on to the reply wait", async () => {
      const ct = await person("NOPHONE", { phone: undefined });
      const id = await start(wfS2L, ct);
      await tickOnce();
      expect(await runRow(id)).toMatchObject({ status: "waiting", current_node: "n3" });
      expect(callsTo("sendSms")).toBe(0); expect(callsTo("sendEmail")).toBe(1);
      expect((await sendsOf(id)).find((s) => s.channel === "sms")).toMatchObject({ status: "suppressed", suppressed_reason: "no phone on the contact" });
      expect((await steps(id)).find((s) => s.node_id === "n2")).toMatchObject({ status: "skipped", result: { kind: "noop", why: "no phone on the contact" } });
    });

    it("no email on the contact: the email is suppressed with the reason, the CRM is never asked, the text still goes", async () => {
      const ct = await person("NOEMAIL", { email: undefined });
      const id = await start(wfS2L, ct);
      await tickOnce();
      expect(await runRow(id)).toMatchObject({ status: "waiting", current_node: "n3" });
      expect(callsTo("sendEmail")).toBe(0); expect(callsTo("sendSms")).toBe(1);
      expect((await sendsOf(id)).find((s) => s.channel === "email")).toMatchObject({ status: "suppressed", suppressed_reason: "no email on the contact" });
    });

    it("the company has no SMS number (sms_enabled false): the text is suppressed, the CRM is never asked", async () => {
      await asOperator((c) => c.query("update companies set sms_enabled=false where id=$1", [companyId]));
      try {
        const ct = await person("NOSMS");
        const id = await start(wfS2L, ct);
        await tickOnce();
        expect(callsTo("sendSms")).toBe(0);
        expect((await sendsOf(id)).find((s) => s.channel === "sms")).toMatchObject({ status: "suppressed", suppressed_reason: expect.stringMatching(/sms_disabled/) });
        expect(await runRow(id)).toMatchObject({ status: "waiting", current_node: "n3" });
      } finally { await asOperator((c) => c.query("update companies set sms_enabled=true where id=$1", [companyId])); }
    });

    it("the contact is deleted in the CRM mid-run: the next send learns it, the replica is marked once, the run exits moot at its next look — once, with no further sends", async () => {
      const ct = await person("DELMID");
      const id = await start(wfS2L, ct);
      await tickOnce();
      expect(await runRow(id)).toMatchObject({ status: "waiting", current_node: "n3" });
      crm.delete("DELMID");
      await asOperator((c) => c.query("update runs set next_run_at=now(), context = jsonb_set(context, '{vars,__wait_for_reply,n3,deadline}', to_jsonb($2::text), true) where id=$1", [id, new Date(Date.now() - 60e3).toISOString()]));
      await tickOnce();
      expect(await asOperator((c) => one<{ gone_at: Date | null }>(c, "select gone_at from contacts where id=$1", [ct]))).toMatchObject({ gone_at: expect.any(Date) });
      expect((await openAlerts()).filter((a) => a.key === `contact:gone:${ct}`)).toHaveLength(1);
      await tickOnce(); await tickOnce();
      expect(await runRow(id)).toMatchObject({ status: "exited", exit_reason: "moot: contact gone" });
      expect(messages.filter((m) => m.to === "DELMID")).toHaveLength(2);   // the email and the text before the deletion; nothing after
      expect(await runsOf(wfS2L, ct)).toHaveLength(1);
    });

    it.fails("401 on a send (the token was rotated): the run pauses at the step, one call, no message — today the refusal is written and the run walks on, failing every CRM step after it", async () => {
      fail("sendEmail", { status: 401, times: 99 });
      const ct = await person("SEND401");
      const id = await start(wfS2L, ct);
      await tickOnce();
      expect(await runRow(id)).toMatchObject({ status: "paused", current_node: "n1", exit_reason: expect.stringMatching(/401|Invalid JWT/) });
      expect(callsTo("sendEmail")).toBe(1); expect(callsTo("sendSms")).toBe(0);
    });

    it.todo("400 on a send (the CRM says the number is invalid): the policy says pause with the vendor's words; D56/G1 says write the refusal, skip the step as blocked and carry on — decide which, then pin it");

    it.fails("a contact with no CRM id yet is not a contact the CRM has lost: the send is skipped with the reason, the CRM is never asked, nothing is stamped gone — today the CRM is asked for contact 'undefined', answers not found, and the person is marked gone (executor.ts:116,124)", async () => {
      const ct = await asOperator(async (c) => { const id = (await one<{ id: string }>(c, "insert into contacts (company_id, first_name, last_name) values ($1,'Form','Lead') returning id", [companyId]))!.id; await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone','+16025559999'),($1,$2,'email','formlead@x.com')", [companyId, id]); return id; });
      const id = await start(wfS2L, ct);
      await tickOnce(); await tickOnce();
      expect(callsTo("sendEmail")).toBe(0); expect(callsTo("sendSms")).toBe(0);
      expect(await asOperator((c) => one<{ gone_at: Date | null }>(c, "select gone_at from contacts where id=$1", [ct]))).toMatchObject({ gone_at: null });
      expect((await runRow(id)).status).not.toBe("failed");
    });
  });

  // ================================================================================================================
  describe("slack_post / notify_owner", () => {
    it("Slack refuses the token (invalid_auth): the post is written as failed, the run goes on, and no post is repeated on a second look (D56/G8)", async () => {
      fail("slackPost", { message: "slack: invalid_auth", times: 99 });
      const ct = await person("SLACKAUTH");
      const id = await start(wfSlack, ct);
      await spin(id, 2);
      expect((await runRow(id)).status).toBe("completed");
      expect(callsTo("slackPost")).toBe(2);
      expect(await sendsOf(id)).toEqual([expect.objectContaining({ channel: "slack", status: "failed", error: "slack: invalid_auth" }), expect.objectContaining({ channel: "slack", status: "failed" })]);
      expect(posts.filter((p) => p.text.includes("SLACKAUTH"))).toHaveLength(0);
    });

    it.fails("Slack refuses the token: two steps in one run are one alert for Slack, not one per step — today each blocked step is its own alert (alerts.ts:91)", async () => {
      await resetAlerts();
      fail("slackPost", { message: "slack: invalid_auth", times: 99 });
      const ct = await person("SLACKONE");
      const id = await start(wfSlack, ct);
      await tickOnce(); await collect();
      expect((await runRow(id)).status).toBe("completed");
      expect(await openAlerts()).toHaveLength(1);
    });

    it.fails("Slack says ratelimited (transient): the post is retried in place and goes out once — today it is written as refused and never retried", async () => {
      fail("slackPost", { message: "slack: ratelimited" });
      const ct = await person("SLACKRATE");
      const id = await start(wfSlack, ct);
      await tickOnce();
      const r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n1" }); expect(dueIn(r)).toBeGreaterThan(0.7); expect(dueIn(r)).toBeLessThan(1.3);
      await wake(id); await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      expect(posts.filter((p) => p.text.includes("Probe post for Pat SLACKRATE"))).toHaveLength(1);
      expect(posts.filter((p) => p.text.includes("Second post for Pat SLACKRATE"))).toHaveLength(1);
    });

    it("notify_owner whose task is made and then the call dies: however many looks follow, one task in the CRM (the invariant that holds today, because nothing retries)", async () => {
      fail("createTask", { after: true, message: "connection terminated after the CRM answered" });
      const ct = await person("TASKCRASH");
      const id = await start(wfNotify, ct);
      await spin(id, 3);
      expect(tasks.filter((t) => t.to === "TASKCRASH")).toHaveLength(1);
      expect(callsTo("createTask")).toBe(1);
    });

    it.fails("notify_owner whose task is made and then the call dies: the retry does not make a second task (an effects ledger keys it), the post goes once, the run completes — today the run is failed, and a naive retry would make two tasks (executor.ts:226 has no ledger)", async () => {
      fail("createTask", { after: true, message: "connection terminated after the CRM answered" });
      const ct = await person("TASKONCE");
      const id = await start(wfNotify, ct);
      await spin(id, 3);
      expect((await runRow(id)).status).toBe("completed");
      expect(tasks.filter((t) => t.to === "TASKONCE")).toHaveLength(1);
      expect(posts.filter((p) => p.text.includes("Pat TASKONCE"))).toHaveLength(1);
    });
  });

  // ================================================================================================================
  describe("note / create_task / crm_record / update_contact", () => {
    it("a note whose call dies after the CRM wrote it: one note however many looks follow (the invariant that holds today)", async () => {
      fail("addNote", { after: true, message: "connection terminated after the CRM answered" });
      const ct = await person("NOTECRASH");
      const id = await start(wfNote, ct);
      await spin(id, 3);
      expect(notes.filter((n) => n.to === "NOTECRASH")).toHaveLength(1);
    });

    it.fails("a note the CRM refuses with 503: retried in place, written once — today the step fails the run (executor.ts:369)", async () => {
      fail("addNote", { status: 503 });
      const ct = await person("NOTE503");
      const id = await start(wfNote, ct);
      await tickOnce();
      const r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n1" }); expect(dueIn(r)).toBeGreaterThan(0.7); expect(dueIn(r)).toBeLessThan(1.3);
      await wake(id); await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      expect(notes.filter((n) => n.to === "NOTE503")).toHaveLength(1);
    });

    it.fails("a note whose call dies after the CRM wrote it: the retry does not write it twice (effects ledger) and the run completes — today the run is failed, and a naive retry would write two notes", async () => {
      fail("addNote", { after: true, message: "connection terminated after the CRM answered" });
      const ct = await person("NOTEONCE");
      const id = await start(wfNote, ct);
      await spin(id, 3);
      expect((await runRow(id)).status).toBe("completed");
      expect(notes.filter((n) => n.to === "NOTEONCE")).toHaveLength(1);
    });

    it("a task whose call dies after the CRM made it: one task however many looks follow (the invariant that holds today)", async () => {
      fail("createTask", { after: true, message: "connection terminated after the CRM answered" });
      const ct = await person("TASK2");
      const id = await start(wfTask, ct);
      await spin(id, 3);
      expect(tasks.filter((t) => t.to === "TASK2")).toHaveLength(1);
    });

    it.fails("a custom-object record the CRM refuses with 503 twice: retried in place, created once, our row carries its id — today the run fails on the first 503 (executor.ts:454)", async () => {
      fail("createRecord", { status: 503, times: 2 });
      const ct = await person("REC503");
      const id = await start(wfRecord, ct, { key: "rec-503" });
      await spin(id, 3);
      expect((await runRow(id)).status).toBe("completed");
      expect(callsTo("createRecord")).toBe(3);
      const ours = await asOperator((c) => many<{ ghl_record_id: string | null }>(c, "select ghl_record_id from crm_records where company_id=$1 and record_key='rec-503'", [companyId]));
      expect(ours).toHaveLength(1); expect(records.has(ours[0].ghl_record_id!)).toBe(true);
    });

    it("a record made in the CRM, then the call dies before our row is written: one record in the CRM however many looks follow (the invariant that holds today; a naive retry would create a second, executor.ts:452-458)", async () => {
      fail("createRecord", { after: true, message: "connection terminated after the CRM answered" });
      const ct = await person("RECCRASH");
      const id = await start(wfRecord, ct, { key: "rec-crash" });
      await spin(id, 3);
      expect([...records.values()].filter((r) => r.note === nameOf("RECCRASH"))).toHaveLength(1);
      expect(callsTo("createRecord")).toBe(1);
    });

    it.fails("the record our row points at was deleted in the CRM (updateRecord 404): the run pauses with the CRM's words, asked once — today the run is failed", async () => {
      const ct = await person("RECGONE");
      const first = await start(wfRecord, ct, { key: "rec-gone" }); await tickOnce();
      expect((await runRow(first)).status).toBe("completed");
      const ours = (await asOperator((c) => one<{ ghl_record_id: string }>(c, "select ghl_record_id from crm_records where company_id=$1 and record_key='rec-gone'", [companyId])))!;
      records.delete(ours.ghl_record_id);
      const second = await start(wfRecord, ct, { key: "rec-gone" });
      await spin(second, 2);
      expect(await runRow(second)).toMatchObject({ status: "paused", current_node: "n1", exit_reason: expect.stringMatching(/not found|404/) });
      expect(callsTo("updateRecord")).toBe(1); expect(callsTo("createRecord")).toBe(0);
    });

    it.fails("update_contact the CRM refuses with 503: retried in place, written once — today the run fails (executor.ts:480)", async () => {
      fail("updateContact", { status: 503 });
      const ct = await person("UPD503");
      const id = await start(wfContact, ct);
      await tickOnce();
      const r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n1" });
      await wake(id); await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      expect(callsTo("updateContact")).toBe(2); expect(crm.get("UPD503")!.firstName).toBe("Probed");
    });
  });

  // ================================================================================================================
  describe("classify / analyze", () => {
    it("a reply the classifier is not sure about: the step is ok with unclear and its confidence; the run goes on (a human decides downstream)", async () => {
      fail("classify");   // the fake answers unclear once, as the real one does for a vague reply
      const ct = await person("VAGUE1");
      const id = await start(wfClassify, ct, { text: "hmm maybe" });
      await tickOnce();
      expect((await steps(id)).find((s) => s.node_id === "n1")).toMatchObject({ status: "ok", result: expect.objectContaining({ value: "unclear", confidence: 0 }) });
      expect((await runRow(id)).status).toBe("completed");
      expect((await runRow(id)).context).toMatchObject({ vars: { intent: "unclear" } });
    });

    it.fails("Jev is down (5xx) or refuses the key (401): the step is retried (or paused for the key), not answered 'unclear' — today the adapter hides every HTTP failure as unclear with confidence 0 (classifier.ts:36), so a dead key reads as a stream of vague replies routed to humans", async () => {
      fail("classify", { times: 99 });
      const ct = await person("JEVDOWN");
      const id = await start(wfClassify, ct, { text: "yes see you then" });
      await tickOnce();
      expect(["waiting", "paused"]).toContain((await runRow(id)).status);
      expect((await runRow(id)).current_node).toBe("n1");
    });

    it.fails("an empty transcript / reply: nothing to classify, the step is a noop and Jev is never asked — today Jev is asked about an empty text", async () => {
      const ct = await person("EMPTYCL");
      const id = await start(wfClassify, ct, { text: "" });
      await tickOnce();
      expect(callsTo("classify")).toBe(0);
      expect((await steps(id)).find((s) => s.node_id === "n1")).toMatchObject({ status: "skipped", result: expect.objectContaining({ kind: "noop" }) });
    });

    it("analyze with nothing to read (empty input): a noop, the model is never asked", async () => {
      const ct = await person("EMPTYAN");
      const id = await start(wfAnalyze, ct, { text: "   " });
      await tickOnce();
      expect(callsTo("analyze")).toBe(0);
      expect((await steps(id)).find((s) => s.node_id === "n1")).toMatchObject({ status: "skipped", result: expect.objectContaining({ kind: "noop" }) });
      expect((await runRow(id)).status).toBe("completed");
    });

    it("analyze marked optional when the model is down: skipped as blocked, the run goes on without the value", async () => {
      fail("analyze", { status: 529, times: 99 });
      const ct = await person("ANOPT");
      const id = await start(wfAnalyzeOpt, ct, { text: "a long transcript" });
      await tickOnce();
      expect((await steps(id)).find((s) => s.node_id === "n1")).toMatchObject({ status: "skipped", result: expect.objectContaining({ kind: "blocked" }) });
      expect((await runRow(id)).status).toBe("completed");
    });

    it.fails("analyze when the model is down (529 / 503): retried in place, read once — today the run fails (executor.ts:513 rethrows)", async () => {
      fail("analyze", { status: 529 });
      const ct = await person("AN529");
      const id = await start(wfAnalyze, ct, { text: "a long transcript" });
      await tickOnce();
      const r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n1" }); expect(dueIn(r)).toBeGreaterThan(0.7); expect(dueIn(r)).toBeLessThan(1.3);
      await wake(id); await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      expect(callsTo("analyze")).toBe(2);
    });

    it.fails("analyze when the key is refused (401): the run pauses at once, asked once — today the run fails", async () => {
      fail("analyze", { status: 401, times: 99 });
      const ct = await person("AN401");
      const id = await start(wfAnalyze, ct, { text: "a long transcript" });
      await spin(id, 2);
      expect(await runRow(id)).toMatchObject({ status: "paused", current_node: "n1", exit_reason: expect.stringMatching(/401/) });
      expect(callsTo("analyze")).toBe(1);
    });
  });

  // ================================================================================================================
  describe("update_appointment", () => {
    it("a Calendly booking is read-only to the engine: the step records what it would have written and moves on", async () => {
      const ct = await person("CALLY1");
      const appt = await appointment(ct, "CALLY1", "calendly");
      const id = await start(wfAppt, ct, {}, appt);
      await tickOnce();
      expect(callsTo("updateAppointment")).toBe(0);
      expect((await steps(id)).find((s) => s.node_id === "n1")).toMatchObject({ status: "ok", result: expect.objectContaining({ skipped: true, reason: expect.stringMatching(/read-only/) }) });
      expect((await runRow(id)).status).toBe("completed");
    });

    it.fails("a GHL appointment write the CRM refuses with 503: retried in place, written once — today the run fails (executor.ts:388)", async () => {
      fail("updateAppointment", { status: 503 });
      const ct = await person("APPT503");
      const appt = await appointment(ct, "APPT503", "ghl");
      const id = await start(wfAppt, ct, {}, appt);
      await tickOnce();
      const r = await runRow(id); expect(r).toMatchObject({ status: "waiting", current_node: "n1" });
      await wake(id); await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      expect(callsTo("updateAppointment")).toBe(2);
    });

    it.fails("update_appointment on a run with no appointment: a definition problem, so the run pauses with the reason, never fails — today it is failed", async () => {
      const ct = await person("NOAPPT");
      const id = await start(wfAppt, ct);
      await tickOnce();
      expect(await runRow(id)).toMatchObject({ status: "paused", current_node: "n1", exit_reason: expect.stringMatching(/no appointment/) });
    });
  });

  // ================================================================================================================
  describe("branch / check / record", () => {
    it.fails("a branch with no matching edge and no else: a definition problem, so the run pauses with the reason — today it is failed (executor.ts:348)", async () => {
      const ct = await person("BRANCH1");
      const id = await start(wfBranch, ct, { never: "no" });
      await tickOnce();
      expect(await runRow(id)).toMatchObject({ status: "paused", current_node: "n1", exit_reason: expect.stringMatching(/no edge matched/) });
    });

    it("a check on a path the context cannot name: the condition is simply not met and the gate closes (no error)", async () => {
      const ct = await person("CHECK1");
      const id = await start(wfCheck, ct);
      await tickOnce();
      expect(await runRow(id)).toMatchObject({ status: "completed", exit_reason: "no_such_field" });
    });

    it("record never fails a run: a field whose path is not in the context lands as null, the rest is kept", async () => {
      const ct = await person("RECORD1");
      const id = await start(wfRecordEv, ct);
      await tickOnce();
      expect((await runRow(id)).status).toBe("completed");
      const ev = await asOperator((c) => one<{ data: Record<string, unknown> }>(c, "select data from events where company_id=$1 and contact_id=$2 and event_type='call.logged'", [companyId, ct]));
      expect(ev!.data).toEqual({ nothing: null, name: nameOf("RECORD1") });
    });
  });
});
