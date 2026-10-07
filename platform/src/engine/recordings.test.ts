/** The recordings ledger: match ladder (email → name → closer's calendar), ambiguity, idempotency, parsers, signature, JSON repair, the lines filter. */
import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { recordRecording, resolveRecording, type RecordingInput } from "./recordings";
import { verifyStandardWebhook } from "./webhooks/standard";
import { parseFathomMeeting } from "./webhooks/fathom";
import { parseZapierRecording } from "./webhooks/zapier";
import { parseJsonAnswer } from "@/adapters/anthropic/analyst";
import { render, renderLines } from "./template";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string, ann: string, bob: string, closer: string, term: string;
const at = new Date("2026-10-07T17:00:00Z");
const rec = (id: string, over: Partial<RecordingInput> = {}): RecordingInput => ({ externalId: id, startedAt: at, invitees: [], recordedBy: { email: "closer@co.com" }, ...over });

describe.skipIf(!process.env.DATABASE_URL)("recordings ledger", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='recs'");
      if (co) { for (const t of ["events", "sends", "recordings", "appointments", "calendars", "opportunities", "contact_identifiers", "contacts", "users", "company_terms"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('Recs','recs','America/New_York') returning id"))!.id;
      await c.query(`insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories`, [companyId]);
      term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      closer = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'closer@co.com','Cal Closer','closer','U9') returning id", [companyId]))!.id;
      ann = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'GA','Ann','Lee') returning id", [companyId]))!.id;
      bob = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'GB','Bob','Ray') returning id", [companyId]))!.id;
      await c.query("insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'GB2','Bob','Ray')", [companyId]);   // a second Bob Ray: name alone must not pick one
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','ann@x.com'),($1,$3,'email','bob@x.com')", [companyId, ann, bob]);
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, source, external_id, name, appointment_term) values ($1,'ghl','CAL','Closer','"+term+"') returning id", [companyId]))!.id;
      await c.query("insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status) values ($1,$2,'ghl','A-ANN',$3,$4,$5,$6,$6,now(),'confirmed')", [companyId, ann, cal, term, closer, at]);
    });
  });

  it("the closer is staff even when the roster did not list them; an invitee email that is a known contact matches", async () => {
    const r = await asOperator((c) => resolveRecording(c, companyId, rec("r1", { invitees: [{ email: "closer@co.com", name: "Cal Closer" }, { email: "ANN@x.com", name: "Ann Lee" }] })));
    expect(r.match).toEqual({ contactId: ann, by: "email" });
  });
  it("name matches only when exactly one contact has it", async () => {
    const one_ = await asOperator((c) => resolveRecording(c, companyId, rec("r2", { invitees: [{ name: "Ann  Lee", email: "personal@gmail.com" }] })));
    expect(one_.match).toMatchObject({ contactId: ann, by: "name" });
    const two = await asOperator((c) => resolveRecording(c, companyId, rec("r3", { invitees: [{ name: "Bob Ray", email: "bobs-other@gmail.com" }] })));
    expect(two.match).toBeNull(); expect(two.reason).toMatch(/"bob ray" is the name of 2 contacts/);
  });
  it("the closer's calendar: one appointment within two hours of the recording start resolves the person and the appointment", async () => {
    const r = await asOperator((c) => resolveRecording(c, companyId, rec("r4", { startedAt: new Date(at.getTime() + 25 * 60e3), invitees: [{ name: "Guest", email: "guest@phone.com" }] })));
    expect(r.match).toMatchObject({ contactId: ann, by: "calendar" }); expect(r.match?.appointmentId).toBeTruthy();
    const far = await asOperator((c) => resolveRecording(c, companyId, rec("r5", { startedAt: new Date(at.getTime() + 5 * 3600e3), invitees: [{ name: "Guest", email: "guest@phone.com" }] })));
    expect(far.match).toBeNull(); expect(far.reason).toMatch(/nobody in the CRM matches guest@phone.com.*no appointment on the closer's calendar/);
  });
  it("two different contacts on one recording is ambiguous, not a guess; all-staff is named as such", async () => {
    const amb = await asOperator((c) => resolveRecording(c, companyId, rec("r6", { invitees: [{ email: "ann@x.com" }, { email: "bob@x.com" }] })));
    expect(amb.match).toBeNull(); expect(amb.reason).toMatch(/2 different contacts/);
    const staff = await asOperator((c) => resolveRecording(c, companyId, rec("r7", { startedAt: new Date("2020-01-01T00:00:00Z"), invitees: [{ email: "closer@co.com" }] })));
    expect(staff.reason).toMatch(/every attendee is staff/);
  });
  it("records once: a linked row with event + appointment, a duplicate on replay, an unlinked row with its reason and a contact-less event", async () => {
    const r = await asOperator((c) => recordRecording(c, companyId, rec("f-1", { title: "Ann x Cal", invitees: [{ email: "ann@x.com", name: "Ann Lee", isExternal: true }], transcript: [{ speaker: "Ann", text: "hi" }] })));
    expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
    expect(r.recording).toMatchObject({ contact_id: ann, link_status: "linked", linked_by: "email" }); expect(r.appointmentId).toBeTruthy();
    expect(r.event).toMatchObject({ event_type: "recording.received", contact_id: ann, source: "fathom" }); expect(r.event.data).toMatchObject({ appointment_matched: true, matched_by: "email", title: "Ann x Cal" });
    expect((await asOperator((c) => recordRecording(c, companyId, rec("f-1")))).outcome).toBe("duplicate");
    const u = await asOperator((c) => recordRecording(c, companyId, rec("f-2", { startedAt: new Date("2020-01-01T00:00:00Z"), invitees: [{ email: "who@where.com" }] })));
    expect(u.outcome).toBe("unlinked"); if (u.outcome !== "unlinked") return;
    expect(u.recording.unlinked_reason).toMatch(/who@where.com/); expect(u.event.contact_id).toBeNull(); expect(u.event.event_type).toBe("recording.unlinked");
    expect(await asOperator((c) => many(c, "select 1 from recordings where company_id=$1 and link_status='unlinked'", [companyId]))).toHaveLength(1);
  });
});

describe("Fathom payload", () => {
  const meeting = { recording_id: 12345, title: "Ann Lee <> Cal", meeting_title: "Hair consult", url: "https://fathom.video/calls/12345", share_url: "https://fathom.video/share/x", recording_start_time: "2026-10-07T17:01:00Z", recording_end_time: "2026-10-07T17:44:30Z", scheduled_start_time: "2026-10-07T17:00:00Z",
    calendar_invitees: [{ name: "Cal Closer", email: "Closer@co.com", is_external: false }, { name: "Ann Lee", email: "ann@x.com", is_external: true }], recorded_by: { name: "Cal Closer", email: "closer@co.com", team: "Sales" },
    transcript: [{ speaker: { display_name: "Ann Lee", matched_calendar_invitee_email: "ann@x.com" }, text: "I just want it to stop.", timestamp: "00:01:10" }], default_summary: { template_name: "General", markdown_formatted: "## Summary\nAnn wants…" } };
  it("maps the meeting object; the recording start wins over the scheduled start; duration is derived", () => {
    const p = parseFathomMeeting(meeting); expect(p.ok).toBe(true); if (!p.ok) return;
    expect(p.input).toMatchObject({ provider: "fathom", externalId: "12345", title: "Hair consult", shareUrl: "https://fathom.video/share/x", durationMin: 44, recordedBy: { email: "closer@co.com" }, summary: "## Summary\nAnn wants…" });
    expect(p.input.startedAt.toISOString()).toBe("2026-10-07T17:01:00.000Z");
    expect(p.input.invitees).toEqual([{ name: "Cal Closer", email: "closer@co.com", isExternal: false }, { name: "Ann Lee", email: "ann@x.com", isExternal: true }]);
    expect(p.input.transcript).toEqual([{ speaker: "Ann Lee", email: "ann@x.com", text: "I just want it to stop.", timestamp: "00:01:10" }]);
  });
  it("rejects a body without an id or a start", () => {
    expect(parseFathomMeeting({ title: "x" })).toMatchObject({ ok: false, why: /recording_id/ });
    expect(parseFathomMeeting({ recording_id: 1 })).toMatchObject({ ok: false, why: /start time/ });
  });
  it("Standard Webhooks: whsec_ secrets verify base64-decoded, like Fathom's SDK does", () => {
    const secret = `whsec_${Buffer.from("topsecretkey").toString("base64")}`;
    const raw = JSON.stringify(meeting), ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", Buffer.from("topsecretkey")).update(`msg_1.${ts}.${raw}`).digest("base64");
    expect(verifyStandardWebhook(secret, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, raw)).toEqual({ ok: true });
    expect(verifyStandardWebhook(secret, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, raw + " ")).toMatchObject({ ok: false });
  });
});

describe("Zapier recording body", () => {
  it("reads Zapier's flattened shapes: a name <email> list, a transcript as text, duration in seconds", () => {
    const p = parseZapierRecording({ recording_id: "991", title: "Consult", started_at: "2026-10-07T17:00:00Z", duration_seconds: "2590.4", share_url: "https://fathom.video/share/y", recorded_by_email: "closer@co.com",
      invitees: "Cal Closer <closer@co.com>, Ann Lee <ann@x.com>, bob@x.com", transcript: "[00:00:05] Cal Closer: Thanks for joining.\nAnn Lee: Happy to be here." });
    expect(p.ok).toBe(true); if (!p.ok) return;
    expect(p.input.durationMin).toBe(43);
    expect(p.input.invitees).toEqual([{ name: "Cal Closer", email: "closer@co.com" }, { name: "Ann Lee", email: "ann@x.com" }, { name: undefined, email: "bob@x.com" }]);
    expect(p.input.transcript).toEqual([{ speaker: "Cal Closer", text: "Thanks for joining.", timestamp: "00:00:05" }, { speaker: "Ann Lee", text: "Happy to be here.", timestamp: undefined }]);
    expect(p.input.recordedBy).toEqual({ email: "closer@co.com", name: undefined });
  });
  it("accepts Fathom's own arrays passed straight through, and refuses a body without an id or a date", () => {
    const p = parseZapierRecording({ id: 7, recording_start_time: "1759856400", calendar_invitees: [{ name: "Ann", email: "ANN@x.com", is_external: true }], recorded_by: { name: "Cal", email: "Closer@co.com" }, transcript: [{ speaker: { display_name: "Ann" }, text: "hi", timestamp: "00:00:01" }] });
    expect(p.ok).toBe(true); if (!p.ok) return;
    expect(p.input.startedAt.toISOString()).toBe("2025-10-07T17:00:00.000Z"); expect(p.input.invitees).toEqual([{ name: "Ann", email: "ann@x.com", isExternal: true }]); expect(p.input.recordedBy).toEqual({ name: "Cal", email: "closer@co.com" });
    expect(parseZapierRecording({ title: "x", started_at: "2026-01-01" })).toMatchObject({ ok: false, why: /recording_id/ });
    expect(parseZapierRecording({ recording_id: "1", started_at: "yesterday" })).toMatchObject({ ok: false, why: /started_at/ });
  });
});

describe("analysis answers", () => {
  it("parses fenced and prefaced JSON, mends a cut-off answer, reports what cannot be read", () => {
    expect(parseJsonAnswer('```json\n{"a":1}\n```').parsed).toEqual({ a: 1 });
    expect(parseJsonAnswer('Here you go: {"a":[1,2]} hope this helps').parsed).toEqual({ a: [1, 2] });
    const cut = parseJsonAnswer('{"summary":"done","pain":["x","y"],"objections":[{"objection":"price","quote":"too mu');
    expect(cut.repaired).toBe(true); expect(cut.parsed).toEqual({ summary: "done", pain: ["x", "y"], objections: [{ objection: "price" }] });
    expect(parseJsonAnswer("no json here")).toMatchObject({ parseError: expect.any(String) });
  });
  it("the lines filter turns an analysis object into Slack text without knowing its shape", () => {
    const text = renderLines({ summary: "Wants to start.", pain: ["thinning", "confidence"], objections: [{ objection: "price", quote: "a lot right now", handled: true }], disposition: "closed_won", empty: "", quotes: ["I just want it to stop"] });
    expect(text).toBe("*Summary:* Wants to start.\n*Pain:* thinning, confidence\n*Objections:*\n• *price*\n    > _\"a lot right now\"_\n    *Handled:* Yes\n*Disposition:* closed_won\n*Quotes:*\n> _\"I just want it to stop\"_");
    expect(render("{{vars.n | lines}} / {{vars.n.disposition}} / {{vars.x | default:?}}", { vars: { n: { disposition: "lost" } } }, { tz: "UTC" })).toBe("*Disposition:* lost / lost / ?");
  });
});
