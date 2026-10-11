/** D79: Jev reads what a setter call achieved — set, follow up, DQ, not interested — through the real setter-call-logged template. */
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
import { recordPhoneCall, settlePhoneCall, phoneFacts } from "@/engine/recordings";
import { reactionArrived } from "@/engine/webhooks/slack";
import { getMetric, parsePeriod } from "@/engine/metric-registry";
import { formatAnswer } from "@/engine/bot-format";
import { discoveryResultMeaning, discoveryResultValues } from "@/engine/setter-result";
import type { GhlReads } from "@/adapters/ghl/metrics";
import type { Adapters, Classification, LiveCard } from "@/adapters/types";

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

const posts: { channel: string; text: string; threadTs?: string }[] = [];
const reacted: string[] = [], unreacted: string[] = [];
const recordWrites: Record<string, unknown>[] = [];
const tasks: Record<string, unknown>[] = [];
const tags: { contact: string; tag: string }[] = [];
const oppWrites: Record<string, unknown>[] = [];
const liveCards = new Map<string, LiveCard[]>();
const asked: string[] = [];
const DC_FIELDS = ["display_label", "external_id", "contact_id", "occurred_at", "direction", "duration_sec", "setter", "outcome", "recording_url", "led_to_booking"];
const adapters = (withResultField: boolean): Adapters => {
  const base = fakeAdapters();
  return {
    ...base,
    read: { ...base.read, listUsers: async () => [{ id: "U1", name: "Allan Setter", email: "allan@x.com" }, { id: "U2", name: "Tyler Ray", email: "tyler@x.com" }],
      openCards: async (_c, id) => liveCards.get(id) ?? [], objectFields: async () => (withResultField ? [...DC_FIELDS, "call_result"] : DC_FIELDS) },
    write: { ...base.write, createRecord: async (_c, _o, props) => { recordWrites.push({ op: "create", ...props }); return { id: `rec-${recordWrites.length}` }; }, updateRecord: async (_c, _o, id, props) => { recordWrites.push({ op: "update", id, ...props }); },
      createTask: async (_c, id, task) => { tasks.push({ contactId: id, ...task }); return { id: `task-${tasks.length}` }; }, addTag: async (_c, id, tag) => { tags.push({ contact: id, tag }); },
      updateOpportunity: async (_c, id, patch) => { oppWrites.push({ op: "update", id, ...patch }); } },
    classifier: { choice: async (_s, input, options, _t, opts): Promise<Classification> => {
      asked.push(options.join(","));
      if (options.includes("setting")) return { value: "setting", confidence: 0.95, distribution: { setting: 0.95 }, unclear: false };
      const f = FIXTURES.find((x) => input.includes(x.phrase));
      if (options.includes("budget")) return { value: f?.reason ?? "other", confidence: 0.8, distribution: { [f?.reason ?? "other"]: 0.8 }, unclear: false };
      expect(opts?.question).toMatch(/achieve/); expect(opts?.criteria && Object.keys(opts.criteria).sort()).toEqual(["dq", "follow_up", "not_interested", "set"]);
      return f!.read;
    } },
    notifier: { ...base.notifier, post: async (_t, channel, text, _as, threadTs) => { posts.push({ channel, text, threadTs }); return { ts: `ts${posts.length}` }; },
      react: async (_t, _ch, ts, emoji) => { reacted.push(`${ts}:${emoji}`); return true; }, unreact: async (_t, _ch, ts, emoji) => { unreacted.push(`${ts}:${emoji}`); return true; } },
    analyst: { analyze: async () => { const parsed = { summary: "Talked about thinning.", digest: "Talked about thinning for a year.\nFit: 7/10", next_step: "Call him Tuesday after work", fit_quality: 7 }; return { text: JSON.stringify(parsed), parsed, model: "fake", usage: { input: 1, output: 1, cacheRead: 0 } }; } },
  };
};
const fake = adapters(true), noField = adapters(false);

const TABLES = ["alerts", "slack_posts", "sends", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "recordings", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
async function fresh(slug: string, a: Adapters, extra: Partial<InstallInput> = {}): Promise<string> {
  await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
    await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
    await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
    for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
    await c.query("delete from companies where id=$1", [co.id]);
  });
  const r = await installCompany({ name: slug, slug, timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, templates: ["setter-call-logged"], enable: true, anthropicKey: "sk-fake",
    crm: { pipeline_setter: "PIPE-SETTER", stage_setter_dq: "STAGE-S-DQ", assoc_discovery_call_contact: "ASSOC-DC" }, slack: { setter_calls: "CSET" }, ...extra }, a);
  await asOperator(async (c) => {
    await c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59' where id=$1", [r.companyId]);
    await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, channels) values ($1,'T1',$2,'UBOT','{}')", [r.companyId, encrypt("xoxb-fake")]);
    await c.query("update users set slack_user_id='UTYLER' where company_id=$1 and ghl_user_id='U2'", [r.companyId]);
  });
  return r.companyId;
}

let companyId: string;
let n = 0;
/** A connected 3-minute dial by Allan, ended `endedAgo` minutes ago, with this transcript; a fresh contact each time. */
async function call(phrase: string, opts: { endedAgo?: number; co?: string; a?: Adapters } = {}) {
  const co = opts.co ?? companyId, ghl = `SR${++n}`;
  const contactId = await asOperator(async (c) => {
    const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,$2,'Lead',$3,$4) returning id", [co, ghl, `No${n}`, TZ]))!.id;
    await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [co, id, `${ghl.toLowerCase()}@x.com`]);
    return id;
  });
  const started = new Date(Date.now() - ((opts.endedAgo ?? 45) + 3) * 60e3);
  const rec = await asOperator(async (c) => {
    const { recording } = await recordPhoneCall(c, co, { externalId: `dial-${ghl}`, contactId, startedAt: started, durationSec: 180, direction: "outbound", status: "completed", callerGhlUserId: "U1" });
    const { recording: row, event } = await settlePhoneCall(c, recording, { recordingUrl: `https://ghl.test/${ghl}`, transcript: transcript(phrase) });
    await dispatchEvent(c, event!, { contact: { id: contactId }, recording: { id: row.id, ...phoneFacts(row) } });
    return row;
  });
  return { contactId, ghl, recordingId: rec.id, endedAt: DateTime.fromJSDate(rec.ended_at!), external: `dial-${ghl}` };
}
const runOf = (contactId: string) => asOperator((c) => one<{ id: string; status: string; current_node: string | null; exit_reason: string | null }>(c, "select id, status, current_node, exit_reason from runs where contact_id=$1 order by started_at desc limit 1", [contactId]));
const stepsOf = (runId: string) => asOperator((c) => many<{ node_id: string; status: string; result: Record<string, unknown> }>(c, "select node_id, status, result from run_steps where run_id=$1 order by started_at, id", [runId]));
const step = async (runId: string, node: string) => (await stepsOf(runId)).filter((s) => s.node_id === node).at(-1);
const eventsOf = (contactId: string, type: string) => asOperator((c) => many<{ data: Record<string, unknown> }>(c, "select data from events where contact_id=$1 and event_type=$2 order by id", [contactId, type])).then((r) => r.map((x) => x.data));
const analysisOf = (recordingId: string) => asOperator(async (c) => (await one<{ analysis: Record<string, unknown> }>(c, "select analysis from recordings where id=$1", [recordingId]))!.analysis);
const run = (a: Adapters = fake, co = companyId, now = DateTime.now()) => tick(a, now as DateTime<true>, co, fakeProbes);
const setBinding = (co: string, key: string, value: string) => asOperator((c) => c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'text',$3) on conflict (company_id, key) do update set value=excluded.value", [co, key, Buffer.from(value)]));
const tsOf = (tag: string, co = companyId) => asOperator(async (c) => (await one<{ ts: string; channel: string }>(c, "select ts, channel from slack_posts where company_id=$1 and tag=$2", [co, tag])));
const tap = (ts: string, reaction: string, co = companyId) => asOperator((c) => reactionArrived(c, co, { kind: "reaction", eventId: `Ev${ts}${reaction}`, user: "UTYLER", reaction, channel: "CSET", ts, removed: false }));
const setterCard = (ghl: string): LiveCard[] => [{ id: `card-${ghl}`, pipelineId: "PIPE-SETTER", stageId: "STAGE-CONTACTED", status: "open", name: `Lead -- Contacted`, updatedAt: new Date(Date.now() - 864e5).toISOString() }];
/** The Slack post a run made last (the digest), by run. */
const digestOf = async (runId: string) => (await asOperator((c) => one<{ rendered_body: string }>(c, "select rendered_body from sends where run_id=$1 and channel='slack' and idempotency_key like '%:s1'", [runId])))!.rendered_body;

describe("the Discovery Call's option keys (discovery_call.results)", () => {
  it("defaults to the four meanings; a company map is inverted to its own keys and read back to meanings", () => {
    expect(discoveryResultValues({})).toEqual({ set: "set", follow_up: "follow_up", dq: "dq", not_interested: "not_interested" });
    const b = { "discovery_call.results": JSON.stringify({ booked: "set", callback: "follow_up", disq: "dq" }) };
    expect(discoveryResultValues(b)).toEqual({ set: "booked", follow_up: "callback", dq: "disq", not_interested: "" });
    expect([discoveryResultMeaning("Callback", b), discoveryResultMeaning(["disq"], b), discoveryResultMeaning("set", b), discoveryResultMeaning("", b)]).toEqual(["follow_up", "dq", null, null]);
  });
});

describe.skipIf(!HAS_DB)("setter call result (D79)", () => {
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    companyId = await fresh("setres", fake);
  });

  it("set: Jev reads set → call_result on the Discovery Call record, the post says so with Jev's confidence, the read is on the recording and logged; nothing asked, nothing done", async () => {
    const nRec = recordWrites.length, nTasks = tasks.length;
    const k = await call(SET);
    await run();
    const r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "posted" });
    expect(recordWrites.slice(nRec)).toEqual([expect.objectContaining({ op: "create", external_id: k.external, call_result: "set" })]);
    expect(await digestOf(r.id)).toContain("*Outcome:* Set (Jev is 92% sure)");
    expect(await digestOf(r.id)).not.toMatch(/Would have/);
    const analysis = await analysisOf(k.recordingId);
    expect(analysis.classify).toMatchObject({ call_type: { value: "setting" }, result: { value: "set", confidence: 0.92 } });   // the second read does not wipe the first
    expect(await eventsOf(k.contactId, "setter_call.result")).toEqual([expect.objectContaining({ recording_id: k.recordingId, predicted: "set", predicted_confidence: "92", result: "set", decided_by: "jev", booked_within_30m: false, jev_agreed: true, setter: "Allan Setter", acts: false })]);
    expect(await tsOf(`setter-result:${k.recordingId}`)).toBeFalsy();
    expect(tasks.length).toBe(nTasks);
    expect((await step(r.id, "a4"))?.status).toBe("skipped");   // the DQ reason is read only when it could be a DQ
  });

  it("follow up / DQ / not interested with the actions OFF (the default): the result is written and the post says what would have happened; no task, tag or card move", async () => {
    const nTasks = tasks.length, nTags = tags.length, nOpp = oppWrites.length, nRec = recordWrites.length;
    const f = await call(FOLLOW), d = await call(DQ), x = await call(NI);
    for (const k of [f, d, x]) liveCards.set(k.ghl, setterCard(k.ghl));
    await run();
    const [rf, rd, rx] = [(await runOf(f.contactId))!, (await runOf(d.contactId))!, (await runOf(x.contactId))!];
    for (const r of [rf, rd, rx]) expect(r).toMatchObject({ status: "completed", exit_reason: "posted" });
    expect(recordWrites.slice(nRec).map((w) => [w.external_id, w.call_result]).sort()).toEqual([[f.external, "follow_up"], [d.external, "dq"], [x.external, "not_interested"]]);
    expect(await digestOf(rf.id)).toContain("*Outcome:* Follow up (Jev is 88% sure)\n*Would have (actions are off):* a task for Allan Setter to call back Lead No");
    expect(await digestOf(rd.id)).toContain("*Would have (actions are off):* tag dq-budget and mark the setter card lost.");
    expect(await digestOf(rx.id)).toContain("*Would have (actions are off):* mark the setter card lost.");
    expect([tasks.length, tags.length, oppWrites.length]).toEqual([nTasks, nTags, nOpp]);
    for (const [r, node] of [[rf, "k_task"], [rd, "k_tag"], [rd, "k_lost_dq"], [rx, "k_lost_ni"]] as const) expect((await step(r.id, node))?.status).toBe("skipped");
    expect((await eventsOf(d.contactId, "setter_call.result"))[0]).toMatchObject({ predicted: "dq", result: "dq", dq_reason: "budget" });
    expect((await analysisOf(d.recordingId)).classify).toMatchObject({ dq_reason: { value: "budget" } });
  });

  it("a closing call booked within 30 minutes of hanging up is Set whatever Jev read, and whether Jev agreed is logged; one booked 50 minutes after is not", async () => {
    const k = await call(FOLLOW, { endedAgo: 45 }), late = await call(FOLLOW, { endedAgo: 70 });
    const book = (ghl: string, contactGhl: string, at: DateTime) => asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); const start = DateTime.now().plus({ days: 3 });
      await applyAppointment(c, row, adapterCompany, fake, { id: `A-${ghl}`, calendarId: "CAL", contactId: contactGhl, assignedUserId: "U1", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: at.toISO()!, raw: {} }); });
    await book("in", k.ghl, k.endedAt.plus({ minutes: 12 }));
    await book("late", late.ghl, late.endedAt.plus({ minutes: 50 }));
    const nRec = recordWrites.length;
    await run();
    const r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "completed" });
    expect(recordWrites.slice(nRec).map((w) => [w.external_id, w.call_result]).sort()).toEqual([[k.external, "set"], [late.external, "follow_up"]]);
    expect(await digestOf(r.id)).toContain("*Outcome:* Set — a closing call was booked within 30 minutes of the call (Jev read: follow up, 88% sure)");
    expect((await eventsOf(k.contactId, "setter_call.result"))[0]).toMatchObject({ predicted: "follow_up", result: "set", decided_by: "booking", booked_within_30m: true, jev_agreed: false });
    expect((await eventsOf(late.contactId, "setter_call.result"))[0]).toMatchObject({ result: "follow_up", decided_by: "jev", booked_within_30m: false });
  });

  it("the read waits until 35 minutes after the call ends, so a booking made right after hanging up is seen first", async () => {
    const k = await call(SET, { endedAgo: 20 });
    const nAsked = asked.length;
    await run();
    const r = (await runOf(k.contactId))!;
    expect(r).toMatchObject({ status: "waiting", current_node: "w2" });
    expect(asked.slice(nAsked)).toEqual(["setting,confirmation,other"]);   // the kind of call is read at 15 minutes; the result waits
    expect(await eventsOf(k.contactId, "setter_call.result")).toEqual([]);
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
    const q = (await tsOf(`setter-result:${k.recordingId}`))!;
    expect(q.channel).toBe("CSET");
    const question = posts.find((p) => p.text.includes("what did it achieve?") && p.text.includes(`|Lead No${n}>`))!;
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
    expect(recordWrites.slice(nRec).at(-1)).toEqual({ op: "update", id: expect.stringMatching(/^rec-/), call_result: "dq" });
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
    const q = (await tsOf(`setter-result:${k.recordingId}`))!;
    await asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [r.id]));
    await run(fake, companyId, DateTime.now().plus({ hours: 47 }));
    expect(await runOf(k.contactId)).toMatchObject({ status: "waiting", current_node: "w_hold" });   // not yet
    await asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [r.id]));
    await run(fake, companyId, DateTime.now().plus({ days: 2, minutes: 5 }));
    expect(await runOf(k.contactId)).toMatchObject({ status: "completed", exit_reason: "posted" });
    expect(await eventsOf(k.contactId, "intent.unanswered")).toEqual([{ domain: "setter_call_result", predicted: "unclear", predicted_confidence: "55", top_guesses: "follow up 55%, not interested 30%, set 15%", recording_id: k.recordingId }]);
    expect(await eventsOf(k.contactId, "intent.reviewed")).toEqual([]);
    expect(posts.filter((p) => p.threadTs === q.ts).map((p) => p.text)).toEqual([`Nobody answered in two days, so no result was written for Lead No${n}.`]);
    expect(recordWrites.slice(nRec).filter((w) => "call_result" in w)).toEqual([]);
  });

  it("actions ON (setter_result.act): follow up → a task for the setter due the next business day with the suggested next step; DQ → the dq tag Jev's reason maps to and the setter card lost at the DQ stage; not interested → the setter card lost; set → nothing", async () => {
    await setBinding(companyId, "setter_result.act", "true");
    try {
      const nTasks = tasks.length, nTags = tags.length, nOpp = oppWrites.length;
      const f = await call(FOLLOW), d = await call(DQ), x = await call(NI), s = await call(SET);
      for (const k of [f, d, x, s]) liveCards.set(k.ghl, setterCard(k.ghl));
      await run();
      for (const k of [f, d, x, s]) expect(await runOf(k.contactId)).toMatchObject({ status: "completed", exit_reason: "posted" });
      const wd = DateTime.now().setZone(TZ).weekday, days = wd === 5 ? 3 : wd === 6 ? 2 : 1;
      expect(tasks.slice(nTasks)).toEqual([expect.objectContaining({ contactId: f.ghl, title: `Call back Lead No${n - 3}`, assignedUserId: "U1", body: expect.stringContaining("Suggested next step: Call him Tuesday after work") })]);
      const due = DateTime.fromJSDate(tasks.at(-1)!.dueAt as Date);
      expect(Math.abs(due.diff(DateTime.now().plus({ days }), "minutes").minutes)).toBeLessThan(5);
      expect(tags.slice(nTags)).toEqual([{ contact: d.ghl, tag: "dq-budget" }]);
      expect(oppWrites.slice(nOpp).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([expect.objectContaining({ id: `card-${d.ghl}`, stageId: "STAGE-S-DQ", status: "lost" }), expect.objectContaining({ id: `card-${x.ghl}`, stageId: "STAGE-CONTACTED", status: "lost" })]);   // no not-interested stage bound: status only
      const fr = (await runOf(f.contactId))!;
      expect(await digestOf(fr.id)).toContain("*Next:* a task for Allan Setter to call back");
      expect((await eventsOf(s.contactId, "setter_call.result"))[0]).toMatchObject({ acts: true });
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
      expect((await step(r.id, "k_tag"))?.result).toMatchObject({ shadow: true, would_tag: ["dq-budget"] });
      expect((await step(r.id, "r1"))?.result).toMatchObject({ shadow: true, properties: expect.objectContaining({ call_result: "dq" }) });
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
    const q = (await tsOf(`setter-result:${u.recordingId}`, co))!;
    await tap(q.ts, "repeat", co); await run(noField, co);
    const ru = (await runOf(u.contactId))!;
    expect(ru).toMatchObject({ status: "completed", exit_reason: "posted" });
    expect((await step(ru.id, "r2"))).toMatchObject({ status: "skipped", result: { kind: "noop", not_on_object: ["call_result"] } });
    expect(await eventsOf(u.contactId, "intent.reviewed")).toEqual([expect.objectContaining({ decided: "follow_up", decided_by: "Tyler Ray" })]);
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
    expect(text).toContain("*Jev's setter-call accuracy: 50%*  ·  3 matched ÷ 6 reads with a known outcome");
    expect(text).toContain("8 setter calls read · 6 with a known outcome · 1 still waiting on one");
    expect(text).toContain("Jev was unsure on 1 and asked the team (1 answered)");
    expect(text).toContain("*Jev's setter-call accuracy by Jev's read*");
    // by setter, and the GHL read failing only drops the change made there (said, not hidden)
    const bySetter = await asOperator((c) => getMetric(c, co, { metric: "jev_setter_accuracy", period, groupBy: "setter" }, { objectRecords: async () => { throw new Error("GHL 503"); } } as unknown as GhlReads));
    expect(bySetter.rows).toEqual([{ key: "Allan Setter", label: "Allan Setter", value: 0.6, numerator: 3, denominator: 5 }]);   // h has no known outcome without GHL
    expect(formatAnswer([bySetter])).toContain("couldn't read the Discovery Call records in GHL (GHL 503)");
  });
});
