/**
 * D271 (Tyler, PMU's Fathom → GHL → Slack): the invite's email first, then the Zoom id, then who spoke, then the title, each held to the
 * time; a meeting recorded by two of the team is one review; a meeting in parts is one call; the review's note is one note, updated.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "./crypto";
import { recordRecording, resolveRecording, titleNames, type RecordingInput } from "./recordings";
import { runLookup } from "./lookup";
import { parseDefinition, extractManifest } from "./definition";
import { syncTriggers } from "./install";
import { emitEvent, dispatchEvent } from "./dispatch";
import { tick } from "./runner";
import { fakeAdapters } from "./test-install";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `recs267-${Date.now()}`;
let co = "", closer = "", term = "", cal = "";
const t0 = new Date("2026-11-03T17:00:00Z");
const rec = (id: string, over: Partial<RecordingInput> = {}): RecordingInput => ({ externalId: id, startedAt: t0, invitees: [], recordedBy: { email: "carly@co.com" }, ...over });
const person = (first: string, last: string, email?: string) => asOperator(async (c) => {
  const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,$2,$3,$4) returning id", [co, `G-${first}`, first, last]))!.id;
  if (email) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [co, id, email]);
  return id;
});
const book = (contact: string, ext: string, at: Date, meetingKey: string | null = null) => asOperator(async (c) =>
  (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status, meeting_key) values ($1,$2,'calendly',$3,$4,$5,$6,$7,$7::timestamptz + interval '45 minutes',now(),'confirmed',$8) returning id",
    [co, contact, ext, cal, term, closer, at, meetingKey]))!.id);
const minutes = (n: number) => new Date(t0.getTime() + n * 60e3);
let day = 0;
const nextDay = () => new Date(t0.getTime() + ++day * 86_400e3);

describe.skipIf(!process.env.DATABASE_URL)("D271: recordings for PMU's call review", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode, send_window_start, send_window_end) values ('Recs 267',$1,'America/New_York','live','00:00','23:59') returning id", [SLUG]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [co]);
      term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [co]))!.id;
      cal = (await one<{ id: string }>(c, "insert into calendars (company_id, source, external_id, name, appointment_term) values ($1,'calendly','CAL','Consultation',$2) returning id", [co, term]))!.id;
      closer = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'carly@co.com','Carly Vu','closer','U-CARLY') returning id", [co]))!.id;
      await c.query("insert into users (company_id, email, name, role, ghl_user_id) values ($1,'jp@co.com','Jose Perez','closer','U-JP')", [co]);
    });
  });

  it("the title names who it is with, the team's own left out; a tool's title names nobody", () => {
    const staff = [["carly", "vu"], ["jose", "perez"]];
    expect(titleNames("Shay and Carly Vu", staff)).toEqual(["Shay"]);
    expect(titleNames("Carline Sanders: The Beauty Moguls Consultation", staff)).toEqual(["Carline Sanders"]);
    expect(titleNames("Test again <> Carly Vu", staff)).toEqual(["Test again"]);
    expect(titleNames("Impromptu Zoom Meeting", staff)).toEqual([]);
    expect(titleNames(null, staff)).toEqual([]);
  });

  it("D276: a booking cancelled after its start is still the call (they showed, then the slot was cleared); one cancelled before it is not", async () => {
    const at = nextDay(), bo = await person("Bo", "Lane", "bo@x.com"), held = await book(bo, "H-1", at);
    await asOperator((c) => c.query("update appointments set status='cancelled', source_updated_at=$2 where id=$1", [held, new Date(at.getTime() + 40 * 60e3)]));
    const r = await asOperator((c) => resolveRecording(c, co, rec("h1", { startedAt: new Date(at.getTime() + 60e3), invitees: [{ email: "bo@x.com", isExternal: true }], transcript: [{ speaker: "Bo Lane", text: "hi" }] })));
    expect(r.match).toMatchObject({ contactId: bo, appointmentId: held });
    const at2 = nextDay(), cy = await person("Cy", "Moss", "cy@x.com"), gone = await book(cy, "H-2", at2);
    await asOperator((c) => c.query("update appointments set status='cancelled', source_updated_at=$2 where id=$1", [gone, new Date(at2.getTime() - 60 * 60e3)]));
    const r2 = await asOperator((c) => resolveRecording(c, co, rec("h2", { startedAt: new Date(at2.getTime() + 60e3), invitees: [{ email: "cy@x.com", isExternal: true }], transcript: [{ speaker: "Cy Moss", text: "hi" }] })));
    expect(r2.match?.appointmentId).not.toBe(gone);
  });

  it("the invite's email first, held to the time: their booking then wins even when the speaker's name is not theirs", async () => {
    const at = nextDay(), ana = await person("Ana", "Ruiz", "ana@x.com"), appt = await book(ana, "E-1", at);
    const r = await asOperator((c) => resolveRecording(c, co, rec("e1", { startedAt: new Date(at.getTime() + 2 * 60e3), invitees: [{ email: "ana@x.com", isExternal: true }], transcript: [{ speaker: "iPhone", text: "hi" }] })));
    expect(r.match).toEqual({ contactId: ana, by: "email", appointmentId: appt });
    // her booking is hours before: not the email's fit by time; D236 places it (a call held late is that booking)
    const off = await asOperator((c) => resolveRecording(c, co, rec("e2", { startedAt: new Date(at.getTime() + 5 * 3600e3), invitees: [{ email: "ana@x.com", isExternal: true }] })));
    expect(off.match).toMatchObject({ contactId: ana, by: "email", placed: "held_late", appointmentId: appt });
  });

  it("D273: the invite's email wins over who spoke (Tyler: \"if it's shay's email then keep it shay\"), and the difference is the operator's to see", async () => {
    const at = nextDay(), cori = await person("Corina", "Raduc", "cori@x.com"), beth = await person("Beth", "Huff");
    const coriAt = await book(cori, "C-1", at); await book(beth, "B-1", at);
    const said = rec("cb", { startedAt: new Date(at.getTime() + 60e3), title: "Corina Raduc and Carly Vu", invitees: [{ email: "cori@x.com", isExternal: true }], transcript: [{ speaker: "Beth Huff", text: "hello" }, { speaker: "Carly Vu", text: "hi" }] });
    const r = await asOperator((c) => resolveRecording(c, co, said));
    expect(r).toMatchObject({ match: { contactId: cori, by: "email", appointmentId: coriAt }, conflict: expect.stringMatching(/the invite's email is Corina Raduc, but Beth Huff spoke, who is Beth Huff in the CRM/) });
    const kept = await asOperator((c) => recordRecording(c, co, said));
    expect(kept).toMatchObject({ outcome: "linked", recording: { contact_id: cori } });
    expect(await asOperator((c) => one<{ level: string; text: string }>(c, "select level, text from alerts where company_id=$1 and key=$2", [co, `recording:conflict:${kept.recording.id}`]))).toMatchObject({ level: "warning", text: expect.stringMatching(/Linked by the invite's email; check it\. "Corina Raduc and Carly Vu", recorded by carly@co\.com on/) });
  });

  it("then the appointment's time (its Zoom id, the recorder's booking), then the name on the call or in the title", async () => {
    const at = nextDay(), zed = await person("Zed", "Moss"), zAt = await book(zed, "Z-1", at, "8881234567");
    const z = await asOperator((c) => resolveRecording(c, co, rec("z1", { startedAt: new Date(at.getTime() + 60e3), meetingUrl: "https://us02web.zoom.us/j/8881234567?pwd=x" })));
    expect(z.match).toEqual({ contactId: zed, by: "meeting", appointmentId: zAt });
    const at2 = nextDay(), shay = await person("Shay", "Lin"), sAt = await book(shay, "S-1", at2);
    expect((await asOperator((c) => resolveRecording(c, co, rec("t0", { startedAt: new Date(at2.getTime() + 60e3), title: "Shay and Carly Vu" })))).match).toEqual({ contactId: shay, by: "time", appointmentId: sAt });   // the recorder's booking then
    const t = await asOperator((c) => resolveRecording(c, co, rec("t1", { startedAt: new Date(at2.getTime() + 60e3), title: "Shay and Carly Vu", recordedBy: { email: "admin@co.com" } })));
    expect(t.match).toEqual({ contactId: shay, by: "title", appointmentId: sAt });   // not the recorder's booking: the title's name decides
    const later = await asOperator((c) => resolveRecording(c, co, rec("t2", { startedAt: new Date(at2.getTime() + 4 * 3600e3), title: "Shay and Carly Vu" })));
    expect(later.match).toBeNull();   // the title names her, but no booking of hers fits that time
  });

  it("the same meeting recorded by two of the team is one: the second is linked as the first and starts nothing", async () => {
    const at = nextDay(), tun = await person("Tunde", "Negron", "tunde@x.com"); await book(tun, "T-1", at);
    const first = await asOperator((c) => recordRecording(c, co, rec("cp-1", { startedAt: new Date(at.getTime() + 60e3), durationMin: 40, title: "Tunde Negron and Carly Vu", invitees: [{ email: "tunde@x.com", isExternal: true }] })));
    expect(first.outcome).toBe("linked");
    const second = await asOperator((c) => recordRecording(c, co, rec("cp-2", { startedAt: new Date(at.getTime() + 3 * 60e3), durationMin: 38, title: "Tunde Negron and Carly Vu", recordedBy: { email: "jp@co.com" }, invitees: [] })));
    expect(second).toMatchObject({ outcome: "copy", of: first.recording.id, recording: { contact_id: tun, link_status: "linked", raw: expect.objectContaining({ copy_of: first.recording.id }) } });
    // two closers each on an impromptu meeting at once are not copies of each other
    const lone = await asOperator((c) => recordRecording(c, co, rec("im-1", { startedAt: minutes(-600), durationMin: 30, title: "Impromptu Zoom Meeting" })));
    const other = await asOperator((c) => recordRecording(c, co, rec("im-2", { startedAt: minutes(-598), durationMin: 30, title: "Impromptu Zoom Meeting", recordedBy: { email: "jp@co.com" } })));
    expect(lone.outcome).not.toBe("copy"); expect(other.outcome).not.toBe("copy");
  });

  it("a meeting that dropped and was joined again is one conversation: parts within the gap, its copy left out", async () => {
    const at = nextDay(), mia = await person("Mia", "Park", "mia@x.com"); await book(mia, "M-1", at);
    const part = (id: string, startMin: number, len: number, by = "carly@co.com") => asOperator((c) => recordRecording(c, co, rec(id, { startedAt: new Date(at.getTime() + startMin * 60e3), endedAt: new Date(at.getTime() + (startMin + len) * 60e3), durationMin: len, title: "Mia Park and Carly Vu", recordedBy: { email: by }, invitees: [{ email: "mia@x.com", isExternal: true }] })));
    const p1 = await part("mp-1", 1, 20), p2 = await part("mp-2", 25, 15), p3 = await part("mp-3", 70, 10);
    await part("mp-1b", 2, 19, "jp@co.com");   // JP's copy of the first part
    const convo = await asOperator((c) => runLookup(c, { companyId: co, contactId: mia, appointmentId: null, now: DateTime.now() }, "call_conversation", { recording_id: p2.recording.id, gap_min: "20" }));
    expect("value" in convo && convo.value).toMatchObject({ count: 2, part: 2, key: "mp-1" });
    expect("value" in convo && (convo.value.items as { id: string }[]).map((x) => x.id)).toEqual([p1.recording.id, p2.recording.id]);
    const alone = await asOperator((c) => runLookup(c, { companyId: co, contactId: mia, appointmentId: null, now: DateTime.now() }, "call_conversation", { recording_id: p3.recording.id, gap_min: "20" }));
    expect("value" in alone && alone.value).toMatchObject({ count: 1, key: "mp-3" });   // 30 minutes after the last part: its own call
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D271: a keyed note is one note; the review's model is the step's", () => {
  const notes: { op: string; id?: string; body: string }[] = [], asked: (string | undefined)[] = [];
  const base = fakeAdapters();
  const fake: Adapters = { ...base,
    write: { ...base.write, addNote: async (_c, _id, body) => { notes.push({ op: "add", body }); return { id: `note-${notes.length}` }; }, updateNote: async (_c, _ct, id, body) => { notes.push({ op: "update", id, body }); } },
    analyst: { analyze: async (_k, req) => { asked.push(req.model); return { text: "summary", model: req.model ?? "default", usage: { input: 1, output: 1, cacheRead: 0 } }; } } };
  let nco = "", ct = "";
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      nco = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode, send_window_start, send_window_end) values ('Notes 267',$1,'America/New_York','live','00:00','23:59') returning id", [`notes267-${Date.now()}`]))!.id;
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'secret.anthropic_key','secret',$4)", [nco, Buffer.from("LOC"), encrypt("p1"), encrypt("sk-test")]);
      ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'G-NOTE','Nia','Ode') returning id", [nco]))!.id;
      const def = parseDefinition({ schema: 1, reentry: "always", nodes: [
        { id: "t1", type: "trigger", event: "lead.created" },
        { id: "a1", type: "analyze", prompt: "Summarise.", input: "{{contact.first_name}}", into: "sum", format: "text", model: "claude-sonnet-5-5", max_tokens: 16000 },
        { id: "n1", type: "note", template: "Call: {{vars.sum}} for {{event.part}}", key: "review:{{contact.id}}" },
        { id: "x1", type: "exit", reason: "done" }],
        edges: [{ from: "t1", to: "a1" }, { from: "a1", to: "n1" }, { from: "n1", to: "x1" }] });
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Keyed note','always',true) returning id", [nco]))!;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'d267 test')", [wf.id, def, extractManifest(def)]);
      await syncTriggers(c, nco, wf.id, def);
    });
  });
  const fire = (part: string) => asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: nco, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "engine", data: { part } }), { contact: { id: ct } }));

  it("the first run writes the note and the second rewrites that same note; the analyze step asks the model it names", async () => {
    await fire("part 1"); await tick(fake, undefined, nco);
    await fire("part 2"); await tick(fake, undefined, nco);
    expect(notes).toEqual([{ op: "add", body: "Call: summary for part 1" }, { op: "update", id: "note-1", body: "Call: summary for part 2" }]);
    expect(asked).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
  });
});
