/**
 * D154/D156: a setter's GHL calls on their end of day, through Dating Nelly's own copies (installs/dating-nelly): Setter call logged
 * reads, posts and logs and writes nothing to the CRM; the end of day lists a triage call pre-filled from Jev's read and an outbound
 * call as a row of its own; filing the outbound call is what writes its Discovery Call record and moves the setter card.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { installCompany } from "@/engine/install";
import { dispatchEvent } from "@/engine/dispatch";
import { loadCompany } from "@/engine/context";
import { tick } from "@/engine/runner";
import { fakeAdapters, fakeProbes } from "@/engine/test-install";
import { recordPhoneCall, settlePhoneCall, phoneFacts } from "@/engine/recordings";
import { createCompanyWorkflow, findCompanyWorkflow, saveDefinition } from "@/engine/definitions";
import { prefill, submitEod, tokenFor, eodFacts, loadEodForm, type EodAnswers } from "@/engine/eod";
import type { Adapters, CallMedia, Classification, LiveCard } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";
const DIR = path.resolve(__dirname, "../../installs/dating-nelly");
const copy = (slug: string) => JSON.parse(fs.readFileSync(path.join(DIR, `${slug}.json`), "utf8")) as { definition: Record<string, unknown>; note: string; name?: string };

const FOLLOW = "call me back next week", DQ = "can't afford anything right now";
const transcript = (phrase: string) => [{ speaker: "0", text: "Hi, it's Mitch from Nelly's team about your application." }, { speaker: "1", text: "Hi, yes." }, { speaker: "0", text: "What are you looking for?" }, { speaker: "1", text: `Honestly, ${phrase}.` }];
const media = new Map<string, CallMedia>();
const posts: { channel: string; text: string; threadTs?: string }[] = [];
const recordWrites: Record<string, unknown>[] = [];
const notes: string[] = [], tasks: unknown[] = [], tags: string[] = [];
const cardWrites: Record<string, unknown>[] = [];
const liveCards = new Map<string, LiveCard[]>();
const criteria: Record<string, Record<string, string>> = {};
const base = fakeAdapters();
const fake: Adapters = {
  ...base,
  read: { ...base.read, listUsers: async () => [{ id: "U1", name: "Mitch Setter", email: "mitch@x.com" }, { id: "U2", name: "Nelly Closer", email: "nelly@x.com" }],
    openCards: async (_c, id) => liveCards.get(id) ?? [], objectFields: async () => ["display_label", "external_id", "contact_id", "occurred_at", "direction", "duration_sec", "setter", "outcome", "recording_url", "call_result"].map((key) => ({ key })),
    callMedia: async (_c, id) => media.get(id) ?? { transcript: null } },
  write: { ...base.write, createRecord: async (_c, o, props) => { recordWrites.push({ op: "create", object: o, ...props }); return { id: `rec-${recordWrites.length}` }; }, updateRecord: async (_c, o, id, props) => { recordWrites.push({ op: "update", object: o, id, ...props }); },
    addNote: async (_c, _id, body) => { notes.push(body); }, createTask: async (_c, _id, t) => { tasks.push(t); return { id: "t" }; }, addTag: async (_c, _id, tag) => { tags.push(tag); },
    updateOpportunity: async (_c, id, patch) => { cardWrites.push({ id, ...patch }); } },
  classifier: { choice: async (_s, input, options, _t, opts): Promise<Classification> => {
    if (options.includes("setting")) { criteria.call_type = opts?.criteria ?? {}; return { value: "setting", confidence: 0.95, distribution: { setting: 0.95 }, unclear: false }; }
    if (options.includes("not_ready")) { criteria.dq_reason = opts?.criteria ?? {}; return { value: input.includes(DQ) ? "budget" : "other", confidence: 0.8, distribution: {}, unclear: false }; }
    const v = input.includes(DQ) ? "dq" : "follow_up";
    return { value: v, confidence: 0.9, distribution: { [v]: 0.9 }, unclear: false };
  } },
  notifier: { ...base.notifier, post: async (_t, channel, text, _as, threadTs) => { posts.push({ channel, text, threadTs }); return { ts: `ts${posts.length}` }; }, update: async () => {} },
  analyst: { analyze: async () => { const parsed = { summary: "Wants something serious.", digest: "Wants something serious; budget is the question.\nFit: 6/10" }; return { text: JSON.stringify(parsed), parsed, model: "fake", usage: { input: 1, output: 1, cacheRead: 0 } }; } },
};

const TABLES = ["eod_reports", "alerts", "slack_posts", "sends", "step_effects", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "crm_records", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
let co: string, mitch: { id: string; name: string; email: string };
let n = 0;
const person = (first: string) => asOperator(async (c) => {
  const ghl = `EO${++n}`;
  const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone, tags) values ($1,$2,$3,'Test',$4,'{dating}') returning id", [co, ghl, first, TZ]))!.id;
  await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [co, id, `${ghl.toLowerCase()}@x.com`]);
  return { contactId: id, ghl };
});
/** A connected dial by Mitch (U1), 3 minutes, ended 45 minutes ago; GHL holds the transcript. */
async function dial(phrase: string, who: { contactId: string; ghl: string }) {
  const ext = `dial-${who.ghl}-${++n}`;
  media.set(ext, { recordingUrl: `https://ghl.test/${ext}`, transcript: transcript(phrase) });
  const started = new Date(Date.now() - 45 * 60e3 - 180e3);
  await asOperator(async (c) => {
    const { recording } = await recordPhoneCall(c, co, { externalId: ext, contactId: who.contactId, startedAt: started, durationSec: 180, direction: "outbound", status: "completed", callerGhlUserId: "U1", conversationUrl: `https://ghl.test/convo/${ext}` });
    const { recording: row, event } = await settlePhoneCall(c, recording, media.get(ext)!);
    await dispatchEvent(c, event!, { contact: { id: who.contactId }, recording: { id: row.id, ...phoneFacts(row) } });
  });
  return { ext, started: DateTime.fromJSDate(started) };
}
const run = () => tick(fake, DateTime.now() as DateTime<true>, co, fakeProbes);
const runOf = (contactId: string, name: string) => asOperator((c) => one<{ id: string; status: string; exit_reason: string | null }>(c, "select r.id, r.status, r.exit_reason from runs r join workflows w on w.id=r.workflow_id where r.contact_id=$1 and w.name=$2 order by r.started_at desc limit 1", [contactId, name]));
const stepsOf = (runId: string) => asOperator((c) => many<{ node_id: string; status: string }>(c, "select node_id, status from run_steps where run_id=$1 order by started_at, id", [runId]));
const eventsOf = (contactId: string, type: string) => asOperator((c) => many<{ data: Record<string, unknown> }>(c, "select data from events where contact_id=$1 and event_type=$2 order by id", [contactId, type])).then((r) => r.map((x) => x.data));
const setBinding = (key: string, value: string) => asOperator((c) => c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'text',$3) on conflict (company_id, key) do update set value=excluded.value", [co, key, Buffer.from(value)]));

describe.skipIf(!process.env.DATABASE_URL)("D154/D156: a setter's calls on the end of day (Dating Nelly's copies)", () => {
  let pia: { contactId: string; ghl: string }, omar: { contactId: string; ghl: string }, piaCall: { ext: string; started: DateTime }, omarCall: { ext: string; started: DateTime }, day: string;
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const old = await one<{ id: string }>(c, "select id from companies where slug='eodset'"); if (!old) return;
      await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [old.id]);
      await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [old.id]);
      for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [old.id]);
      await c.query("delete from companies where id=$1", [old.id]);
    });
    const r = await installCompany({ name: "EOD setter", slug: "eodset", timezone: TZ, locationId: "LOC", pit: "pit-fake", anthropicKey: "sk-fake", enable: true, templates: ["setter-call-logged"],
      roles: { "mitch@x.com": "setter" },
      crm: { pipeline_setter: "PIPE-SETTER", stage_setter_appointment_set: "STAGE-S-SET", stage_setter_dq: "STAGE-S-DQ", stage_setter_not_interested: "STAGE-S-NI", stage_setter_showed: "STAGE-S-SHOWED", assoc_discovery_call_contact: "ASSOC-DC", object_discovery_call: "custom_objects.dating_discovery" },
      slack: { setter_calls: "CSET", bookings: "CBOOK" }, eod: { setterCalls: true, dqReasons: "dating_dq_reason" } }, fake);
    co = r.companyId;
    await asOperator(async (c) => {
      await c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59' where id=$1", [co]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, channels) values ($1,'T1',$2,'UBOT','{}')", [co, encrypt("xoxb-fake")]);
      // her own copies: Setter call logged over the template's, and Setter call filed made and on
      const w = await findCompanyWorkflow(c, co, "setter-call-logged"); if (!w.ok) throw new Error(w.why);
      const scl = copy("setter-call-logged");
      expect(await saveDefinition(c, { workflowId: w.id, definition: scl.definition, note: scl.note })).toMatchObject({ ok: true, saved: true });
      const sf = copy("setter-call-filed");
      const made = await createCompanyWorkflow(c, { companyId: co, name: sf.name!, definition: sf.definition, note: sf.note });
      expect(made).toMatchObject({ ok: true, missing: [] });
      await c.query("update workflows set enabled=true where company_id=$1", [co]);
      mitch = (await one<{ id: string; name: string; email: string }>(c, "select id, name, email from users where company_id=$1 and ghl_user_id='U1'", [co]))!;
    });
    pia = await person("Pia"); omar = await person("Omar");
    liveCards.set(omar.ghl, [{ id: "card-omar", pipelineId: "PIPE-SETTER", stageId: "STAGE-NEW", status: "open", name: "Omar -- New Lead", updatedAt: new Date(Date.now() - 864e5).toISOString() }]);
    // Pia's triage call is booked with Mitch (the calendar's owner) at the time he calls her; Omar is an outbound dial, booked nowhere
    piaCall = await dial(FOLLOW, pia); omarCall = await dial(DQ, omar);
    day = piaCall.started.setZone(TZ).toFormat("yyyy-MM-dd");
    await asOperator(async (c) => {
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='first_call' order by sort limit 1", [co]))!.id;
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, source, external_id, name, appointment_term, self_booked) values ($1,'ghl','CALTRI','Triage call',$2,true) returning id", [co, term]))!.id;
      await c.query("insert into appointments (company_id, contact_id, source, calendar_id, external_id, starts_at, ends_at, booked_at, status, appointment_term, assigned_user_id) values ($1,$2,'ghl',$3,'TRI-PIA',$4,$5,$6,'confirmed',$7,$8)",
        [co, pia.contactId, cal, piaCall.started.toJSDate(), piaCall.started.plus({ minutes: 15 }).toJSDate(), piaCall.started.minus({ days: 1 }).toJSDate(), term, mitch.id]);
    });
    await run(); await run();
  });

  it("D154: Setter call logged reads, posts and logs Jev's read (call type, DQ reason from her list, the write-up); it writes nothing to the CRM and asks the team nothing", async () => {
    for (const who of [pia, omar]) expect(await runOf(who.contactId, "Setter call logged"), who.ghl).toMatchObject({ status: "completed" });
    expect(criteria.call_type.setting).toMatch(/A booked triage or strategy call is a setting call too/);
    expect(Object.keys(criteria.dq_reason).sort()).toEqual(["bad_contact", "budget", "casual", "in_relationship", "not_ready", "other"]);
    expect(recordWrites).toEqual([]); expect(notes).toEqual([]); expect(tasks).toEqual([]); expect(tags).toEqual([]); expect(cardWrites).toEqual([]);
    expect(posts.filter((p) => p.channel === "CSET" && !p.threadTs)).toHaveLength(2);
    expect(posts.some((p) => /Set, follow up or DQ\?|Tap ✅/.test(p.text))).toBe(false);
    expect(await eventsOf(omar.contactId, "setter_call.result")).toEqual([expect.objectContaining({ external_id: omarCall.ext, result: "dq", dq_reason: "budget", dq_domain: "dating_dq_reason", call_type: "setting", digest: expect.stringContaining("Wants something serious") })]);
  });

  it("D156: the end of day asks why a DQ from her list; Pia's triage call is pre-filled from Jev's read; Omar's outbound call is a row of its own, pre-filled; both are owed", async () => {
    const fields = await asOperator((c) => loadEodForm(c, co));
    expect(fields.find((f) => f.key === "dq_reason")!.options).toEqual(["Can't afford it right now", "Not ready for a relationship", "Already in a relationship", "Looking for something casual", "Wrong or fake contact", "Other"]);
    const p = await asOperator(async (c) => prefill(c, (await loadCompany(c, co)).row, mitch, day));
    expect(p.calls.map((x) => ({ id: x.appointment_id.startsWith("dial:") ? x.appointment_id : "booking", contact: x.contact, kind: x.kind, outcome: x.outcome, dq: x.dq_reason, hint: x.hint ?? "", rec: x.recording_url }))).toEqual([
      { id: "booking", contact: "Pia Test", kind: "triage", outcome: "follow_up", dq: "", hint: "Jev's read of the call: check it.", rec: `https://ghl.test/convo/${piaCall.ext}` },
      { id: `dial:${omarCall.ext}`, contact: "Omar Test", kind: "dial", outcome: "dq", dq: "Can't afford it right now", hint: "Jev's read of the call: check it.", rec: `https://ghl.test/convo/${omarCall.ext}` },
    ]);
    expect(p.calls[1].about).toContain("Wants something serious");
    expect(p).toMatchObject({ calls_count: 2, closes: 0, cash: 0, revenue: 0 });
    const facts = await asOperator(async (c) => eodFacts(c, (await loadCompany(c, co)).row, mitch.id, "https://engine.test", piaCall.started.plus({ hours: 1 }) as DateTime<true>));
    expect(facts.today.calls).toBe(2);
  });

  it("D156: filing Omar's outbound call as a DQ writes his Discovery Call record and moves his setter card to DQ (lost), with a line under the call's post; Pia's triage call files through its booking as before; filing again writes nothing twice", async () => {
    const token = await asOperator((c) => tokenFor(c, mitch.id));
    const p = await asOperator(async (c) => prefill(c, (await loadCompany(c, co)).row, mitch, day));
    const answers: EodAnswers = { ...p, calls: p.calls.map((x) => (x.kind === "dial" ? { ...x, dq_note: "said so twice" } : x)), day_answers: {} };
    const r = await asOperator((c) => submitEod(c, { token, day, answers }));
    expect(r).toMatchObject({ ok: true, recorded: 2 });
    expect(await eventsOf(omar.contactId, "setter_call.filed")).toEqual([expect.objectContaining({ conversation: omarCall.ext, result: "dq", predicted: "dq", jev_agreed: true, dq_reason: "Can't afford it right now", dq_note: "said so twice", setter: "Mitch Setter", setter_ghl_user_id: "U1" })]);
    await run(); await run();
    const sf = (await runOf(omar.contactId, "Setter call filed"))!;
    expect(sf).toMatchObject({ status: "completed", exit_reason: "filed" });
    expect(recordWrites).toEqual([expect.objectContaining({ op: "create", object: "custom_objects.dating_discovery", external_id: omarCall.ext, outcome: "showed", call_result: "dq", setter: "Mitch Setter", recording_url: `https://ghl.test/convo/${omarCall.ext}` })]);
    expect(cardWrites).toEqual([expect.objectContaining({ id: "card-omar", stageId: "STAGE-S-DQ", status: "lost" })]);
    const line = posts.find((x) => x.text.includes("End of day: DQ"));
    expect(line?.threadTs).toBeTruthy();
    // Pia: the triage call's answer went the booking's way (its disposition), not as an outbound call
    expect(await eventsOf(pia.contactId, "setter_call.filed")).toEqual([]);
    const pa = await asOperator((c) => one<{ cat: string | null }>(c, "select cot.category as cat from appointments a left join company_terms cot on cot.id=a.call_outcome_term where a.company_id=$1 and a.external_id='TRI-PIA'", [co]));
    expect(pa?.cat).toBe("follow_up");
    // filed again unchanged: held; the form opens on what was filed and nothing is owed
    const again = await asOperator((c) => submitEod(c, { token, day, answers }));
    expect(again).toMatchObject({ ok: true });
    expect(await eventsOf(omar.contactId, "setter_call.filed")).toHaveLength(1);
    const facts = await asOperator(async (c) => eodFacts(c, (await loadCompany(c, co)).row, mitch.id, "https://engine.test", piaCall.started.plus({ hours: 1 }) as DateTime<true>));
    expect(facts.today.calls).toBe(0);
    const p2 = await asOperator(async (c) => prefill(c, (await loadCompany(c, co)).row, mitch, day));
    expect(p2.calls.find((x) => x.kind === "dial")).toMatchObject({ outcome: "dq", dq_reason: "" });
  });

  it("D156: an outbound row the engine did not put on the day is dropped; with eod.setter_calls off neither the outbound row nor Jev's read is on the form (every other offer)", async () => {
    const token = await asOperator((c) => tokenFor(c, mitch.id));
    const p = await asOperator(async (c) => prefill(c, (await loadCompany(c, co)).row, mitch, day));
    const forged = { ...p.calls.find((x) => x.kind === "dial")!, appointment_id: "dial:somebody-else", outcome: "not_interested" };
    await asOperator((c) => submitEod(c, { token, day, answers: { ...p, calls: [...p.calls, forged], day_answers: {} } }));
    expect(await asOperator((c) => many(c, "select 1 from events where company_id=$1 and event_type='setter_call.filed' and data->>'conversation'='somebody-else'", [co]))).toEqual([]);
    await setBinding("eod.setter_calls", "off");
    const off = await asOperator(async (c) => prefill(c, (await loadCompany(c, co)).row, mitch, day));
    expect(off.calls.map((x) => ({ kind: x.kind, hint: x.hint ?? "" }))).toEqual([{ kind: "triage", hint: "" }]);
    await setBinding("eod.setter_calls", "on");
  });
});
