/**
 * D79: Jev reads what a setter call achieved — set, follow up, DQ, not interested — through the real setter-call-logged template.
 * D87: one setter result, posted when the booking lands; calls by conversation; closing calls through the dialer; transcripts never stored.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { installCompany, type InstallInput } from "@/engine/install";
import { dispatchEvent } from "@/engine/dispatch";
import { applyAppointment } from "@/engine/poll";
import { loadCompany } from "@/engine/context";
import { tick } from "@/engine/runner";
import { fakeAdapters, fakeProbes } from "@/engine/test-install";
import { recordPhoneCall, recordRecording, settlePhoneCall, phoneFacts } from "@/engine/recordings";
import { reactionArrived } from "@/engine/webhooks/slack";
import { getMetric, parsePeriod } from "@/engine/metric-registry";
import { formatAnswer } from "@/engine/bot-format";
import { discoveryResultMeaning, discoveryResultValues } from "@/engine/setter-result";
import { rollupDay, readMetrics } from "@/engine/metrics";
import { sweepHeldTranscripts } from "@/engine/transcripts";
import { VendorError } from "@/engine/failures";
import type { GhlReads } from "@/adapters/ghl/metrics";
import type { Adapters, CallMedia, Classification, LiveCard } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";

/** Setter-call transcripts and what Jev reads in each (the fake answers by the transcript, the way the real one does). */
const FIXTURES: { phrase: string; read: Classification; reason?: string }[] = [
  { phrase: "booked you with the specialist", read: { value: "set", confidence: 0.92, distribution: { set: 0.92, follow_up: 0.06 }, unclear: false } },
  { phrase: "call me back next week", read: { value: "follow_up", confidence: 0.88, distribution: { follow_up: 0.88, set: 0.08 }, unclear: false } },
  { phrase: "can't afford anything right now", read: { value: "dq", confidence: 0.9, distribution: { dq: 0.9, not_interested: 0.07 }, unclear: false }, reason: "budget" },
  { phrase: "not interested, please stop calling", read: { value: "not_interested", confidence: 0.93, distribution: { not_interested: 0.93, dq: 0.04 }, unclear: false } },
  { phrase: "maybe, I don't really know", read: { value: "unclear", confidence: 0.55, distribution: { follow_up: 0.55, not_interested: 0.3, set: 0.15 }, unclear: true } },
];
const transcript = (phrase: string) => [{ speaker: "0", text: "Hey, it's Allan from the clinic. Got two minutes about the thinning?" }, { speaker: "1", text: "Sure. It's been getting worse for a year." }, { speaker: "0", text: "Got it. So what would you like to do next?" }, { speaker: "1", text: `Honestly, ${phrase}.` }];
const SET = FIXTURES[0].phrase, FOLLOW = FIXTURES[1].phrase, DQ = FIXTURES[2].phrase, NI = FIXTURES[3].phrase, UNSURE = FIXTURES[4].phrase;
/** A closing call: Jev reads it as one, and how it ended. */
const CLOSING = "let's get you started on the program today with two payments";
let failNextTypeRead = 0, failNextKindRead = 0;   // the next N "what kind of call" / "is it a sales call" reads answer 503 (Jev down)

const posts: { channel: string; text: string; threadTs?: string; ts: string }[] = [];
const edits: { channel: string; ts: string; text: string }[] = [];
const reacted: string[] = [], unreacted: string[] = [];
const recordWrites: Record<string, unknown>[] = [];
const tasks: Record<string, unknown>[] = [];
const tags: { contact: string; tag: string }[] = [];
const oppWrites: Record<string, unknown>[] = [];
const liveCards = new Map<string, LiveCard[]>();
const asked: string[] = [], inputs: string[] = [];
/** GHL's dialer transcripts, read back on demand (D87: the engine keeps none) */
const media = new Map<string, CallMedia>(), mediaReads: string[] = [];
const fathomReads: string[] = [];
const DC_FIELDS = ["display_label", "external_id", "contact_id", "occurred_at", "direction", "duration_sec", "setter", "outcome", "recording_url", "led_to_booking"];
const SC_FIELDS = ["display_label", "external_id", "contact_id", "opportunity_id", "scheduled_at", "call_date", "outcome", "recording_url", "transcript_ref", "closer", "duration_min", "disposition", "objection_primary", "next_step", "next_step_date", "payment_terms", "setter"];
const adapters = (withResultField: boolean): Adapters => {
  const base = fakeAdapters();
  return {
    ...base,
    read: { ...base.read, listUsers: async () => [{ id: "U1", name: "Allan Setter", email: "allan@x.com" }, { id: "U2", name: "Tyler Ray", email: "tyler@x.com" }, { id: "U3", name: "James Closer", email: "james@x.com" }],
      openCards: async (_c, id) => liveCards.get(id) ?? [], objectFields: async (_c, o) => (o.endsWith("sales_call") ? SC_FIELDS : withResultField ? [...DC_FIELDS, "call_result"] : DC_FIELDS).map((key) => ({ key })),
      callMedia: async (_c, id) => { mediaReads.push(id); return media.get(id) ?? { transcript: null }; } },
    booking: { ...base.booking, ghl: { ...base.booking.ghl, listCalendars: async () => [{ id: "CAL", name: "Setter link", teamMemberIds: [] }, { id: "CALSELF", name: "Self-booking link", teamMemberIds: [] }] } },
    write: { ...base.write, createRecord: async (_c, o, props) => { recordWrites.push({ op: "create", object: o, ...props }); return { id: `rec-${recordWrites.length}` }; }, updateRecord: async (_c, o, id, props) => { recordWrites.push({ op: "update", object: o, id, ...props }); },
      createTask: async (_c, id, task) => { tasks.push({ contactId: id, ...task }); return { id: `task-${tasks.length}` }; }, addTag: async (_c, id, tag) => { tags.push({ contact: id, tag }); },
      updateOpportunity: async (_c, id, patch) => { oppWrites.push({ op: "update", id, ...patch }); } },
    classifier: { choice: async (_s, input, options, _t, opts): Promise<Classification> => {
      asked.push(options.join(",")); inputs.push(input);
      if (options.includes("setting")) {
        if (failNextTypeRead > 0) { failNextTypeRead--; throw new VendorError("jev", 503, "/classify", "upstream unavailable"); }
        return input.includes(CLOSING) ? { value: "closing", confidence: 0.93, distribution: { closing: 0.93 }, unclear: false } : { value: "setting", confidence: 0.95, distribution: { setting: 0.95 }, unclear: false };
      }
      if (options.includes("sales_call") && failNextKindRead > 0) { failNextKindRead--; throw new VendorError("jev", 503, "/classify", "upstream unavailable"); }
      if (options.includes("sales_call")) return { value: "sales_call", confidence: 0.95, distribution: { sales_call: 0.95 }, unclear: false };
      if (options.includes("closed_won")) return { value: "closed_won", confidence: 0.9, distribution: { closed_won: 0.9 }, unclear: false };
      const f = FIXTURES.find((x) => input.includes(x.phrase));
      if (options.includes("budget")) return { value: f?.reason ?? "other", confidence: 0.8, distribution: { [f?.reason ?? "other"]: 0.8 }, unclear: false };
      expect(opts?.question).toMatch(/achieve/); expect(opts?.criteria && Object.keys(opts.criteria).sort()).toEqual(["dq", "follow_up", "not_interested", "set"]);
      return FIXTURES.filter((x) => input.includes(x.phrase)).sort((a, b) => input.lastIndexOf(b.phrase) - input.lastIndexOf(a.phrase))[0]!.read;   // in a call in parts, what was said last
    } },
    notifier: { ...base.notifier, post: async (_t, channel, text, _as, threadTs) => { const ts = `ts${posts.length + 1}`; posts.push({ channel, text, threadTs, ts }); return { ts }; },
      update: async (_t, channel, ts, text) => { edits.push({ channel, ts, text }); },
      react: async (_t, _ch, ts, emoji) => { reacted.push(`${ts}:${emoji}`); return true; }, unreact: async (_t, _ch, ts, emoji) => { unreacted.push(`${ts}:${emoji}`); return true; } },
    analyst: { analyze: async () => { const parsed = { summary: "Talked about thinning.", digest: "Talked about thinning for a year.\nFit: 7/10", next_step: "Call him Tuesday after work", fit_quality: 7 }; return { text: JSON.stringify(parsed), parsed, model: "fake", usage: { input: 1, output: 1, cacheRead: 0 } }; } },
    recorder: { transcript: async (_k, id) => { fathomReads.push(id); return [{ speaker: "Cal Closer", text: `From Fathom again: ${CLOSING}.` }]; } },
  };
};
const fake = adapters(true), noField = adapters(false);

const TABLES = ["alerts", "slack_posts", "sends", "step_effects", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "recordings", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log", "rollups_daily"];
async function fresh(slug: string, a: Adapters, extra: Partial<InstallInput> = {}): Promise<string> {
  await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
    await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
    await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
    for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
    await c.query("delete from companies where id=$1", [co.id]);
  });
  // CAL is the setter link (a booking through it is a setter's), CALSELF the person's own (D24: the company's rule, as before)
  const r = await installCompany({ name: slug, slug, timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: { CAL: { term: "closing", booking: "setter" }, CALSELF: { term: "closing", booking: "self" } }, templates: ["setter-call-logged", "call-recorded"], enable: true, anthropicKey: "sk-fake",
    crm: { pipeline_setter: "PIPE-SETTER", stage_setter_dq: "STAGE-S-DQ", stage_setter_showed: "STAGE-S-SHOWED", assoc_discovery_call_contact: "ASSOC-DC", assoc_sales_call_contact: "ASSOC-SC", assoc_sales_call_opportunity: "ASSOC-SCO" }, slack: { setter_calls: "CSET", calls: "CCALLS", bookings: "CBOOK" }, ...extra }, a);
  await asOperator(async (c) => {
    await c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59' where id=$1", [r.companyId]);
    await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, channels) values ($1,'T1',$2,'UBOT','{}')", [r.companyId, encrypt("xoxb-fake")]);
    await c.query("update users set slack_user_id='UTYLER' where company_id=$1 and ghl_user_id='U2'", [r.companyId]);
  });
  return r.companyId;
}

let companyId: string;
let n = 0;
const newLead = (co: string) => asOperator(async (c) => {
  const ghl = `SR${++n}`;
  const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,$2,'Lead',$3,$4) returning id", [co, ghl, `No${n}`, TZ]))!.id;
  await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [co, id, `${ghl.toLowerCase()}@x.com`]);
  return { contactId: id, ghl };
});
type Who = { contactId: string; ghl: string };
/**
 * A connected dial (3 minutes unless said), ended `endedAgo` minutes ago, by Allan unless said; GHL holds its transcript (the fake's
 * callMedia), the engine does not. The poll's settle and dispatch, as the minute poll does them.
 */
async function call(phrase: string | null, opts: { endedAgo?: number; sec?: number; co?: string; who?: Who; caller?: string; ext?: string } = {}) {
  const co = opts.co ?? companyId, who = opts.who ?? await newLead(co), sec = opts.sec ?? 180, ext = opts.ext ?? `dial-${who.ghl}-${++n}`;
  if (phrase) media.set(ext, { recordingUrl: `https://ghl.test/${ext}`, transcript: transcript(phrase) });
  const started = new Date(Date.now() - (opts.endedAgo ?? 45) * 60e3 - sec * 1000);
  const rec = await asOperator(async (c) => {
    const { recording } = await recordPhoneCall(c, co, { externalId: ext, contactId: who.contactId, startedAt: started, durationSec: sec, direction: "outbound", status: "completed", callerGhlUserId: opts.caller ?? "U1" });
    const { recording: row, event } = await settlePhoneCall(c, recording, phrase ? media.get(ext)! : { transcript: null });
    await dispatchEvent(c, event!, { contact: { id: who.contactId }, recording: { id: row.id, ...phoneFacts(row) } });
    return row;
  });
  return { ...who, recordingId: rec.id, startedAt: DateTime.fromJSDate(rec.started_at), endedAt: DateTime.fromJSDate(rec.ended_at!), external: ext };
}
/** A booking the poll brings in: through the setter link (CAL) or the person's own (CALSELF), booked at `at`, with this closer, starting `startsIn` from now. */
const book = (who: Who, at: DateTime, o: { self?: boolean; closer?: string; startsIn?: number; co?: string } = {}) => asOperator(async (c) => {
  const { row, adapterCompany } = await loadCompany(c, o.co ?? companyId); const start = DateTime.now().plus({ minutes: o.startsIn ?? 3 * 1440 });
  const id = `A-${who.ghl}-${++n}`;
  await applyAppointment(c, row, adapterCompany, fake, { id, calendarId: o.self ? "CALSELF" : "CAL", contactId: who.ghl, assignedUserId: o.closer ?? "U2", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: at.toISO()!, raw: {} });
  return (await one<{ id: string }>(c, "select id from appointments where company_id=$1 and external_id=$2", [o.co ?? companyId, id]))!.id;
});
const runOf = (contactId: string, slug = "setter-call-logged") => asOperator((c) => one<{ id: string; status: string; current_node: string | null; exit_reason: string | null; next_run_at: Date | null; context: Record<string, unknown> }>(c,
  "select r.id, r.status, r.current_node, r.exit_reason, r.next_run_at, r.context from runs r join workflows w on w.id=r.workflow_id where r.contact_id=$1 and w.name=$2 order by r.started_at desc, r.id desc limit 1", [contactId, slug === "setter-call-logged" ? "Setter call logged" : "Sales call recorded"]));
const runsOf = (contactId: string, name: string) => asOperator((c) => many<{ id: string; status: string; exit_reason: string | null; appointment_id: string | null }>(c, "select r.id, r.status, r.exit_reason, r.appointment_id from runs r join workflows w on w.id=r.workflow_id where r.contact_id=$1 and w.name=$2 order by r.started_at, r.id", [contactId, name]));
const stepsOf = (runId: string) => asOperator((c) => many<{ node_id: string; status: string; result: Record<string, unknown> }>(c, "select node_id, status, result from run_steps where run_id=$1 order by started_at, id", [runId]));
const step = async (runId: string, node: string) => (await stepsOf(runId)).filter((s) => s.node_id === node).at(-1);
const eventsOf = (contactId: string, type: string) => asOperator((c) => many<{ data: Record<string, unknown> }>(c, "select data from events where contact_id=$1 and event_type=$2 order by id", [contactId, type])).then((r) => r.map((x) => x.data));
const analysisOf = (recordingId: string) => asOperator(async (c) => (await one<{ analysis: Record<string, unknown> }>(c, "select analysis from recordings where id=$1", [recordingId]))!.analysis);
const run = (a: Adapters = fake, co = companyId, now: DateTime = DateTime.now()) => tick(a, now as DateTime<true>, co, fakeProbes);
const setBinding = (co: string, key: string, value: string) => asOperator((c) => c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'text',$3) on conflict (company_id, key) do update set value=excluded.value", [co, key, Buffer.from(value)]));
const tsOf = (tag: string, co = companyId) => asOperator(async (c) => (await one<{ ts: string; channel: string }>(c, "select ts, channel from slack_posts where company_id=$1 and tag=$2", [co, tag])));
const tap = (ts: string, reaction: string, co = companyId, channel = "CSET") => asOperator((c) => reactionArrived(c, co, { kind: "reaction", eventId: `Ev${ts}${reaction}`, user: "UTYLER", reaction, channel, ts, removed: false }));
const setterCard = (ghl: string): LiveCard[] => [{ id: `card-${ghl}`, pipelineId: "PIPE-SETTER", stageId: "STAGE-CONTACTED", status: "open", name: `Lead -- Contacted`, updatedAt: new Date(Date.now() - 864e5).toISOString() }];
/** The setter-call post a run made (s1), as rendered. */
const digestOf = async (runId: string) => (await asOperator((c) => one<{ rendered_body: string }>(c, "select rendered_body from sends where run_id=$1 and channel='slack' and idempotency_key like '%:s1'", [runId])))!.rendered_body;
const postOf = (external: string) => tsOf(`setter-call:${external}`);
const wakeAt = (runId: string) => asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [runId]));

describe("the Discovery Call's option keys (discovery_call.results)", () => {
  it("defaults to the four meanings; a company map is inverted to its own keys and read back to meanings", () => {
    expect(discoveryResultValues({})).toEqual({ set: "set", follow_up: "follow_up", dq: "dq", not_interested: "not_interested" });
    const b = { "discovery_call.results": JSON.stringify({ booked: "set", callback: "follow_up", disq: "dq" }) };
    expect(discoveryResultValues(b)).toEqual({ set: "booked", follow_up: "callback", dq: "disq", not_interested: "" });
    expect([discoveryResultMeaning("Callback", b), discoveryResultMeaning(["disq"], b), discoveryResultMeaning("set", b), discoveryResultMeaning("", b)]).toEqual(["follow_up", "dq", null, null]);
  });
});

describe.skipIf(!HAS_DB)("setter call result (D79, D87)", () => {
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    companyId = await fresh("setres", fake);
  });

  it("set: a booking through a setter link made during the call → posted at once as Set, whatever Jev read; Set on the record, the read is on the recording and logged; nothing asked, nothing done", async () => {
    const nRec = recordWrites.length, nTasks = tasks.length;
    const k = await call(FOLLOW, { endedAgo: 2 });
    await book(k, k.startedAt.plus({ minutes: 1 }));
    await run();
    const r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "posted" });   // posted at the transcript: no wait
    expect(recordWrites.slice(nRec)).toEqual([expect.objectContaining({ op: "create", external_id: k.external, call_result: "set" })]);   // no led_to_booking: GHL cannot update a checkbox; call_result carries Set
    expect(await digestOf(r.id)).toContain("*Outcome:* Set — booked through a setter link during the call (Jev read: follow up, 88% sure)");
    expect(await digestOf(r.id)).not.toMatch(/Would have/);
    const analysis = await analysisOf(k.recordingId);
    expect(analysis.classify).toMatchObject({ call_type: { value: "setting" }, result: { value: "follow_up", confidence: 0.88 } });   // the second read does not wipe the first
    expect(await eventsOf(k.contactId, "setter_call.result")).toEqual([expect.objectContaining({ recording_id: k.recordingId, external_id: k.external, predicted: "follow_up", predicted_confidence: "88", result: "set", decided_by: "booking", set_by_booking: true, jev_agreed: false, setter: "Allan Setter", acts: false })]);
    expect(await tsOf(`setter-result:${k.external}`)).toBeFalsy();
    expect(tasks.length).toBe(nTasks);
    expect((await step(r.id, "a4"))?.status).toBe("skipped");   // the DQ reason is read only when it could be a DQ
    expect((await step(r.id, "w_late"))?.status).toBe("skipped");   // already Set: nothing to wait for
  });

  it("follow up / DQ / not interested with the actions OFF (the default): the result is written and the post says what would have happened; no task, tag or card move", async () => {
    const nTasks = tasks.length, nTags = tags.length, nOpp = oppWrites.length, nRec = recordWrites.length;
    const f = await call(FOLLOW), d = await call(DQ), x = await call(NI);
    for (const k of [f, d, x]) liveCards.set(k.ghl, setterCard(k.ghl));
    await run();
    const [rf, rd, rx] = [(await runOf(f.contactId))!, (await runOf(d.contactId))!, (await runOf(x.contactId))!];
    for (const r of [rf, rd, rx]) expect(r).toMatchObject({ status: "completed", exit_reason: "posted" });
    expect(recordWrites.slice(nRec).map((w) => [w.external_id, w.call_result]).sort()).toEqual([[f.external, "follow_up"], [d.external, "dq"], [x.external, "not_interested"]].sort());
    expect(await digestOf(rf.id)).toContain("*Outcome:* Follow up (Jev is 88% sure)\n*Would have (actions are off):* a task for Allan Setter to call back Lead No");
    expect(await digestOf(rd.id)).toContain("*Would have (actions are off):* tag dq-budget and mark the setter card lost.");
    expect(await digestOf(rx.id)).toContain("*Would have (actions are off):* mark the setter card lost.");
    expect([tasks.length, tags.length, oppWrites.length]).toEqual([nTasks, nTags, nOpp]);
    for (const [r, node] of [[rf, "k_task"], [rd, "k_tag"], [rd, "k_lost_dq"], [rx, "k_lost_ni"]] as const) expect((await step(r.id, node))?.status).toBe("skipped");
    expect((await eventsOf(d.contactId, "setter_call.result"))[0]).toMatchObject({ predicted: "dq", result: "dq", dq_reason: "budget", set_by_booking: false });
    expect((await analysisOf(d.recordingId)).classify).toMatchObject({ dq_reason: { value: "budget" } });
  });

  it("D87: a booking through a setter link up to the Set window (30 minutes after hang-up) is Set whatever Jev read; one 50 minutes after is not; a self-booked one never is", async () => {
    const k = await call(FOLLOW, { endedAgo: 45 }), late = await call(FOLLOW, { endedAgo: 70 }), self = await call(FOLLOW, { endedAgo: 45 });
    await book(k, k.endedAt.plus({ minutes: 12 }));
    await book(late, late.endedAt.plus({ minutes: 50 }));
    await book(self, self.startedAt.plus({ minutes: 1 }), { self: true });
    const nRec = recordWrites.length;
    await run();
    for (const w of [k, late, self]) expect(await runOf(w.contactId)).toMatchObject({ status: "completed" });
    expect(recordWrites.slice(nRec).map((w) => [w.external_id, w.call_result]).sort()).toEqual([[k.external, "set"], [late.external, "follow_up"], [self.external, "follow_up"]].sort());
    expect(await digestOf((await runOf(k.contactId))!.id)).toContain("*Outcome:* Set — booked through a setter link after the call (Jev read: follow up, 88% sure)");
    expect((await eventsOf(k.contactId, "setter_call.result"))[0]).toMatchObject({ predicted: "follow_up", result: "set", decided_by: "booking", set_by_booking: true, jev_agreed: false });
    for (const w of [late, self]) expect((await eventsOf(w.contactId, "setter_call.result"))[0]).toMatchObject({ result: "follow_up", decided_by: "jev", set_by_booking: false });
  });

  it("D87: Jev reads Set but no booking came through a setter link: not Set; the setters are asked", async () => {
    const k = await call(SET);
    await run();
    const r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "waiting", current_node: "w_hold" });
    expect(await digestOf(r.id)).toContain("*Outcome:* Jev read Set (92% sure), but no booking came through a setter link; the team is asked");
    expect(posts.find((p) => p.text.includes("what did it achieve?") && p.text.includes(`|Lead No`) && p.text.includes("but no booking came through a setter link"))).toBeTruthy();
    expect((await eventsOf(k.contactId, "setter_call.result"))[0]).toMatchObject({ predicted: "set", result: "", decided_by: "" });
  });

  it("unsure (Jev under 70%, or doubtful): nothing written; the setters are asked with Jev's guesses and four taps; the first tap writes the result, is scored as the team's answer and replies in the thread", async () => {
    const nRec = recordWrites.length;
    const k = await call(UNSURE);
    await run();
    const r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "waiting", current_node: "w_hold" });
    expect(recordWrites.slice(nRec)).toEqual([expect.objectContaining({ op: "create", external_id: k.external })]);
    expect(recordWrites.slice(nRec)[0]).not.toHaveProperty("call_result");
    expect(await digestOf(r.id)).toContain("*Outcome:* Jev isn't sure (its guesses: follow up 55%, not interested 30%, set 15%); the team is asked");
    const q = (await tsOf(`setter-result:${k.external}`))!;
    expect(q.channel).toBe("CSET");
    const question = posts.find((p) => p.text.includes("what did it achieve?") && p.text.includes(`|Lead No${n - 1}>`))!;
    expect(question.text).toContain("Allan Setter's call with");
    expect(question.text).toContain("its guesses: follow up 55%, not interested 30%, set 15%");
    expect(question.text).toContain("Tap ✅ Set · 🔁 Follow up · ❌ DQ · 🚫 Not interested");
    expect(reacted.filter((x) => x.startsWith(`${q.ts}:`))).toEqual(["white_check_mark", "repeat", "x", "no_entry_sign"].map((e) => `${q.ts}:${e}`));
    expect(await eventsOf(k.contactId, "setter_call.result")).toEqual([expect.objectContaining({ predicted: "unclear", result: "", decided_by: "", top_guesses: "follow up 55%, not interested 30%, set 15%" })]);
    // a stray emoji changes nothing; ❌ decides
    await tap(q.ts, "eyes"); await run();
    expect(await runOf(k.contactId)).toMatchObject({ status: "waiting", current_node: "w_hold" });
    await tap(q.ts, "x"); await run();
    expect(await runOf(k.contactId)).toMatchObject({ status: "completed", exit_reason: "posted" });
    expect(recordWrites.slice(nRec).at(-1)).toEqual({ op: "update", object: "custom_objects.discovery_call", id: expect.stringMatching(/^rec-/), call_result: "dq" });
    expect(await eventsOf(k.contactId, "intent.reviewed")).toEqual([{ domain: "setter_call_result", predicted: "unclear", predicted_confidence: "55", decided: "dq", agreed: false, decided_by: "Tyler Ray", recording_id: k.recordingId }]);
    expect(posts.filter((p) => p.threadTs === q.ts).map((p) => p.text)).toEqual(["DQ, per Tyler Ray.\n*Would have (actions are off):* tag dq and mark the setter card lost."]);
    expect(unreacted.filter((x) => x.startsWith(`${q.ts}:`))).toHaveLength(4);
    // a second tap after the decision does nothing more
    const nPosts = posts.length; await tap(q.ts, "white_check_mark"); await run();
    expect(posts.length).toBe(nPosts);
  });

  it("unanswered for two days: the question closes, recorded as unanswered; nothing is written", async () => {
    const nRec = recordWrites.length;
    const k = await call(UNSURE);
    await run();
    const r = (await runOf(k.contactId))!;
    const q = (await tsOf(`setter-result:${k.external}`))!;
    await wakeAt(r.id);
    await run(fake, companyId, DateTime.now().plus({ hours: 47 }));
    expect(await runOf(k.contactId)).toMatchObject({ status: "waiting", current_node: "w_hold" });   // not yet
    await wakeAt(r.id);
    await run(fake, companyId, DateTime.now().plus({ days: 2, minutes: 5 }));
    expect(await runOf(k.contactId)).toMatchObject({ status: "completed", exit_reason: "posted" });
    expect(await eventsOf(k.contactId, "intent.unanswered")).toEqual([{ domain: "setter_call_result", predicted: "unclear", predicted_confidence: "55", top_guesses: "follow up 55%, not interested 30%, set 15%", recording_id: k.recordingId }]);
    expect(await eventsOf(k.contactId, "intent.reviewed")).toEqual([]);
    expect(posts.filter((p) => p.threadTs === q.ts).map((p) => p.text)).toEqual([`Nobody answered in two days, so no result was written for Lead No${n - 1}.`]);
    expect(recordWrites.slice(nRec).filter((w) => "call_result" in w)).toEqual([]);
  });

  it("actions ON (setter_result.act): follow up → a task for the setter due the next business day with the suggested next step; DQ → the dq tag Jev's reason maps to and the setter card lost at the DQ stage; not interested → the setter card lost; set → nothing", async () => {
    await setBinding(companyId, "setter_result.act", "true");
    try {
      const nTasks = tasks.length, nTags = tags.length, nOpp = oppWrites.length;
      const f = await call(FOLLOW), d = await call(DQ), x = await call(NI), s = await call(SET);
      await book(s, s.startedAt.plus({ minutes: 2 }));
      for (const k of [f, d, x, s]) liveCards.set(k.ghl, setterCard(k.ghl));
      await run();
      for (const k of [f, d, x, s]) expect(await runOf(k.contactId)).toMatchObject({ status: "completed", exit_reason: "posted" });
      const wd = DateTime.now().setZone(TZ).weekday, days = wd === 5 ? 3 : wd === 6 ? 2 : 1;
      expect(tasks.slice(nTasks)).toEqual([expect.objectContaining({ contactId: f.ghl, title: `Call back ${(await asOperator((c) => one<{ n: string }>(c, "select first_name||' '||last_name as n from contacts where id=$1", [f.contactId])))!.n}`, assignedUserId: "U1", body: expect.stringContaining("Suggested next step: Call him Tuesday after work") })]);
      const due = DateTime.fromJSDate(tasks.at(-1)!.dueAt as Date);
      expect(Math.abs(due.diff(DateTime.now().plus({ days }), "minutes").minutes)).toBeLessThan(5);
      expect(tags.slice(nTags)).toEqual([{ contact: d.ghl, tag: "dq-budget" }]);
      expect(oppWrites.slice(nOpp).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([expect.objectContaining({ id: `card-${d.ghl}`, stageId: "STAGE-S-DQ", status: "lost" }), expect.objectContaining({ id: `card-${x.ghl}`, stageId: "STAGE-CONTACTED", status: "lost" })]);   // no not-interested stage bound: status only
      const fr = (await runOf(f.contactId))!;
      expect(await digestOf(fr.id)).toContain("*Next:* a task for Allan Setter to call back");
      expect((await eventsOf(s.contactId, "setter_call.result"))[0]).toMatchObject({ result: "set", acts: true });
    } finally { await asOperator((c) => c.query("delete from bindings where company_id=$1 and key='setter_result.act'", [companyId])); }
  });

  it("test mode (D52): a real person's call is read and posted, but nothing reaches the CRM, actions on or not", async () => {
    await setBinding(companyId, "setter_result.act", "true");
    await asOperator((c) => c.query("update companies set mode='test' where id=$1", [companyId]));
    try {
      const nTags = tags.length, nRec = recordWrites.length, nOpp = oppWrites.length;
      const d = await call(DQ); liveCards.set(d.ghl, setterCard(d.ghl));
      await run();
      const r = (await runOf(d.contactId))!;
      expect(r).toMatchObject({ status: "completed" });
      expect([tags.length, recordWrites.length, oppWrites.length]).toEqual([nTags, nRec, nOpp]);
      expect((await step(r.id, "k_tag"))?.result).toMatchObject({ ghost: true, would_tag: ["dq-budget"] });
      expect((await step(r.id, "r1"))?.result).toMatchObject({ ghost: true, properties: expect.objectContaining({ call_result: "dq" }) });
      expect(await eventsOf(d.contactId, "setter_call.result")).toHaveLength(1);
    } finally {
      await asOperator((c) => c.query("update companies set mode='live' where id=$1", [companyId]));
      await asOperator((c) => c.query("delete from bindings where company_id=$1 and key='setter_result.act'", [companyId]));
    }
  });

  it("a company whose Discovery Call object has no call_result field yet: the result is left out of the write and named (not_on_object), and a tapped answer writes nothing; no failure", async () => {
    const co = await fresh("setres-nofield", noField);
    const nRec = recordWrites.length;
    const k = await call(FOLLOW, { co }), u = await call(UNSURE, { co });
    await run(noField, co);
    const r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "posted" });
    expect((await step(r.id, "r1"))?.result).toMatchObject({ record: "created", not_on_object: ["call_result"] });
    expect(recordWrites.slice(nRec).every((w) => !("call_result" in w))).toBe(true);
    const q = (await tsOf(`setter-result:${u.external}`, co))!;
    await tap(q.ts, "repeat", co); await run(noField, co);
    const ru = (await runOf(u.contactId))!;
    expect(ru).toMatchObject({ status: "completed", exit_reason: "posted" });
    expect((await step(ru.id, "r2"))).toMatchObject({ status: "skipped", result: { kind: "noop", not_on_object: ["call_result"] } });
    expect(await eventsOf(u.contactId, "intent.reviewed")).toEqual([expect.objectContaining({ decided: "follow_up", decided_by: "Tyler Ray" })]);
  });
});

describe.skipIf(!HAS_DB)("D87: one setter result, posted when the booking lands; calls by conversation; closing calls through the dialer; transcripts never stored", () => {
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    companyId = await fresh("setres87", fake);
  });

  it("no booking: posted 15 minutes after hang-up with Jev's read; a setter-link booking at minute 25 edits the post and the record to Set the moment it lands; one at minute 40 changes nothing", async () => {
    const k = await call(FOLLOW, { endedAgo: 5 });
    await run();
    let r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "waiting", current_node: "w_post" });
    expect(Math.abs(DateTime.fromJSDate(r.next_run_at!).diff(k.endedAt.plus({ minutes: 15 }), "minutes").minutes)).toBeLessThan(0.1);   // the deadline: 15 minutes after hang-up, not a fixed wait from the transcript
    expect(await postOf(k.external)).toBeFalsy();
    // 15 minutes after hang-up: the post goes out with Jev's read, and the Set window stays open until 30
    const nRec = recordWrites.length;
    await wakeAt(r.id); await run(fake, companyId, k.endedAt.plus({ minutes: 15, seconds: 30 }));
    r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "waiting", current_node: "w_late" });
    expect(await digestOf(r.id)).toContain("*Outcome:* Follow up (Jev is 88% sure)");
    expect(recordWrites.slice(nRec)).toEqual([expect.objectContaining({ op: "create", external_id: k.external, call_result: "follow_up" })]);
    const post = (await postOf(k.external))!;
    // minute 25: a booking through the setter link → the same post and the same record become Set, at once
    await book(k, k.endedAt.plus({ minutes: 25 }));
    expect((await runOf(k.contactId))!.next_run_at!.getTime()).toBeLessThanOrEqual(Date.now());   // the booking woke it; nothing polls
    await run(fake, companyId, k.endedAt.plus({ minutes: 25, seconds: 30 }));
    r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "posted" });
    const edit = edits.filter((e) => e.ts === post.ts).at(-1)!;
    expect(edit.text).toContain("*Outcome:* Set — booked through a setter link after the call (Jev read: follow up, 88% sure)");
    expect(edit.text).not.toContain("Would have");
    expect(recordWrites.at(-1)).toEqual({ op: "update", object: "custom_objects.discovery_call", id: expect.stringMatching(/^rec-/), call_result: "set" });
    expect((await eventsOf(k.contactId, "setter_call.result")).map((e) => [e.result, e.decided_by])).toEqual([["follow_up", "jev"], ["set", "booking"]]);
    const name = (await asOperator((c) => one<{ n: string }>(c, "select first_name||' '||last_name as n from contacts where id=$1", [k.contactId])))!.n;
    expect(posts.filter((p) => p.text.includes(`|${name}>`))).toHaveLength(1);   // one post, edited

    // another call: no booking by minute 30, the run ends; a booking at minute 40 changes nothing
    const k2 = await call(FOLLOW, { endedAgo: 5 });
    await run();
    const r2 = (await runOf(k2.contactId))!;
    await wakeAt(r2.id); await run(fake, companyId, k2.endedAt.plus({ minutes: 15, seconds: 30 }));
    await wakeAt(r2.id); await run(fake, companyId, k2.endedAt.plus({ minutes: 30, seconds: 30 }));
    expect(await runOf(k2.contactId)).toMatchObject({ status: "completed", exit_reason: "posted" });
    const nEdits = edits.length, nRec2 = recordWrites.length;
    await book(k2, k2.endedAt.plus({ minutes: 40 }));
    await run(fake, companyId, k2.endedAt.plus({ minutes: 40 }));
    expect([edits.length, recordWrites.length]).toEqual([nEdits, nRec2]);
    expect((await eventsOf(k2.contactId, "setter_call.result")).map((e) => e.result)).toEqual(["follow_up"]);
  });

  it("a setter-link booking at minute 10 posts at once as Set; a confirmation call posts as soon as it is read", async () => {
    const k = await call(FOLLOW, { endedAgo: 5 });
    await run();
    expect(await runOf(k.contactId)).toMatchObject({ status: "waiting", current_node: "w_post" });
    await book(k, k.endedAt.plus({ minutes: 10 }));
    await run();
    const r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "posted" });
    expect(await digestOf(r.id)).toContain("*Outcome:* Set — booked through a setter link after the call (Jev read: follow up, 88% sure)");
  });

  it("two real parts within 15 minutes are one conversation: the first posts as usual; when the second's transcript lands Jev reads both (each fetched from GHL again) and the same post and record are updated, marked as parts", async () => {
    const who = await newLead(companyId);
    const p1 = await call(FOLLOW, { who, endedAgo: 40, sec: 180 });
    await run();
    const r1 = (await runOf(who.contactId))!;
    expect(r1).toMatchObject({ status: "completed", exit_reason: "posted" });
    const post = (await postOf(p1.external))!;
    expect(await digestOf(r1.id)).toContain("*Length:* 3 min · outbound");
    // the line dropped; Allan called back 5 minutes later
    const nRec = recordWrites.length, nReads = mediaReads.length;
    const p2 = await call(NI, { who, endedAgo: 30, sec: 300 });
    await run();
    const r2 = (await runOf(who.contactId))!;
    expect(r2.id).not.toBe(r1.id);
    expect(r2).toMatchObject({ status: "completed", exit_reason: "posted" });
    const read = inputs.filter((i) => i.includes(FOLLOW) && i.includes(NI)).at(-1)!;
    expect(read).toMatch(/^Part 1 of 2 \(.*, 3 min\):\n/); expect(read).toContain("\n\nPart 2 of 2 ("); expect(read.indexOf(FOLLOW)).toBeLessThan(read.indexOf(NI));
    expect(mediaReads.slice(nReads)).toEqual(expect.arrayContaining([p1.external, p2.external]));
    const edit = edits.filter((e) => e.ts === post.ts).at(-1)!;
    expect(edit.text).toContain("*Length:* 8 min (2 parts)"); expect(edit.text).toContain("*Outcome:* Not interested (Jev is 93% sure)");
    expect(posts.filter((p) => p.ts === post.ts)).toHaveLength(1);
    expect(recordWrites.slice(nRec)).toEqual([expect.objectContaining({ op: "update", external_id: p1.external, duration_sec: 480, call_result: "not_interested", display_label: expect.stringMatching(/\(2 parts\)$/) })]);   // the first part's record, never a second one
    expect((await eventsOf(who.contactId, "setter_call.result")).map((e) => [e.recording_id, e.result, e.parts])).toEqual([[p1.recordingId, "follow_up", 1], [p1.recordingId, "not_interested", 2]]);
  });

  it("a part still waiting for its booking leaves the whole to a later part that came in meanwhile: one post for the conversation", async () => {
    const who = await newLead(companyId);
    const p1 = await call(FOLLOW, { who, endedAgo: 6, sec: 120 });
    await run();
    expect(await runOf(who.contactId)).toMatchObject({ status: "waiting", current_node: "w_post" });
    await call(NI, { who, endedAgo: 1, sec: 120 });
    await run();
    await book(who, DateTime.now());
    await run();
    const runs = await runsOf(who.contactId, "Setter call logged");
    expect(runs.map((r) => [r.status, r.exit_reason])).toEqual([["completed", "read_with_a_later_part"], ["completed", "posted"]]);
    const post = (await postOf(p1.external))!;
    expect(posts.filter((p) => p.ts === post.ts)[0].text).toContain("(2 parts)");
    expect(posts.filter((p) => p.ts === post.ts)[0].text).toContain("*Outcome:* Set — booked through a setter link after the call");
  });

  it("a part already posted and waiting out its Set window yields to a later part: the booking that lands makes the whole conversation Set, in the same post", async () => {
    const who = await newLead(companyId);
    const p1 = await call(FOLLOW, { who, endedAgo: 20, sec: 120 });
    await run();
    expect(await runOf(who.contactId)).toMatchObject({ status: "waiting", current_node: "w_late" });
    const post = (await postOf(p1.external))!;
    await call(NI, { who, endedAgo: 7, sec: 300 });   // the call back, 8 minutes after the first ended
    await run();
    await book(who, DateTime.now());
    await run();
    const runs = await runsOf(who.contactId, "Setter call logged");
    expect(runs.map((r) => [r.status, r.exit_reason])).toEqual([["completed", "read_with_a_later_part"], ["completed", "posted"]]);
    const last = edits.filter((e) => e.ts === post.ts).at(-1)!.text;
    expect(last).toContain("(2 parts)"); expect(last).toContain("*Outcome:* Set — booked through a setter link after the call (Jev read: not interested, 93% sure)");
    expect(posts.filter((p) => p.text.includes("what did it achieve?") && p.text.includes(`|Lead No${n - 2}>`))).toEqual([]);
  });

  it("Lynton's call: a 0-second connect, then a 64-minute call by the closer that Jev reads as closing → never a setter post; Sales call recorded takes it, linked to his booking with that closer, marked showed", async () => {
    const who = await newLead(companyId);
    const appt = await book(who, DateTime.now().minus({ days: 2 }), { closer: "U3", startsIn: -66 });
    const zero = await call(null, { who, endedAgo: 65, sec: 0, caller: "U3" });
    const k = await call(CLOSING, { who, endedAgo: 1, sec: 64 * 60, caller: "U3" });
    expect(await asOperator((c) => one(c, "select 1 from runs where context->'event'->>'recording_id'=$1", [zero.recordingId]))).toBeFalsy();   // the 0-second connect is no call
    const nPosts = posts.length, nRec = recordWrites.length;
    await run();
    const setter = (await runOf(who.contactId))!;
    expect(setter).toMatchObject({ status: "completed", exit_reason: "closing_call" });
    expect(await eventsOf(who.contactId, "call.closing")).toEqual([expect.objectContaining({ recording_id: k.recordingId, linked: appt, parts: 1, closer: "James Closer" })]);
    await run();
    const closer = (await runsOf(who.contactId, "Sales call recorded"))[0];
    expect(closer).toMatchObject({ status: "completed", exit_reason: "recorded", appointment_id: appt });
    expect(await asOperator((c) => one<{ outcome: string }>(c, "select t.category as outcome from appointments a join company_terms t on t.id=a.outcome_term where a.id=$1", [appt]))).toEqual({ outcome: "showed" });
    const review = posts.slice(nPosts).find((p) => p.channel === "CCALLS")!;
    expect(review.text).toContain("*Closer:* James Closer · 64 min"); expect(review.text).toContain("marked showed"); expect(review.text).toContain("Open the call in GHL");
    expect(posts.slice(nPosts).filter((p) => p.channel === "CSET")).toEqual([]);
    expect(recordWrites.slice(nRec)).toEqual(expect.arrayContaining([expect.objectContaining({ object: "custom_objects.sales_call", outcome: "showed", disposition: "closed_won", closer: "James Closer" })]));
    expect(recordWrites.slice(nRec).filter((w) => w.object === "custom_objects.discovery_call")).toEqual([]);
  });

  it("a closing call by phone that lines up with no booking: posted as unlinked and the team is asked which booking it was; a tap links it, marks it showed and edits the review", async () => {
    const who = await newLead(companyId);
    const other = await book(who, DateTime.now().minus({ days: 5 }), { closer: "U2", startsIn: 3 * 1440 });   // with another closer, days away: nothing lines up
    const k = await call(CLOSING, { who, endedAgo: 1, sec: 1800, caller: "U3" });
    const nRec = recordWrites.length;
    await run(); await run();
    let closer = (await runsOf(who.contactId, "Sales call recorded"))[0];
    expect(closer).toMatchObject({ status: "waiting", appointment_id: null });
    const review = (await tsOf(`recording:${k.recordingId}`))!;
    expect(posts.find((p) => p.ts === review.ts)!.text).toContain("A closing call by phone that lines up with none of their bookings");
    expect(recordWrites.slice(nRec).filter((w) => w.object === "custom_objects.sales_call")).toEqual([]);   // no record until it is linked
    const q = (await tsOf(`closing-which:${k.recordingId}`))!;
    expect(q.channel).toBe("CCALLS");
    const question = posts.find((p) => p.ts === q.ts)!.text;
    expect(question).toContain("James Closer had a 30-minute closing call by phone with"); expect(question).toMatch(/\n1\. .* with Tyler Ray \(confirmed\)\n/);
    expect(reacted.filter((x) => x.startsWith(`${q.ts}:`))).toEqual(["one", "two", "three", "x"].map((e) => `${q.ts}:${e}`));
    await tap(q.ts, "one", companyId, "CCALLS");
    await run();
    const runs = await runsOf(who.contactId, "Sales call recorded");
    expect(runs.map((r) => [r.status, r.exit_reason, r.appointment_id])).toEqual([["completed", "linked_by_the_team", null], ["active", null, other]]);
    expect(posts.filter((p) => p.threadTs === q.ts).map((p) => p.text)).toEqual(["Linked to the booking, per Tyler Ray; it is marked showed and the review is updated."]);
    await run();
    closer = (await runsOf(who.contactId, "Sales call recorded"))[1];
    expect(closer).toMatchObject({ status: "completed", exit_reason: "recorded" });
    expect(await asOperator((c) => one<{ outcome: string }>(c, "select t.category as outcome from appointments a join company_terms t on t.id=a.outcome_term where a.id=$1", [other]))).toEqual({ outcome: "showed" });
    expect(edits.filter((e) => e.ts === review.ts).at(-1)!.text).toContain("marked showed");
    expect(recordWrites.slice(nRec).filter((w) => w.object === "custom_objects.sales_call")).toEqual([expect.objectContaining({ outcome: "showed" })]);
  });

  it("transcripts are never stored: read from GHL when a step needs it; none in the recording, the events, the run or its steps; a read Jev could not do reads it again on the retry", async () => {
    failNextTypeRead = 1;
    const nReads = mediaReads.length;
    const k = await call(FOLLOW);
    await run();
    let r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "waiting", current_node: "a1" });   // Jev down: the step is retried in place
    await wakeAt(r.id); await run(fake, companyId, DateTime.now().plus({ minutes: 2 }));
    r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "posted" });
    expect((await stepsOf(r.id)).filter((s) => s.node_id === "a1").map((s) => s.status)).toEqual(["failed", "ok"]);
    expect(mediaReads.slice(nReads).filter((x) => x === k.external).length).toBeGreaterThanOrEqual(4);   // each read: both tries of the type, the notes, the result
    const left = await asOperator(async (c) => ({
      rec: (await one<{ transcript: unknown; summary: unknown }>(c, "select transcript, summary from recordings where id=$1", [k.recordingId]))!,
      events: Number((await one<{ n: string }>(c, "select count(*)::text as n from events where company_id=$1 and data::text like $2", [companyId, `%${FOLLOW}%`]))!.n),
      runs: Number((await one<{ n: string }>(c, "select count(*)::text as n from runs where company_id=$1 and context::text like $2", [companyId, `%${FOLLOW}%`]))!.n),
      steps: Number((await one<{ n: string }>(c, "select count(*)::text as n from run_steps s join runs r on r.id=s.run_id where r.company_id=$1 and (s.result::text like $2 or coalesce(s.error,'') like $2)", [companyId, `%${FOLLOW}%`]))!.n),
    }));
    expect(left).toEqual({ rec: { transcript: null, summary: null }, events: 0, runs: 0, steps: 0 });
    expect((await analysisOf(k.recordingId)).classify).toMatchObject({ call_type: { value: "setting" }, result: { value: "follow_up" } });   // Jev's answers stay
  });

  it("a transcript that lands 90 minutes after hang-up is still read and posted (the Set window long closed: Jev's read)", async () => {
    const k = await call(FOLLOW, { endedAgo: 90 });
    await run();
    const r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "posted" });
    expect(await digestOf(r.id)).toContain("*Outcome:* Follow up (Jev is 88% sure)");
  });

  it("a Fathom transcript arrives once, in the webhook: held only until the closer workflow has read it (kept while the read fails), then cleared; once cleared a step reads it from Fathom again; the safety sweep clears anything held 48 hours after its run ended", async () => {
    const who = await newLead(companyId);
    const input = { provider: "fathom", externalId: `fx-${who.ghl}`, startedAt: new Date(Date.now() - 200 * 864e5), endedAt: new Date(Date.now() - 200 * 864e5 + 1800e3),   // D227: clear of the other leads' bookings with James durationMin: 30, recordedBy: { name: "James Closer", email: "james@x.com" },
      invitees: [{ name: "Lead", email: `${who.ghl.toLowerCase()}@x.com`, isExternal: true }], transcript: [{ speaker: "James Closer", text: CLOSING }, { speaker: `${who.ghl.toLowerCase()}@x.com`, text: "Let's do it." }], summary: "A summary nobody reads" };
    const rec = await asOperator(async (c) => { const r = await recordRecording(c, companyId, input); if (r.outcome !== "linked") throw new Error(`${r.outcome}: ${"reason" in r ? r.reason : ""}`); await dispatchEvent(c, r.event, { contact: { id: r.contactId } }); return r.recording; });
    const held = () => asOperator(async (c) => (await one<{ transcript: unknown[] | null; summary: string | null; raw: Record<string, unknown> }>(c, "select transcript, summary, raw from recordings where id=$1", [rec.id]))!);
    expect(await held()).toMatchObject({ transcript: expect.arrayContaining([expect.objectContaining({ text: CLOSING })]), summary: null, raw: { transcript_status: "ready" } });   // the summary is never kept
    failNextKindRead = 1;
    await run();
    let r = (await runOf(who.contactId, "call-recorded"))!;
    expect(r).toMatchObject({ status: "waiting", current_node: "a1" });
    expect((await held()).transcript).toHaveLength(2);   // the read failed: kept for the retry
    await wakeAt(r.id); await run(fake, companyId, DateTime.now().plus({ minutes: 2 }));
    r = (await runOf(who.contactId, "call-recorded"))!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "recorded" });
    expect(await held()).toMatchObject({ transcript: null, summary: null, raw: { transcript_status: "ready" } });
    // a later read (the recording linked again by hand, a rerun) asks Fathom for it
    await asOperator((c) => c.query("insert into bindings (company_id, key, kind, value) values ($1,'secret.fathom_api_key','secret',$2) on conflict (company_id, key) do update set value=excluded.value", [companyId, encrypt("fathom-key")]));
    const nFathom = fathomReads.length;
    await asOperator(async (c) => { const ev = await (await import("@/engine/dispatch")).emitEvent(c, { company_id: companyId, contact_id: who.contactId, opportunity_id: null, appointment_id: null, event_type: "recording.received", source: "fathom", data: { recording_id: rec.id } }); await dispatchEvent(c, ev, { contact: { id: who.contactId } }); });
    await run();
    expect(fathomReads.slice(nFathom)).toContain(input.externalId);
    expect(inputs.at(-1)).toContain("From Fathom again");
    expect((await held()).transcript).toBeNull();
    // the sweep: a transcript held with no run for three days goes; one that just arrived stays
    const [old, fresh2] = await asOperator(async (c) => Promise.all(["3 days", "1 minute"].map(async (ago, i) => (await one<{ id: string }>(c, `insert into recordings (company_id, provider, external_id, started_at, received_at, transcript, summary, link_status, raw)
      values ($1,'fathom',$2,now()-interval '${ago}',now()-interval '${ago}',$3,'s','unlinked','{}') returning id`, [companyId, `sweep-${who.ghl}-${i}`, JSON.stringify([{ speaker: "A", text: "held" }])]))!.id)));
    await asOperator((c) => sweepHeldTranscripts(c));
    const after = await asOperator((c) => many<{ id: string; transcript: unknown; summary: unknown; raw: Record<string, unknown> }>(c, "select id, transcript, summary, raw from recordings where id = any($1)", [[old, fresh2]]));
    expect(after.find((x) => x.id === old)).toMatchObject({ transcript: null, summary: null, raw: { transcript_status: "ready" } });
    expect(after.find((x) => x.id === fresh2)!.transcript).not.toBeNull();
  });

  it("metrics count a call as set the one way the workflow does: a setter-link booking during the call or within the Set window, credited to the setter who dialed", async () => {
    const co = await fresh("setres-metrics", fake);
    const a = await call(FOLLOW, { co, endedAgo: 45 }), b = await call(FOLLOW, { co, endedAgo: 45 }), c3 = await call(FOLLOW, { co, endedAgo: 45 });
    await book(a, a.startedAt.plus({ minutes: 1 }), { co });                    // during the call, setter link: Set
    await book(b, b.startedAt.plus({ minutes: 1 }), { co, self: true });       // during the call, their own link: never Set
    await book(c3, c3.endedAt.plus({ minutes: 40 }), { co });                  // setter link, after the window: not this call's
    await run(fake, co);
    const set = (await Promise.all([a, b, c3].map(async (k) => (await eventsOf(k.contactId, "setter_call.result"))[0].result))).filter((x) => x === "set").length;
    expect(set).toBe(1);
    const day = DateTime.now().setZone(TZ).toISODate()!;
    const totals = await asOperator(async (c) => { await rollupDay(c, co, day, TZ); return readMetrics(c, co, day, day); });
    expect(totals.totals.calls_set).toBe(set);
    expect(totals.setters.find((s) => s.name === "Allan Setter")!.values.calls_set).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("Jev's setter-call accuracy (jev_setter_accuracy)", () => {
  let co: string;
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    co = await fresh("setacc", fakeAdapters(), { enable: false, testDomains: ["test.example"], discoveryCall: { results: { booked: "set", callback: "follow_up", disq: "dq", no: "not_interested" } } });
  });

  it("scores each read against what happened (a booking within 7 days or 30 minutes, a dq tag, the setter card lost, a tap, a change on the record in GHL, no booking in 7 days for a set read) and splits it by Jev's read; unsure reads and test contacts stay out of the rate", async () => {
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 864e5);
    let i = 0;
    const read = (predicted: string, daysAgo: number, extra: Record<string, unknown> = {}, email = "") => asOperator(async (c) => {
      const ghl = `ACC${++i}`;
      const contact = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, timezone) values ($1,$2,$2,$3) returning id", [co, ghl, TZ]))!.id;
      if (email) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [co, contact, email]);
      const ended = at(daysAgo);
      const rec = (await one<{ id: string }>(c, "insert into recordings (company_id, contact_id, provider, external_id, started_at, ended_at, link_status, raw) values ($1,$2,'ghl',$3,$4,$5,'linked','{}') returning id", [co, contact, `x-${ghl}`, new Date(ended.getTime() - 180e3), ended]))!.id;
      await c.query("insert into events (company_id, contact_id, event_type, occurred_at, source, data) values ($1,$2,'setter_call.result',$3,'engine',$4)", [co, contact, new Date(ended.getTime() + 35 * 60e3),
        { recording_id: rec, external_id: `x-${ghl}`, setter: "Allan Setter", predicted, predicted_confidence: "90", result: predicted === "unclear" ? "" : predicted, decided_by: predicted === "unclear" ? "" : "jev", booked_within_30m: false, ...extra }]);
      return { contact, rec, ended, ghl };
    });
    const ev = (contact: string, type: string, occurred: Date, data: Record<string, unknown>, source = "ghl_poll") => asOperator((c) => c.query("insert into events (company_id, contact_id, event_type, occurred_at, source, data) values ($1,$2,$3,$4,$5,$6)", [co, contact, type, occurred, source, data]));
    const cal = await asOperator(async (c) => (await one<{ id: string; term: string }>(c, "select id, appointment_term as term from calendars where company_id=$1 limit 1", [co]))!);
    const booking = (contact: string, bookedAt: Date) => asOperator((c) => c.query("insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, starts_at, ends_at, booked_at, status) values ($1,$2,'ghl',$3,$4,$5,$6,$7,$8,'confirmed')", [co, contact, `appt-${bookedAt.getTime()}-${contact}`, cal.id, cal.term, new Date(bookedAt.getTime() + 3 * 864e5), new Date(bookedAt.getTime() + 3 * 864e5 + 45 * 60e3), bookedAt]));

    await read("set", 3, { booked_within_30m: true, decided_by: "booking" });                       // a: set, booked within 30 min → agreed
    const b = await read("follow_up", 4); await booking(b.contact, new Date(b.ended.getTime() + 2 * 864e5));   // b: booked 2 days later → set → missed
    const cc = await read("dq", 5); await ev(cc.contact, "tag.added", new Date(cc.ended.getTime() + 3600e3), { tag: "dq-budget" });   // c: → agreed
    await ev(cc.contact, "tag.added", new Date(cc.ended.getTime() - 3600e3), { tag: "dq" });          // (a tag from before the call proves nothing; it is the later one that counts here)
    const d = await read("not_interested", 2); await ev(d.contact, "card.moved", new Date(d.ended.getTime() + 7200e3), { by: "crm", pipeline_id: "PIPE-SETTER", to_status: "lost" });   // d: → agreed
    await read("set", 9);                                                                            // e: no booking in 7 days → missed
    await read("follow_up", 1);                                                                      // f: nothing yet → pending
    const g = await read("unclear", 2); await ev(g.contact, "intent.reviewed", new Date(g.ended.getTime() + 3600e3), { domain: "setter_call_result", decided: "follow_up", recording_id: g.rec }, "engine");   // g: unsure, answered
    const h = await read("follow_up", 3);                                                            // h: changed to DQ on the record in GHL → missed
    await asOperator((c) => c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, properties) values ($1,'custom_objects.discovery_call',$2,'REC-H',$3,$4)", [co, `x-${h.ghl}`, h.contact, { call_result: "callback" }]));
    await read("set", 2, {}, "qa@test.example");                                                     // i: a test contact → out

    const reads: Partial<GhlReads> = { objectRecords: async (_c, key) => (key === "custom_objects.discovery_call" ? [{ id: "REC-H", createdAt: "", properties: { call_result: "disq" } }] : []) };
    const period = parsePeriod("last 30 days", TZ)!;
    const r = await asOperator((c) => getMetric(c, co, { metric: "jev_setter_accuracy", period }, reads as GhlReads));
    expect(r).toMatchObject({ unit: "rate", numerator: 3, denominator: 6, value: 0.5, rows_by: "Jev's read" });
    expect(r.rows!.map((x) => [x.key, x.numerator, x.denominator])).toEqual([["set", 1, 2], ["follow_up", 0, 2], ["dq", 1, 1], ["not_interested", 1, 1]]);
    expect(r.setter_accuracy).toMatchObject({ reads: 8, confident: 7, scored: 6, agreed: 3, pending: 1, unsure: 1, unsure_answered: 1 });
    const text = formatAnswer([r]);
    expect(text).toContain("*Jev's setter-call accuracy: 50%* (3 of 6 reads with a known outcome)");
    expect(text).toContain("8 setter calls read · 6 with a known outcome · 1 still waiting on one");
    expect(text).toContain("Jev was unsure on 1 and asked the team (1 answered)");
    expect(text).toContain("*By Jev's read*");
    // by setter, and the GHL read failing only drops the change made there (said, not hidden)
    const bySetter = await asOperator((c) => getMetric(c, co, { metric: "jev_setter_accuracy", period, groupBy: "setter" }, { objectRecords: async () => { throw new Error("GHL 503"); } } as unknown as GhlReads));
    expect(bySetter.rows).toEqual([{ key: "Allan Setter", label: "Allan Setter", value: 0.6, numerator: 3, denominator: 5 }]);   // h has no known outcome without GHL
    expect(formatAnswer([bySetter])).toContain("couldn't read the Discovery Call records in GHL (GHL 503)");
  });
});
