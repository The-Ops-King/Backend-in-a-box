/**
 * D253, the shipped workflows end to end: Reassign request hands the call over, Call reassigned moves the CRM and tells the new
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

describe.skipIf(!HAS_DB)("D253: reassigning a call, the shipped workflows", () => {
  let call = "", past = "";
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "D253S", slug: SLUG, timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: {}, enable: true, templates: ["reassign-request", "call-reassigned", "different-closer"],
      crm: { pipeline_closer: "PIPE-CLOSER" } }, fake)).companyId;
    await asOperator(async (c) => {
      await c.query("update companies set mode='live' where id=$1", [co]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'TD253',$2,'{}')", [co, encrypt("xoxb-fake")]);
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
});
