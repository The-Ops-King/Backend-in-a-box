/**
 * D254, the shipped workflows end to end: Reassign request hands the call over, Call reassigned moves the CRM and tells the new
 * closer (or the team, when they are not set up), and Another closer took the call asks before anything moves.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { installCompany } from "@/engine/install";
import { tick } from "@/engine/runner";
import { fakeAdapters } from "@/engine/test-install";
import { requestReassign } from "@/engine/reassign";
import { recordRecording } from "@/engine/recordings";
import { dispatchEvent } from "@/engine/dispatch";
import { reactionArrived } from "@/engine/webhooks/slack";
import { loadCompany } from "@/engine/context";
import { prefill, submitEod, todayFor } from "@/engine/eod";
import { TAKEN } from "@/engine/eod-form";
import { reassignStart, reassignPicked, reassignChosen } from "@/engine/webhooks/reassign-command";
import { parseSlackInteraction } from "@/engine/webhooks/slack-actions";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const HAS_DB = !!process.env.DATABASE_URL;
const TZ = "America/Phoenix";
const SLUG = `d253s-${Date.now()}`;
const posts: { channel: string; text: string; threadTs?: string }[] = [];
const writes: string[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base,
  read: { ...base.read, openCards: async (_c, ghl) => (ghl === "G-B" ? [{ id: "CARD-B", pipelineId: "PIPE-CLOSER", stageId: "STAGE-SCHED", status: "open", name: "Bertha Ekoko", assignedUserId: "U-JP", updatedAt: new Date().toISOString(), contactId: "G-B" }] : []) },
  write: { ...base.write,
    updateRecord: async (_c, object, id, props) => { writes.push(`record ${object} ${id} ${JSON.stringify(props)}`); },
    updateContact: async (_c, id, patch) => { writes.push(`contact ${id} ${JSON.stringify(patch)}`); },
    updateOpportunity: async (_c, id, patch) => { writes.push(`card ${id} ${JSON.stringify(patch)}`); } },
  notifier: { ...base.notifier, post: async (_t, channel, text, _as, threadTs) => { posts.push({ channel, text, threadTs }); return { ts: `ts${posts.length}` }; } },
};
let co = "", ct = "", ct2 = "", jp = "", min = "", mel = "";
const tickNow = () => tick(fake, DateTime.now() as DateTime<true>, co);
const ticks = async (n = 3) => { for (let i = 0; i < n; i++) await tickNow(); };
const runs = (appt: string) => asOperator((c) => many<{ name: string; status: string; exit_reason: string | null }>(c, "select w.name, r.status, r.exit_reason from runs r join workflows w on w.id=r.workflow_id where r.appointment_id=$1 order by r.started_at, w.name", [appt]));
const closerOf = async (appt: string) => (await asOperator((c) => one<{ name: string }>(c, "select u.name from appointments a join users u on u.id=a.assigned_user_id where a.id=$1", [appt])))!.name;

describe.skipIf(!HAS_DB)("D254: reassigning a call, the shipped workflows", () => {
  let call = "", past = "";
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "D254S", slug: SLUG, timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: {}, enable: true, templates: ["reassign-request", "call-reassigned", "different-closer"],
      crm: { pipeline_closer: "PIPE-CLOSER" } }, fake)).companyId;
    await asOperator(async (c) => {
      await c.query("update companies set mode='live' where id=$1", [co]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'TD254',$2,'{}')", [co, encrypt("xoxb-fake")]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'slack.channel.bookings','channel',$2),($1,'slack.channel.attention','channel',$3) on conflict (company_id,key) do update set value=excluded.value", [co, Buffer.from("CBOOK"), Buffer.from("CATT")]);
      jp = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id, slack_user_id) values ($1,'jp@x.com','Jose P','closer','U-JP','S-JP') returning id", [co]))!.id;
      min = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id, slack_user_id, booking_url) values ($1,'min@x.com','Minerva Rostro','closer','U-MIN','S-MIN','https://cal.example/minerva') returning id", [co]))!.id;
      mel = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'mel@x.com','Mel R','closer','U-MEL') returning id", [co]))!.id;
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [co]))!.id;
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, external_id, name, appointment_term, active) values ($1,'CAL-RR','Consultation RR',$2,true) returning id", [co, term]))!.id;
      ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,'G-B','Bertha','Ekoko',$2) returning id", [co, TZ]))!.id;
      ct2 = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,'G-S','Sherita','Hogan',$2) returning id", [co, TZ]))!.id;
      const at = DateTime.now().plus({ days: 1 }), was = DateTime.now().minus({ hours: 3 });
      call = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, slot_key, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status) values ($1,$2,'ghl','EV-B','EV-B',$3,$4,$5,$6,$7,now(),'confirmed') returning id",
        [co, ct, cal, term, jp, at.toJSDate(), at.plus({ minutes: 45 }).toJSDate()]))!.id;
      past = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, slot_key, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status) values ($1,$2,'ghl','EV-S','EV-S',$3,$4,$5,$6,$7,now(),'confirmed') returning id",
        [co, ct2, cal, term, jp, was.toJSDate(), was.plus({ minutes: 45 }).toJSDate()]))!.id;
      await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id) values ($1,'custom_objects.sales_call','EV-B','REC-B',$2)", [co, ct]);
    });
  });

  it("a call still ahead: handed over in the engine, the Sales Call, owner and closer card move, and the new closer is told to send her own link", async () => {
    expect(await asOperator((c) => requestReassign(c, co, { appointmentId: call, toUserId: min, via: "slack", by: "Jose P" }))).toMatchObject({ ok: true, runs: 1 });
    await ticks();
    expect(await closerOf(call)).toBe("Minerva Rostro");
    expect(await runs(call)).toEqual([expect.objectContaining({ name: "Reassign request", exit_reason: "handed_over" }), expect.objectContaining({ name: "Call reassigned", exit_reason: "done" })]);
    expect(writes).toEqual(expect.arrayContaining([`record custom_objects.sales_call REC-B {"closer":"Minerva Rostro"}`, expect.stringMatching(/^contact G-B .*"assignedUserId":"U-MIN"/), expect.stringMatching(/^card CARD-B .*"stageId":"STAGE-SCHED".*"assignedUserId":"U-MIN"/)]));
    const dm = posts.find((p) => p.channel === "S-MIN");
    expect(dm?.text).toMatch(/^Minerva, Jose P handed you <.*\|Bertha Ekoko>'s call .*reach out before the call and send them yours\.\nIf they need another time, send them your link → https:\/\/cal\.example\/minerva$/);
    expect(posts.filter((p) => p.channel === "CATT")).toEqual([]);   // she is set up: nobody is told she is not
  });

  it("a call already taken, to someone not in Slack: handed over, no reach-out DM, and the team is told what is missing", async () => {
    posts.length = 0;
    await asOperator((c) => requestReassign(c, co, { appointmentId: past, toUserId: mel, via: "eod", by: "Jose P" }));
    await ticks();
    expect(await closerOf(past)).toBe("Mel R");
    expect(posts.map((p) => p.channel)).toEqual(["CATT"]);
    expect(posts[0].text).toMatch(/^⚠️ Mel R has <.*\|Sherita Hogan>'s call .* now, but isn't set up in Slack\. Add them/);
  });

  it("another closer recorded a booked call the client spoke on: asked first; ✅ hands it to them and Call reassigned follows", async () => {
    posts.length = 0;
    await asOperator((c) => c.query("update appointments set assigned_user_id=$2, reassigned_at=null where id=$1", [call, jp]));
    const at = (await asOperator((c) => one<{ starts_at: Date }>(c, "select starts_at from appointments where id=$1", [call])))!.starts_at;
    const r = await asOperator((c) => recordRecording(c, co, { externalId: "F-1", title: "Impromptu Google Meet Meeting", startedAt: new Date(at.getTime() + 14 * 60e3), durationMin: 93, shareUrl: "https://fathom.video/share/x",
      recordedBy: { email: "min@x.com", name: "Minerva Rostro" }, invitees: [{ name: "Minerva Rostro", email: "min@x.com", isExternal: false }],
      transcript: [{ speaker: "Minerva Rostro", text: "Hi Bertha" }, { speaker: "Bertha Ekoko", text: "Hi!" }] }));
    expect(r).toMatchObject({ outcome: "linked", recording: { client_spoke: true } });
    if (r.outcome === "linked" && "event" in r && r.event) await asOperator((c) => dispatchEvent(c, r.event!, { contact: { id: ct }, appointment: { id: call } }));
    await ticks();
    const ask = posts.find((p) => p.channel === "CATT");
    expect(ask?.text).toMatch(/^🔀 <.*\|Bertha Ekoko>'s call .* is booked with <@S-JP>, but Minerva Rostro recorded it \(93 min, and the client spoke\)\./);
    expect(await closerOf(call)).toBe("Jose P");   // nothing moves on its own
    const ts = `ts${posts.indexOf(ask!) + 1}`;
    await asOperator(async (c) => reactionArrived(c, co, { kind: "reaction", eventId: "EvTap", user: "UTYLER", reaction: "white_check_mark", channel: "CATT", ts, removed: false }));
    await ticks(4);
    expect(await closerOf(call)).toBe("Minerva Rostro");
    expect(posts.some((p) => p.threadTs === ts && /^✅ Minerva has the call now, per /.test(p.text))).toBe(true);
    expect((await runs(call)).filter((x) => x.name === "Another closer took the call")).toEqual([expect.objectContaining({ exit_reason: "handed_over" })]);
  });

  it("the booking's own closer recorded it, or only the team spoke: nobody is asked", async () => {
    posts.length = 0;
    const at = (await asOperator((c) => one<{ starts_at: Date }>(c, "select starts_at from appointments where id=$1", [call])))!.starts_at;
    const r = await asOperator((c) => recordRecording(c, co, { externalId: "F-2", title: "Bertha Ekoko and Minerva", startedAt: new Date(at.getTime() + 60e3), durationMin: 40,
      recordedBy: { email: "min@x.com", name: "Minerva Rostro" }, invitees: [{ name: "Bertha", email: "b@x.com", isExternal: true }], transcript: [{ speaker: "Minerva Rostro", text: "hi" }, { speaker: "Bertha Ekoko", text: "hi" }] }));
    if (r.outcome === "linked" && "event" in r && r.event) await asOperator((c) => dispatchEvent(c, r.event!, { contact: { id: ct }, appointment: { id: call } }));
    await ticks();
    expect(posts.filter((p) => p.channel === "CATT")).toEqual([]);
  });
  it("the end of day: Jose says Minerva took a call; it leaves his day, is handed to her and is on hers to file", async () => {
    const day = todayFor(TZ), now = DateTime.now().setZone(TZ);
    const at = now.hour >= 1 ? now.minus({ minutes: 30 }) : now;
    const id = await asOperator(async (c) => {
      await c.query("update users set report_token=$2 where id=$1", [jp, `tok-${SLUG}`]);
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [co]))!.id;
      const cal = (await one<{ id: string }>(c, "select id from calendars where company_id=$1 and external_id='CAL-RR'", [co]))!.id;
      const ct3 = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,'G-J','Johanny','Restrepo',$2) returning id", [co, TZ]))!.id;
      return (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, slot_key, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status) values ($1,$2,'ghl','EV-J','EV-J',$3,$4,$5,$6,$7,now(),'confirmed') returning id",
        [co, ct3, cal, term, jp, at.toJSDate(), at.plus({ minutes: 20 }).toJSDate()]))!.id;
    });
    const pre = await asOperator(async (c) => { const { row } = await loadCompany(c, co); return prefill(c, row, { id: jp, name: "Jose P", email: "jp@x.com" }, day); });
    const calls = pre.calls.filter((x) => x.appointment_id === id).map((x) => ({ ...x, outcome: TAKEN }));
    expect(calls).toHaveLength(1);
    const ans = { calls_count: "0", closes: "", deposits: "0", cash: "", revenue: "", day_answers: {} };
    expect(await asOperator((c) => submitEod(c, { token: `tok-${SLUG}`, day, answers: { ...ans, calls } as never }))).toMatchObject({ ok: false, why: expect.stringMatching(/who took the call/) });
    expect(await asOperator((c) => submitEod(c, { token: `tok-${SLUG}`, day, answers: { ...ans, calls: calls.map((x) => ({ ...x, taken_by: jp })) } as never }))).toMatchObject({ ok: false, why: expect.stringMatching(/on the team/) });
    expect(await asOperator((c) => submitEod(c, { token: `tok-${SLUG}`, day, answers: { ...ans, calls: calls.map((x) => ({ ...x, taken_by: min })) } as never }))).toMatchObject({ ok: true, recorded: 0 });
    await ticks();
    expect(await closerOf(id)).toBe("Minerva Rostro");
    const theirs = await asOperator(async (c) => { const { row } = await loadCompany(c, co); return prefill(c, row, { id: min, name: "Minerva Rostro", email: "min@x.com" }, day); });
    expect(theirs.calls.map((x) => x.contact)).toContain("Johanny Restrepo");
    const his = await asOperator(async (c) => { const { row } = await loadCompany(c, co); return prefill(c, row, { id: jp, name: "Jose P", email: "jp@x.com" }, day); });
    expect(his.calls.map((x) => x.contact)).not.toContain("Johanny Restrepo");
  });
  it("/reassign: a closer's own calls, ticked from the day's list, handed to whoever they pick; someone else's are a manager's", async () => {
    const at = DateTime.now().setZone(TZ).plus({ days: 2 }).set({ hour: 10, minute: 0 }), day = at.toISODate()!;
    const [a1, a2] = await asOperator(async (c) => {
      const cal = (await one<{ id: string; t: string }>(c, "select id, appointment_term as t from calendars where company_id=$1 and external_id='CAL-RR'", [co]))!;
      const mk = async (ext: string, ctId: string, h: number) => (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, slot_key, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status) values ($1,$2,'ghl',$3,$3,$4,$5,$6,$7,$8,now(),'confirmed') returning id",
        [co, ctId, ext, cal.id, cal.t, jp, at.plus({ hours: h }).toJSDate(), at.plus({ hours: h, minutes: 45 }).toJSDate()]))!.id;
      return [await mk("EV-R1", ct, 0), await mk("EV-R2", ct2, 2)];
    });
    const start = await asOperator((c) => reassignStart(c, co, "S-JP", TZ, "CCHAN"));
    expect(start).toMatchObject({ view: { callback_id: "reassign_pick" } });
    const fromOpts = ((start as { view: { blocks: { block_id: string; element: { options: { value: string }[] } }[] } }).view.blocks[0].element.options).map((o) => o.value);
    expect(fromOpts).toEqual([jp]);   // a closer sees only themselves
    expect(await asOperator((c) => reassignStart(c, co, "S-NOBODY", TZ, "CCHAN"))).toMatchObject({ say: expect.stringMatching(/not on this offer's team/) });
    expect(await asOperator((c) => reassignPicked(c, co, "S-MIN", TZ, { from: jp, day }, '{"channel":"CCHAN"}'))).toMatchObject({ errors: { from: expect.stringMatching(/your own calls/) } });
    const picked = await asOperator((c) => reassignPicked(c, co, "S-JP", TZ, { from: jp, day }, '{"channel":"CCHAN"}'));
    const view = (picked as { view: { callback_id: string; private_metadata: string; blocks: { block_id?: string; element?: { options: { value: string; text: { text: string } }[] } }[] } }).view;
    expect(view.callback_id).toBe("reassign_calls");
    const listed = view.blocks.find((b) => b.block_id === "calls")!.element!.options;
    expect(listed.map((o) => o.value)).toEqual([a1, a2]);
    expect(listed[0].text.text).toMatch(/^10:00 AM · Bertha Ekoko \(Closing/);
    expect(view.blocks.find((b) => b.block_id === "to")!.element!.options.map((o) => o.value)).not.toContain(jp);
    expect(await asOperator((c) => reassignChosen(c, co, "S-JP", TZ, { calls: "", to: min }, view.private_metadata))).toMatchObject({ errors: { calls: "Tick at least one call" } });
    const done = await asOperator((c) => reassignChosen(c, co, "S-JP", TZ, { calls: `${a1},${a2}`, to: min }, view.private_metadata));
    expect(done).toMatchObject({ say: expect.stringMatching(/^🔀 Handed 2 calls to Minerva Rostro: 10:00 AM Bertha Ekoko, 12:00 PM Sherita Hogan\./) });
    await ticks();
    expect([await closerOf(a1), await closerOf(a2)]).toEqual(["Minerva Rostro", "Minerva Rostro"]);
  });

  it("a form's checkboxes and date come back as values", () => {
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: "view_submission", user: { id: "U1" }, view: { callback_id: "reassign_calls", private_metadata: "{}", state: { values: {
      calls: { v: { selected_options: [{ value: "a" }, { value: "b" }] } }, day: { v: { selected_date: "2026-10-30" } }, to: { v: { selected_option: { value: "m" } } } } } } }) }).toString();
    expect(parseSlackInteraction(raw)).toMatchObject({ kind: "submit", values: { calls: "a,b", day: "2026-10-30", to: "m" } });
  });
});
