/** The recordings ledger: who was on the call held to when it was (D227: speakers, then the invite: email, name, meeting link; never the calendar alone), ambiguity, idempotency, parsers, signature, JSON repair, the lines filter. */
import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { meetingKey, nameAgrees, recordRecording, rematchRecordings, resolveRecording, type RecordingInput } from "./recordings";
import { applyAppointment } from "./poll";
import type { CompanyRow } from "./context";
import type { Adapters, Company } from "@/adapters/types";
import { mapEvent, type RawEvent, type RawInvitee } from "@/adapters/calendly/read";
import { mapAppt } from "@/adapters/ghl/read";
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
      if (co) { for (const t of ["audit_log", "events", "sends", "recordings", "appointments", "calendars", "opportunities", "contact_identifiers", "contacts", "users", "company_terms"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
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
    const annAt = await asOperator(async (c) => (await one<{ id: string }>(c, "select id from appointments where company_id=$1 and external_id='A-ANN'", [companyId]))!.id);
    expect(r.match).toEqual({ contactId: ann, by: "email", appointmentId: annAt });
  });
  it("name matches only when exactly one contact has it", async () => {
    const one_ = await asOperator((c) => resolveRecording(c, companyId, rec("r2", { invitees: [{ name: "Ann  Lee", email: "personal@gmail.com" }] })));
    expect(one_.match).toMatchObject({ contactId: ann, by: "name" });
    const two = await asOperator((c) => resolveRecording(c, companyId, rec("r3", { invitees: [{ name: "Bob Ray", email: "bobs-other@gmail.com" }] })));
    expect(two.match).toBeNull(); expect(two.reason).toMatch(/"bob ray" is the name of 2 contacts/);
  });
  it("D227: the closer's calendar alone never links: someone on the call must be the booked person", async () => {
    const r = await asOperator((c) => resolveRecording(c, companyId, rec("r4", { startedAt: new Date(at.getTime() + 5 * 60e3), invitees: [{ name: "Guest", email: "guest@phone.com" }] })));
    expect(r.match).toBeNull(); expect(r.reason).toMatch(/nobody in the CRM matches guest@phone.com, Guest, and no transcript says who joined; the recorder's booking then is Ann Lee \(booked .*\), but no one on the call is shown to be them/);
    const far = await asOperator((c) => resolveRecording(c, companyId, rec("r5", { startedAt: new Date(at.getTime() + 5 * 3600e3), invitees: [{ name: "Guest", email: "guest@phone.com" }] })));
    expect(far.match).toBeNull(); expect(far.reason).toMatch(/nobody in the CRM matches guest@phone.com/);
  });
  it("D227: back-to-back calls: whoever spoke picks their own booking, however close the next one is; the calendar alone picks none", async () => {
    const add = (contact: string, ext: string, startsAt: Date) => asOperator(async (c) => { const cal = (await one<{ id: string }>(c, "select id from calendars where company_id=$1 limit 1", [companyId]))!.id;
      return (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status) values ($1,$2,'ghl',$3,$4,$5,$6,$7,$7,now(),'confirmed') returning id", [companyId, contact, ext, cal, term, closer, startsAt]))!.id; });
    const base = new Date(at.getTime() + 24 * 3600e3);
    const ten = await add(ann, "BB-1", base); await add(bob, "BB-2", new Date(base.getTime() + 60 * 60e3)); await add(bob, "BB-4", new Date(base.getTime() + 10 * 60e3));
    const spoken = [{ speaker: "Cal Closer", text: "hi" }, { speaker: "Ann Lee", text: "hello" }];
    expect((await asOperator((c) => resolveRecording(c, companyId, rec("r6", { startedAt: new Date(base.getTime() + 60e3), transcript: spoken })))).match).toEqual({ contactId: ann, by: "speaker", appointmentId: ten });
    expect((await asOperator((c) => resolveRecording(c, companyId, rec("r7", { startedAt: new Date(base.getTime() + 60e3), invitees: [{ name: "Guest", email: "guest@phone.com" }] })))).match).toBeNull();
  });
  it("two different contacts on one recording is ambiguous unless exactly one of them is booked then (D215); all-staff is named as such", async () => {
    const amb = await asOperator((c) => resolveRecording(c, companyId, rec("r6", { startedAt: new Date("2020-01-01T00:00:00Z"), invitees: [{ email: "ann@x.com" }, { email: "bob@x.com" }] })));
    expect(amb.match).toBeNull(); expect(amb.reason).toMatch(/the invite names 2 different contacts and none has a booking then/);
    // Ann is booked at `at`, Bob is not: the call is Ann's booking
    const booked = await asOperator((c) => resolveRecording(c, companyId, rec("r6b", { startedAt: new Date(at.getTime() - 60e3), invitees: [{ email: "bob@x.com" }, { email: "ann@x.com" }] })));
    const annAt = await asOperator(async (c) => (await one<{ id: string }>(c, "select id from appointments where company_id=$1 and external_id='A-ANN'", [companyId]))!.id);
    expect(booked.match).toEqual({ contactId: ann, by: "email", appointmentId: annAt });
    const staff = await asOperator((c) => resolveRecording(c, companyId, rec("r7", { startedAt: new Date("2020-01-01T00:00:00Z"), invitees: [{ email: "closer@co.com" }] })));
    expect(staff.reason).toMatch(/only the team was invited \(closer@co.com\), and no transcript says who joined/);
  });
  it("an unlinked recording is tried again: a dry run says what would link, the write links it silently and keeps the rest with their reason (D215)", async () => {
    const t0 = new Date("2026-11-03T15:00:00Z");
    const ids = await asOperator(async (c) => {
      const cal = (await one<{ id: string }>(c, "select id from calendars where company_id=$1 limit 1", [companyId]))!.id;
      const appt = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status) values ($1,$2,'ghl','RM-ANN',$3,$4,$5,$6,$6,now(),'confirmed') returning id", [companyId, ann, cal, term, closer, t0]))!.id;
      const add = async (ext: string, startedAt: Date) => (await one<{ id: string }>(c, "insert into recordings (company_id, provider, external_id, started_at, recorded_by_email, invitees, link_status, unlinked_reason) values ($1,'fathom',$2,$3,'closer@co.com',$4,'unlinked','attendees match 2 different contacts') returning id",
        [companyId, ext, startedAt, JSON.stringify([{ email: "ann@x.com", isExternal: true }, { email: "bob@x.com", isExternal: true }, { email: "closer@co.com", isExternal: false }])]))!.id;
      return { appt, hit: await add("RM-1", new Date(t0.getTime() + 30e3)), miss: await add("RM-2", new Date(t0.getTime() + 9 * 3600e3)) };
    });
    const window = { from: new Date(t0.getTime() - 3600e3), to: new Date(t0.getTime() + 12 * 3600e3) };
    const dry = await asOperator((c) => rematchRecordings(c, companyId, { ...window, dryRun: true }));
    expect(dry.linked).toEqual([expect.objectContaining({ id: ids.hit, contact_id: ann, appointment_id: ids.appt, by: "email" })]);
    expect(dry.still).toEqual([expect.objectContaining({ id: ids.miss, reason: expect.stringMatching(/none has a booking then/) })]);
    expect(await asOperator((c) => one<{ link_status: string }>(c, "select link_status from recordings where id=$1", [ids.hit]))).toEqual({ link_status: "unlinked" });
    const events = async () => (await asOperator((c) => one<{ n: number }>(c, "select count(*)::int as n from events where company_id=$1", [companyId])))!.n;
    const before = await events();
    await asOperator((c) => rematchRecordings(c, companyId, { ...window, dryRun: false }));
    expect(await asOperator((c) => one(c, "select link_status, contact_id, appointment_id, linked_by from recordings where id=$1", [ids.hit]))).toEqual({ link_status: "linked", contact_id: ann, appointment_id: ids.appt, linked_by: "email" });
    expect(await asOperator((c) => one(c, "select link_status, unlinked_reason from recordings where id=$1", [ids.miss]))).toMatchObject({ link_status: "unlinked", unlinked_reason: expect.stringMatching(/none has a booking then/) });
    expect(await events()).toBe(before);   // silent: nothing starts
    await asOperator(async (c) => { await c.query("delete from recordings where id = any($1::uuid[])", [[ids.hit, ids.miss]]); await c.query("delete from appointments where id=$1", [ids.appt]); });
  });
  it("records once: a linked row with event + appointment, a duplicate on replay, an unlinked row with its reason and a contact-less event", async () => {
    const r = await asOperator((c) => recordRecording(c, companyId, rec("f-1", { title: "Ann x Cal", invitees: [{ email: "ann@x.com", name: "Ann Lee", isExternal: true }], transcript: [{ speaker: "Ann", text: "hi" }] })));
    expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
    expect(r.recording).toMatchObject({ contact_id: ann, link_status: "linked", linked_by: "speaker" }); expect(r.appointmentId).toBeTruthy();
    expect(r.event).toMatchObject({ event_type: "recording.received", contact_id: ann, source: "fathom" }); expect(r.event.data).toMatchObject({ appointment_matched: true, matched_by: "speaker", title: "Ann x Cal" });
    expect((await asOperator((c) => recordRecording(c, companyId, rec("f-1")))).outcome).toBe("duplicate");
    const u = await asOperator((c) => recordRecording(c, companyId, rec("f-2", { startedAt: new Date("2020-01-01T00:00:00Z"), invitees: [{ email: "who@where.com" }] })));
    expect(u.outcome).toBe("unlinked"); if (u.outcome !== "unlinked") return;
    expect(u.recording.unlinked_reason).toMatch(/who@where.com/); expect(u.event.contact_id).toBeNull(); expect(u.event.event_type).toBe("recording.unlinked");
    expect(await asOperator((c) => many(c, "select 1 from recordings where company_id=$1 and link_status='unlinked'", [companyId]))).toHaveLength(1);
  });

  // D102: the meeting link. Each case sits days away from the others so the closer's calendar of one never sees another's bookings
  const book = (contact: string, ext: string, startsAt: Date, meetingKey: string | null, assigned: string | null = closer, status = "confirmed") => asOperator(async (c) => {
    const cal = (await one<{ id: string }>(c, "select id from calendars where company_id=$1 and source='ghl' limit 1", [companyId]))!.id;
    return (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status, meeting_key) values ($1,$2,'ghl',$3,$4,$5,$6,$7,$7,now(),$8,$9) returning id", [companyId, contact, ext, cal, term, assigned, startsAt, status, meetingKey]))!.id; });
  const person = (first: string) => asOperator(async (c) => (await one<{ id: string }>(c, "insert into contacts (company_id, first_name, last_name) values ($1,$2,'Mtg') returning id", [companyId, first]))!.id);
  const day = (n: number) => new Date(at.getTime() + n * 24 * 3600e3);

  it("no attendee but the closer, two calls 30 minutes apart: the recording's Zoom link names the second (D102)", async () => {
    const first = await person("Pia"), second = await person("Quinn");
    await book(first, "MT-1", day(3), "82995720001");
    const want = await book(second, "MT-2", new Date(day(3).getTime() + 30 * 60e3), "82995723390");
    const input = rec("m-1", { startedAt: new Date(day(3).getTime() + 28 * 60e3), meetingUrl: "https://us06web.zoom.us/j/82995723390?pwd=Zk9xYzRrbWxLQT09", invitees: [{ name: "Cal Closer", email: "closer@co.com", isExternal: false }] });
    expect((await asOperator((c) => resolveRecording(c, companyId, { ...input, meetingUrl: undefined }))).match).toBeNull();   // the calendar alone cannot tell them apart
    const r = await asOperator((c) => recordRecording(c, companyId, input));
    expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
    expect(r.recording).toMatchObject({ contact_id: second, appointment_id: want, linked_by: "meeting" });
    expect(r.event.data).toMatchObject({ matched_by: "meeting", appointment_matched: true });
  });
  it("one meeting link on two bookings (a personal meeting room) is no answer; nor is the calendar alone (D102, D227)", async () => {
    const a = await person("Rae"), b = await person("Sol");
    await book(a, "MT-3", day(5), "5551234567");
    await book(b, "MT-4", new Date(day(5).getTime() + 3 * 3600e3), "5551234567");
    const r = await asOperator((c) => resolveRecording(c, companyId, rec("m-2", { startedAt: new Date(day(5).getTime() + 2 * 60e3), meetingUrl: "https://zoom.us/j/5551234567" })));
    expect(r.match).toBeNull(); expect(r.reason).toMatch(/the recorder's booking then is Rae Mtg .*its meeting link is on 2 bookings/);
    const none = await asOperator((c) => resolveRecording(c, companyId, rec("m-3", { startedAt: new Date(day(5).getTime() + 2 * 60e3), recordedBy: { email: "someone@else.com" }, meetingUrl: "https://zoom.us/j/5551234567" })));
    expect(none.match).toBeNull(); expect(none.reason).toMatch(/its meeting link is on 2 bookings/);
  });
  it("an email hit takes that contact's booking with the recording's meeting link, not merely the nearest (D102)", async () => {
    const near = await book(ann, "MT-5", day(7), null, null);
    const keyed = await book(ann, "MT-6", new Date(day(7).getTime() + 2 * 3600e3), "abc-defg-hij", null);
    const input = rec("m-4", { startedAt: new Date(day(7).getTime() + 60e3), invitees: [{ email: "ann@x.com" }], meetingUrl: "https://meet.google.com/abc-defg-hij?authuser=0" });
    expect((await asOperator((c) => resolveRecording(c, companyId, input))).match).toEqual({ contactId: ann, by: "email", appointmentId: keyed });
    expect((await asOperator((c) => resolveRecording(c, companyId, { ...input, meetingUrl: undefined }))).match).toEqual({ contactId: ann, by: "email", appointmentId: near });
  });
  it("an impromptu meeting after the booked link failed: Dan speaking on it makes it his booking; no one named on it, it is a person's call (D102, D227)", async () => {
    const dan = await person("Dan");
    const booked = await book(dan, "MT-7", day(9), "82990000001");
    const input = rec("m-5", { title: "Impromptu Zoom Meeting", startedAt: new Date(day(9).getTime() + 4 * 60e3), meetingUrl: "https://us06web.zoom.us/j/7712345678?pwd=abc" });
    expect((await asOperator((c) => resolveRecording(c, companyId, input))).match).toBeNull();
    const r = await asOperator((c) => resolveRecording(c, companyId, { ...input, transcript: [{ speaker: "Cal Closer", text: "can you hear me" }, { speaker: "Dan Mtg", text: "yes" }] }));
    expect(r.match).toEqual({ contactId: dan, by: "speaker", appointmentId: booked });
  });
  it("a cancelled booking's link, or a booking far from the recording, says nothing (D102)", async () => {
    const eve = await person("Eve");
    await book(eve, "MT-8", day(11), "82990000002", null, "cancelled");
    await book(eve, "MT-9", day(14), "82990000003", null);
    for (const id of ["82990000002", "82990000003"]) expect((await asOperator((c) => resolveRecording(c, companyId, rec(`m-${id}`, { startedAt: day(11), recordedBy: { email: "someone@else.com" }, meetingUrl: `https://zoom.us/j/${id}` })))).match).toBeNull();
  });

  // D227, the calls of 2026-10-22: Beth Huffman's consultation carried Corina Raducanu's invite; a roleplay; Audra's coaching call
  it("D227: the invite names one person, the one who spoke is the person booked then: the call is theirs; with no transcript, a person's call", async () => {
    const corina = await person("Corina"), beth = (await asOperator((c) => one<{ id: string }>(c, "insert into contacts (company_id, first_name, last_name) values ($1,'Beth','Huffman') returning id", [companyId])))!.id;
    await asOperator((c) => c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','corina@x.com'),($1,$3,'email','elizabethahuffman@gmail.com')", [companyId, corina, beth]));
    const t = day(30);
    const cal = await asOperator(async (c) => (await one<{ id: string }>(c, "select id from calendars where company_id=$1 and source='ghl' limit 1", [companyId]))!.id);
    const slot = (who: string, ext: string, from: Date, min: number) => asOperator(async (c) => (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status) values ($1,$2,'ghl',$3,$4,$5,$6,$7,$8,now(),'confirmed') returning id", [companyId, who, ext, cal, term, closer, from, new Date(from.getTime() + min * 60e3)]))!.id);
    await slot(corina, "CR-1", t, 15);
    const bethAt = await slot(beth, "BH-1", new Date(t.getTime() + 60 * 60e3), 60);
    const call = rec("cb-1", { title: "Corina Mtg and Cal Closer", startedAt: new Date(t.getTime() + 64 * 60e3), invitees: [{ name: "corina@x.com", email: "corina@x.com", isExternal: true }, { name: "Cal", email: "closer@co.com", isExternal: false }] });
    expect(await asOperator((c) => resolveRecording(c, companyId, { ...call, transcript: [{ speaker: "Cal", email: "closer@co.com", text: "hi" }, { speaker: "Elizabeth Huffman", text: "hi" }] }))).toEqual({ match: { contactId: beth, by: "speaker", appointmentId: bethAt } });
    const blind = await asOperator((c) => resolveRecording(c, companyId, call));
    expect(blind.match).toBeNull(); expect(blind.reason).toMatch(/the invite names Corina Mtg, booked .*, which this recording \(.*\) does not fit; the booking then is Beth Huffman \(booked/);
    // the invite's person speaking when the time is someone else's: never guessed
    const wrong = await asOperator((c) => resolveRecording(c, companyId, { ...call, transcript: [{ speaker: "Corina Mtg", text: "hi" }] }));
    expect(wrong.match).toBeNull(); expect(wrong.reason).toMatch(/Corina Mtg spoke, but the booking the recorder had then is Beth Huffman/);
  });
  it("D227: a call only the team spoke on is internal: linked to no one, and no one is asked", async () => {
    const before = (await asOperator((c) => many(c, "select 1 from events where company_id=$1", [companyId]))).length;
    const r = await asOperator((c) => recordRecording(c, companyId, rec("rp-1", { title: "Roleplay/training", startedAt: new Date(at.getTime() - 50 * 60e3), invitees: [{ name: "Mitch Sapoff", email: "mitch@co.com", isExternal: true }, { name: "Cal", email: "closer@co.com", isExternal: false }],
      transcript: [{ speaker: "Cal", email: "closer@co.com", text: "you be the client" }, { speaker: "Cal Closer", text: "ok" }] })));
    expect(r).toMatchObject({ outcome: "internal", reason: expect.stringMatching(/only the team spoke \(Cal, Cal Closer\)/), recording: { link_status: "unlinked", contact_id: null } });
    expect((await asOperator((c) => many(c, "select 1 from events where company_id=$1", [companyId]))).length).toBe(before);
    // a teammate the roster does not hold is not the team: a stranger who speaks is a guest the team is asked about
    const odd = await asOperator((c) => resolveRecording(c, companyId, rec("rp-2", { startedAt: day(40), transcript: [{ speaker: "Cal Closer", text: "hi" }, { speaker: "Mitch Sapoff", text: "hi" }] })));
    expect(odd).toMatchObject({ match: null, reason: expect.stringMatching(/Mitch Sapoff spoke, and nobody in the CRM has that name/) });
  });
  it("D227: a client who speaks on an unbooked call is linked to them with no booking; the booking then being someone else's stops it", async () => {
    const audra = await person("Audra");
    const t = day(50);
    expect(await asOperator((c) => resolveRecording(c, companyId, rec("au-1", { title: "Impromptu Google Meet Meeting", startedAt: t, invitees: [{ name: "Cal", email: "closer@co.com", isExternal: false }], transcript: [{ speaker: "Audra Mtg", text: "hi" }, { speaker: "Cal", text: "hi" }] })))).toEqual({ match: { contactId: audra, by: "speaker" } });
    const other = await person("Otto"); await book(other, "AU-X", t, null);
    const r = await asOperator((c) => resolveRecording(c, companyId, rec("au-2", { startedAt: t, transcript: [{ speaker: "Audra Mtg", text: "hi" }] })));
    expect(r.match).toBeNull(); expect(r.reason).toMatch(/Audra Mtg spoke, but the booking the recorder had then is Otto Mtg/);
  });

  const co = () => asOperator((c) => one<CompanyRow>(c, "select * from companies where id=$1", [companyId])).then((r) => r!);
  const noReads = { read: { getContact: async () => null } } as unknown as Adapters;
  const keyOf = (ext: string) => asOperator((c) => one<{ meeting_key: string | null }>(c, "select meeting_key from appointments where company_id=$1 and external_id=$2", [companyId, ext])).then((r) => r?.meeting_key);
  it("a Calendly booking keeps its location's join link as the meeting key; a new link replaces it without an event (D102)", async () => {
    await asOperator((c) => c.query("insert into calendars (company_id, source, external_id, name, appointment_term) values ($1,'calendly','ET-Z','Strategy',$2)", [companyId, term]));
    const ac: Company = { id: companyId, locationId: "L", pit: "p", timezone: "America/New_York", booking: { source: "calendly", token: "t", organization: "o" } };
    const raw = (joinUrl: string): RawEvent => ({ uri: "https://api.calendly.com/scheduled_events/EV-Z", name: "Strategy", status: "active", start_time: day(20).toISOString(), end_time: day(20).toISOString(), event_type: "https://api.calendly.com/event_types/ET-Z", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", event_memberships: [], invitees_counter: { total: 1, active: 1 }, location: { type: "zoom", join_url: joinUrl } });
    const inv = { uri: "https://api.calendly.com/scheduled_events/EV-Z/invitees/I1", email: "zed@x.com", name: "Zed Mtg", status: "active", rescheduled: false, updated_at: "2026-10-01T00:00:00Z" } as RawInvitee;
    const row = await co();
    await asOperator((c) => applyAppointment(c, row, ac, noReads, mapEvent(raw("https://us06web.zoom.us/j/82995723390?pwd=abc"), inv), undefined, true));
    expect(await keyOf("EV-Z")).toBe("82995723390");
    const before = (await asOperator((c) => many(c, "select 1 from events where company_id=$1", [companyId]))).length;
    await asOperator((c) => applyAppointment(c, row, ac, noReads, mapEvent(raw("https://us06web.zoom.us/j/84400000001?pwd=def"), inv)));
    expect(await keyOf("EV-Z")).toBe("84400000001");
    expect(await asOperator((c) => many(c, "select 1 from events where company_id=$1", [companyId]))).toHaveLength(before);
  });
  it("a GHL appointment whose address is a link keeps it as the meeting key; a street address is no key (D102)", async () => {
    const ac: Company = { id: companyId, locationId: "L", pit: "p", timezone: "America/New_York", booking: { source: "ghl" } };
    const ghlAppt = (id: string, address: string) => mapAppt({ id, calendarId: "CAL", contactId: "GB", startTime: day(22).toISOString(), endTime: day(22).toISOString(), appointmentStatus: "confirmed", address });
    const row = await co();
    await asOperator((c) => applyAppointment(c, row, ac, noReads, ghlAppt("G-Z1", "https://meet.google.com/xyz-abcd-efg"), undefined, true));
    await asOperator((c) => applyAppointment(c, row, ac, noReads, ghlAppt("G-Z2", "12 Main St, Hartford"), undefined, true));
    expect(await keyOf("G-Z1")).toBe("xyz-abcd-efg");
    expect(await keyOf("G-Z2")).toBeNull();
  });
});

describe("a spoken name and a booked person (D227)", () => {
  it("the same surname with a first name that is theirs, holds theirs, or is in their email; a first name alone must be theirs", () => {
    expect(nameAgrees("Elizabeth Huffman", "Beth", "Huffman")).toBe(true);
    expect(nameAgrees("Liz Huffman", "Beth", "Huffman", ["elizabethahuffman@gmail.com"])).toBe(true);
    expect(nameAgrees("Liz Huffman", "Beth", "Huffman")).toBe(false);
    expect(nameAgrees("Huff Huffman", "Beth", "Huffman", ["huff.b@x.com"])).toBe(true);
    expect(nameAgrees("Beth Tracy", "Beth", "Huffman")).toBe(false);
    expect(nameAgrees("Corina Raducanu", "Beth", "Huffman")).toBe(false);
    expect(nameAgrees("Beth", "Beth", "Huffman")).toBe(true);
    expect(nameAgrees("Eli", "Beth", "Huffman")).toBe(false);
  });
});

describe("meeting key", () => {
  it("one key per meeting whichever side reports the link (D102)", () => {
    expect(meetingKey("https://us06web.zoom.us/j/82995723390?pwd=Zk9xYzRrbWxLQT09")).toBe("82995723390");
    expect(meetingKey("https://zoom.us/j/82995723390")).toBe("82995723390");
    expect(meetingKey("https://us02web.zoom.us/wc/join/82995723390")).toBe("82995723390");
    expect(meetingKey("https://meet.google.com/ABC-defg-hij?authuser=1")).toBe("abc-defg-hij");
    expect(meetingKey("https://teams.microsoft.com/l/meetup-join/19%3ameeting_X/0?context=%7b%7d")).toBe("teams.microsoft.com/l/meetup-join/19%3ameeting_X/0");
    expect(meetingKey("https://zoom.us/my/carly.room?pwd=1")).toBe("zoom.us/my/carly.room");
    for (const notALink of [undefined, null, "", "12 Main St, Hartford", "+1 860 555 1234", "zoom"]) expect(meetingKey(notALink)).toBeUndefined();
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
  it("keeps the call's own join link for the meeting-link rung (D102)", () => {
    const p = parseFathomMeeting({ ...meeting, meeting_url: "https://us06web.zoom.us/j/82995723390?pwd=abc" }); expect(p.ok).toBe(true); if (!p.ok) return;
    expect(p.input.meetingUrl).toBe("https://us06web.zoom.us/j/82995723390?pwd=abc");
    const z = parseZapierRecording({ recording_id: "9", started_at: "2026-10-07T17:00:00Z", meeting_url: "https://zoom.us/j/1234567890" }); expect(z.ok && z.input.meetingUrl).toBe("https://zoom.us/j/1234567890");
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
