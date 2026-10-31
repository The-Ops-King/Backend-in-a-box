import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { dispatchEvent, emitEvent, type EventRow } from "./dispatch";
import { normEmail } from "./identity";
import { raise } from "./alerts";
import { standsSql } from "./held";

/**
 * Call recordings (D22). Same shape as the payments ledger: every recording the provider reports becomes a row, linked
 * to a person or not. D227 (Tyler, on Beth Huffman's call filed on Corina Raducanu: "this needs to be foolproof otherwise it's
 * worthless"; "if the client doesn't join, we don't just link it to a random client"): a recording is linked only when WHO was on
 * it and WHEN it was agree.
 *
 * - Who, in this order (D273, Tyler: "email wins, then appointment time, then last name"; "if it's shay's email then keep it shay"):
 *   the invite's email, when that contact is booked then (whoever spoke); the appointment's time: the booking whose own meeting link
 *   (Zoom id) the call used, else the one person the recorder had booked then; the invite's email with nothing booked then; the last
 *   name: who spoke, then the meeting's title ("Shay and Carly Vu"); an invitee name one contact has, booked then. When a different
 *   known client spoke (their full name or the address they joined with), that is a difference (Tyler: "if there's a difference,
 *   alert me with the details"): the operator gets an alert, and a time match is not made (the team is asked with the Link button).
 *   The team is never a client: a call where only the team spoke (a roleplay, a training) is internal and is linked to no one, and
 *   no one is asked. A second recording of the same meeting (another of the team recorded it too) is a copy: linked as the first
 *   was, it starts nothing (one review per meeting).
 * - When: a booking fits a recording that starts at most 20 minutes before it and before it ends (a short or empty booking spans 15).
 * - Linked: by the first of those that names one person; a booking is the one the recording fits (never merely the nearest), and
 *   one with no booking that fits is placed by D236. Anything else stays unlinked with the reason, and the team is asked (the
 *   Unmatched recording post, with its Link button).
 */
export type RecordingInput = {
  provider?: string; externalId: string;
  title?: string; startedAt: Date; endedAt?: Date; durationMin?: number;
  url?: string; shareUrl?: string;
  meetingUrl?: string;   // the call's own join link (Zoom, Meet…), matched to a booking's by meetingKey; never stored
  recordedBy?: { name?: string; email?: string };
  invitees: { name?: string; email?: string; isExternal?: boolean }[];
  transcript?: { speaker: string; email?: string; text: string; timestamp?: string }[];
  summary?: string;
  raw?: Record<string, unknown>;
};
export type RecordingRow = { id: string; company_id: string; contact_id: string | null; appointment_id: string | null; provider: string; external_id: string; title: string | null; started_at: Date; ended_at: Date | null; duration_min: number | null; url: string | null; share_url: string | null; recorded_by_email: string | null; recorded_by_name: string | null; invitees: { name?: string; email?: string; isExternal?: boolean }[]; transcript: { speaker: string; email?: string; text: string; timestamp?: string }[] | null; summary: string | null; analysis: Record<string, unknown>; client_spoke?: boolean | null; link_status: string; linked_by: string | null; unlinked_reason: string | null; raw: Record<string, unknown>; received_at: Date };
export type RecordResult =
  | { outcome: "duplicate"; recording: RecordingRow }
  | { outcome: "internal"; recording: RecordingRow; reason: string }   // D227: only the team spoke; linked to no one, no one asked
  | { outcome: "linked"; recording: RecordingRow; event: EventRow; contactId: string; appointmentId: string | null }
  | { outcome: "unlinked"; recording: RecordingRow; event: EventRow; reason: string }
  | { outcome: "copy"; recording: RecordingRow; of: string };   // D271: a second recording of a meeting already in: kept, linked as the first was, and starts nothing
/** `silent` (history, D115): the row is written and linked by the same ladder, and nothing is emitted, so no workflow starts and no waiting run wakes. */
export type SilentRecordResult = { outcome: "duplicate" | "linked" | "unlinked" | "copy"; recording: RecordingRow; reason?: string };

const BEFORE_MIN = 20;                 // D227: a call may start this long before its booking (the room opened early)…
const SHORT_CALL_MIN = 15;             // …and until the booking ends; a booking with no length spans this much
const MEETING_WINDOW_H = 24;           // a booking's meeting link counts for a recording this close to it (D102)
const GENERIC_SPEAKER = /^(speaker|unknown|participant|guest|user)\b|^\d+$/i;   // a transcript label that names no one

/**
 * D102: one meeting, one key, whichever side reports it: a Zoom meeting id (`/j/<digits>`), a Google Meet code, otherwise the
 * link without its query (a password or a tracking parameter differs between the booking's copy and the recorder's).
 */
export function meetingKey(url?: string | null): string | undefined {
  const s = url?.trim();
  if (!s || !/^https?:\/\//i.test(s)) return undefined;
  let u: URL;
  try { u = new URL(s); } catch { return undefined; }
  const host = u.hostname.toLowerCase().replace(/^www\./, ""), path = u.pathname.replace(/\/+$/, "");
  if (/(^|\.)zoom(gov)?\.(us|com)$/.test(host)) { const id = /^\/(?:j|s|w|wc(?:\/join)?)\/(\d{9,12})(?:\/|$)/.exec(path)?.[1]; if (id) return id; }
  if (host === "meet.google.com") { const code = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/i.exec(path)?.[1]; if (code) return code.toLowerCase(); }
  return `${host}${path}`;
}

/** The transcript as one readable document: "Speaker: text" lines. */
export const transcriptText = (t: RecordingRow["transcript"] | undefined) => (t ?? []).map((l) => `${l.speaker}: ${l.text}`).join("\n");
export const normName = (n?: string | null) => (n ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() || undefined;

/** The people on the call who are not us: staff emails come from the roster, so adding a closer needs no list to maintain. */
export async function prospectsOnCall(c: PoolClient, companyId: string, input: Pick<RecordingInput, "invitees" | "recordedBy">): Promise<{ emails: string[]; names: string[]; staffDropped: string[] }> {
  const staff = new Set((await many<{ email: string }>(c, "select lower(email) as email from users where company_id=$1 or company_id is null", [companyId])).map((u) => u.email));
  if (input.recordedBy?.email) staff.add(input.recordedBy.email.toLowerCase());
  const emails: string[] = [], names: string[] = [], staffDropped: string[] = [];
  for (const i of input.invitees) {
    const e = normEmail(i.email);
    if (e && (staff.has(e) || i.isExternal === false)) { staffDropped.push(e); continue; }
    if (e && !emails.includes(e)) emails.push(e);
    if (!e && i.name && i.isExternal !== false && !names.includes(i.name)) names.push(i.name);
    if (e && i.name && !names.includes(i.name)) names.push(i.name);
  }
  return { emails, names, staffDropped };
}

/** D236: where a call with no booking that fits is put: a client's call; their closing call held late; a follow-up on a sale already held; none of those. */
export type Placed = "client" | "held_late" | "follow_up" | "unbooked" | "no_booking";
export type Match = { contactId: string; by: "email" | "meeting" | "time" | "name" | "speaker" | "title"; appointmentId?: string; placed?: Placed };
/** `conflict` (D273, Tyler: "if there's a difference, alert me with the details"): the signals disagreed; the operator is told what each said. */
export type Resolution = { match: Match | null; reason?: string; internal?: boolean; conflict?: string };
type Fit = { id: string; contact_id: string; name: string; first: string | null; last: string | null; assigned_user_id: string | null; meeting_key: string | null; starts_at: Date };

/** D227: the live bookings a recording starting at `at` fits: it starts no more than BEFORE_MIN before one, and before it ends. */
const FIT_SQL = `select a.id, a.contact_id, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as name, ct.first_name as first, ct.last_name as last, a.assigned_user_id, a.meeting_key, a.starts_at
  from appointments a join contacts ct on ct.id=a.contact_id
  where a.company_id=$1 and ${standsSql("a")} and ct.merged_into is null
    and $2::timestamptz >= a.starts_at - make_interval(mins => ${BEFORE_MIN})
    and $2::timestamptz < greatest(coalesce(a.ends_at, a.starts_at), a.starts_at + make_interval(mins => ${SHORT_CALL_MIN}))`;
const fitsAt = (c: PoolClient, companyId: string, at: Date) => many<Fit>(c, `${FIT_SQL} order by abs(extract(epoch from (a.starts_at - $2::timestamptz)))`, [companyId, at]);

/** D227: this person's booking the recording fits (the nearest start, when a reschedule left two), or none. */
export async function fittingBooking(c: PoolClient, companyId: string, contactId: string, at: Date): Promise<string | null> {
  return (await one<{ id: string }>(c, `${FIT_SQL} and a.contact_id=$3 order by abs(extract(epoch from (a.starts_at - $2::timestamptz))) limit 1`, [companyId, at, contactId]))?.id ?? null;
}

const tokens = (n?: string | null) => normName(n)?.split(" ") ?? [];
/** A name that is a team member's: the same first name, and each further word of it a start of theirs or theirs of it ("Nelly", "Nelly Sudri" for "Nelly S."); never longer than theirs. */
const staffName = (staff: string[][], name: string) => { const s = tokens(name); return s.length > 0 && staff.some((t) => s.length <= t.length && t[0] === s[0] && s.slice(1).every((x, i) => x.startsWith(t[i + 1]) || t[i + 1].startsWith(x))); };
/**
 * D271: the names a meeting's title gives for who it is with, the team's own left out: "Shay and Carly Vu" → Shay, "Carline Sanders:
 * The Beauty Moguls …" → Carline Sanders, "Test again <> Carly Vu" → Test again. A title that is only the tool's ("Impromptu Zoom
 * Meeting") names nobody.
 */
export function titleNames(title: string | null | undefined, staff: string[][]): string[] {
  const t = (title ?? "").trim();
  if (!t || /^impromptu\b|\bmeeting$|^personal meeting room/i.test(t)) return [];
  const head = t.includes(":") ? t.split(":")[0] : t;
  return head.split(/\s+(?:and|&|<>|x|with|\+|\/)\s+|\s*<>\s*/i).map((x) => x.trim()).filter((x) => x && /\p{L}/u.test(x) && !staffName(staff, x));
}

/**
 * D227: a name someone gave on the call is this booked person's: the same surname, and a first name that is theirs, holds theirs or is
 * held in it ("Elizabeth" for "Beth"), or is in one of their email addresses; a first name alone must be theirs exactly.
 */
export function nameAgrees(spoken: string, first: string | null, last: string | null, emails: string[] = []): boolean {
  const s = tokens(spoken), f = tokens(first)[0], l = tokens(last).at(-1);
  if (!s.length || !f) return false;
  const sf = s[0], sl = s.length > 1 ? s.at(-1)! : undefined;
  if (!sl) return sf === f || (sf.length >= 2 && sf.length < f.length && f.startsWith(sf.slice(0, 2)) && sf[0] === f[0] && (f.startsWith(sf) || sf.length <= 4));   // a short form: "Evy" for Evelyn, "Kat" for Katherine
  const firstOk = sf === f || (sf.length >= 3 && f.length >= 3 && (sf.includes(f) || f.includes(sf))) || (sf.length >= 3 && emails.some((e) => e.split("@")[0].includes(sf)));
  return !!l && sl === l && firstOk;
}

const SALES_BOOKING = "('closing','follow_up')";   // a booking that is a sales call: a closing call or a follow-up
const LATE_DAYS = 3;                               // a closing call held off the calendar this soon after its booking is that booking (Tyler: "sure", 3 days)

/**
 * D236 (Tyler, on Erica's consultation held a day late and Rafaela's second Sales Call: "it should have updated the first one"):
 * a person on the call, with no booking the call fits, is placed by what the ledger already holds about them, in this order.
 * - client: cash collected from them, or a close filed (the end of day, a payment) on a call before this one. Their call is not a
 *   sales call: the workflow writes the note and nothing else.
 * - held_late: exactly one closing booking of theirs in the LATE_DAYS before the call with nothing filed on it: the call is it.
 * - follow_up: their latest closing booking before the call that was held: the call is a follow-up on that sale (its Sales Call updated).
 * - unbooked: none of these, and they have a sales booking in the two weeks either side: the team is asked which booking it was.
 * - no_booking: no sales booking near it to ask about: the call keeps its own Sales Call, as before.
 */
export async function placeCall(c: PoolClient, companyId: string, contactId: string, at: Date): Promise<{ appointmentId: string | null; placed: Placed }> {
  const client = await one(c, `select 1 where exists (select 1 from payments p where p.company_id=$1 and p.contact_id=$2 and p.status='succeeded' and p.paid_at < $3)
    or exists (select 1 from appointments a join company_terms t on t.id=a.call_outcome_term where a.company_id=$1 and a.contact_id=$2 and a.starts_at < $3 and t.category in ('closed','deposit'))`, [companyId, contactId, at]);
  if (client) return { appointmentId: null, placed: "client" };
  const late = await many<{ id: string }>(c, `select a.id from appointments a join company_terms t on t.id=a.appointment_term where a.company_id=$1 and a.contact_id=$2 and t.category in ${SALES_BOOKING}
    and ${standsSql("a")} and a.starts_at < $3 and a.starts_at >= $3::timestamptz - make_interval(days => ${LATE_DAYS}) and a.outcome_term is null and a.call_outcome_term is null`, [companyId, contactId, at]);
  if (late.length === 1) return { appointmentId: late[0].id, placed: "held_late" };
  const held = await one<{ id: string }>(c, `select a.id from appointments a join company_terms t on t.id=a.appointment_term left join company_terms o on o.id=a.outcome_term
    where a.company_id=$1 and a.contact_id=$2 and t.category in ${SALES_BOOKING} and ${standsSql("a")} and a.starts_at < $3 and (o.category='showed' or a.call_outcome_term is not null)
    order by a.starts_at desc limit 1`, [companyId, contactId, at]);
  if (held && !late.length) return { appointmentId: held.id, placed: "follow_up" };
  const near = await one(c, `select 1 from appointments a join company_terms t on t.id=a.appointment_term where a.company_id=$1 and a.contact_id=$2 and t.category in ${SALES_BOOKING}
    and ${standsSql("a")} and a.starts_at between $3::timestamptz - interval '14 days' and $3::timestamptz + interval '14 days' limit 1`, [companyId, contactId, at]);   // what the question lists
  return { appointmentId: null, placed: near ? "unbooked" : "no_booking" };
}

/** D227's rules, then D236: a person found with no booking that fits is placed by what the ledger holds about them. */
export async function resolveRecording(c: PoolClient, companyId: string, input: RecordingInput): Promise<Resolution> {
  const r = await matchRecording(c, companyId, input);
  if (!r.match || r.match.appointmentId) return r;
  const p = await placeCall(c, companyId, r.match.contactId, input.startedAt);
  return { ...r, match: { ...r.match, ...(p.appointmentId ? { appointmentId: p.appointmentId } : {}), placed: p.placed } };
}

/**
 * Who spoke on a recording, and which of them are not the team (the roster, the recorder, whoever the invite marks as ours). D254:
 * the same split says whether the client spoke at all (`clientSpoke`), kept on the recording because the transcript is not.
 */
async function speakersOf(c: PoolClient, companyId: string, input: RecordingInput, staffDropped: string[]) {
  const users = await many<{ email: string; name: string | null }>(c, "select lower(email) as email, name from users where company_id=$1 or company_id is null", [companyId]);
  const staffEmails = new Set([...users.map((u) => u.email), ...staffDropped, ...(input.recordedBy?.email ? [input.recordedBy.email.toLowerCase()] : [])]);
  const staffNames = [...users.map((u) => u.name), input.recordedBy?.name, ...input.invitees.filter((i) => i.isExternal === false || (i.email && staffEmails.has(i.email.toLowerCase()))).map((i) => i.name)]
    .map(tokens).filter((t) => t.length > 0);
  const lines = input.transcript ?? [];
  const spoke = new Map<string, { name: string; email?: string; byAddress?: boolean }>();
  for (const l of lines) {
    const label = l.speaker.trim(), asEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(label) ? normEmail(label) : undefined;   // a guest with no display name is shown by their address
    const n = normName(label); if (n && !spoke.has(n)) spoke.set(n, { name: label, email: normEmail(l.email) ?? asEmail, ...(asEmail ? { byAddress: true } : {}) });
  }
  const guests = [...spoke.values()].filter((p) => !(p.email && staffEmails.has(p.email)) && !staffName(staffNames, p.name));
  return { lines, spoke, guests, staffNames };
}

/** D254: did anyone but the team speak? null when there is no transcript to say. */
export async function clientSpoke(c: PoolClient, companyId: string, input: RecordingInput): Promise<boolean | null> {
  if (!input.transcript?.length) return null;
  const { staffDropped } = await prospectsOnCall(c, companyId, input);
  return (await speakersOf(c, companyId, input, staffDropped)).guests.length > 0;
}

async function matchRecording(c: PoolClient, companyId: string, input: RecordingInput): Promise<Resolution> {
  const { emails, names, staffDropped } = await prospectsOnCall(c, companyId, input);
  const key = meetingKey(input.meetingUrl);
  const tz = (await one<{ timezone: string }>(c, "select timezone from companies where id=$1", [companyId]))?.timezone ?? "UTC";
  const when = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat("ccc MMM d, h:mm a");
  const who = (f: Fit) => `${f.name || "someone"} (booked ${when(f.starts_at)})`;
  const emailsOf = async (contactId: string) => (await many<{ value: string }>(c, "select value from contact_identifiers where contact_id=$1 and kind='email' and retired_at is null", [contactId])).map((r) => r.value);
  const recorder = input.recordedBy?.email ? await one<{ id: string }>(c, "select id from users where company_id=$1 and lower(email)=$2 and active", [companyId, input.recordedBy.email.toLowerCase()]) : null;
  const fits = await fitsAt(c, companyId, input.startedAt);
  const theirs = (f: Fit) => !!recorder && f.assigned_user_id === recorder.id;

  const { lines, spoke, guests, staffNames } = await speakersOf(c, companyId, input, staffDropped);
  if (lines.length && spoke.size && !guests.length) return { match: null, internal: true, reason: `only the team spoke (${[...spoke.values()].map((p) => p.name).join(", ")}): not a call with a client, so it is linked to no one` };
  const named = guests.filter((p) => !GENERIC_SPEAKER.test(p.name.trim()));
  const keyed = (f: Fit) => !!key && f.meeting_key === key;
  let sharedLink = 0, room: { id: string; contact_id: string } | null = null;   // the one booking whose own meeting link the call used (D102)
  if (key) {
    const rows = await many<{ id: string; contact_id: string; off: number }>(c, `select a.id, a.contact_id, abs(extract(epoch from (a.starts_at - $3::timestamptz)))::float as off from appointments a where a.company_id=$1 and a.meeting_key=$2 and ${standsSql("a")}`, [companyId, key, input.startedAt]);
    if (rows.length === 1 && rows[0].off <= MEETING_WINDOW_H * 3600) room = rows[0];
    if (rows.length > 1) sharedLink = rows.length;
  }
  const shared = sharedLink ? `; its meeting link is on ${sharedLink} bookings` : "";
  const uniq = (fs: Fit[]) => [...new Set(fs.map((f) => f.contact_id))];
  const bookingOf = (id: string) => room?.contact_id === id ? room.id : (fits.filter((f) => f.contact_id === id).find(keyed) ?? fits.find((f) => f.contact_id === id))?.id;
  const matched = (contactId: string, by: Match["by"], conflict?: string): Resolution => { const a = bookingOf(contactId); return { match: { contactId, by, ...(a ? { appointmentId: a } : {}) }, ...(conflict ? { conflict } : {}) }; };
  const named_ = async (id: string) => (await one<{ n: string }>(c, "select trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) as n from contacts where id=$1", [id]))?.n || "a contact";
  // D273: a different known client spoke (their full name is one contact's, or they joined with an address of theirs) and nobody who spoke is this person
  const otherSpoke = async (contactId: string): Promise<{ id: string; said: string } | null> => {
    const me = await one<{ first_name: string | null; last_name: string | null }>(c, "select first_name, last_name from contacts where id=$1", [contactId]);
    if (me && named.some((p) => nameAgrees(p.name, me.first_name, me.last_name))) return null;
    for (const p of named) {
      const byName = tokens(p.name).length > 1 ? await many<{ id: string }>(c, "select id from contacts where company_id=$1 and merged_into is null and lower(regexp_replace(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')), '[^[:alnum:]]+', ' ', 'g'))=$2", [companyId, normName(p.name)]) : [];
      const byAddr = p.email ? await one<{ id: string }>(c, "select i.contact_id as id from contact_identifiers i join contacts ct on ct.id=i.contact_id where i.company_id=$1 and i.kind='email' and i.value=$2 and ct.merged_into is null", [companyId, p.email]) : null;
      const other = byAddr?.id ?? (byName.length === 1 ? byName[0].id : null);
      if (other && other !== contactId) return { id: other, said: p.name };
    }
    return null;
  };
  const differs = async (contactId: string, why: string) => { const o = await otherSpoke(contactId); return o ? `${why} ${await named_(contactId)}, but ${o.said} spoke, who is ${await named_(o.id)} in the CRM` : undefined; };

  // D273 (Tyler: "email wins, then appointment time, then last name"; "if it's shay's email then keep it shay")
  // 1. the invite's email wins, whoever spoke: the one invited contact booked then (their booking whose room the call used first)
  const byEmail = new Set<string>();
  for (const e of emails) { const r = await one<{ contact_id: string }>(c, "select i.contact_id from contact_identifiers i join contacts ct on ct.id=i.contact_id where i.company_id=$1 and i.kind='email' and i.value=$2 and ct.merged_into is null", [companyId, e]); if (r) byEmail.add(r.contact_id); }
  const emailThen = uniq([...fits.filter((f) => byEmail.has(f.contact_id)), ...(room && byEmail.has(room.contact_id) ? [{ contact_id: room.contact_id } as Fit] : [])]);
  if (emailThen.length === 1) return matched(emailThen[0], "email", await differs(emailThen[0], "the invite's email is"));

  // 2. the appointment's time: the booking whose own meeting link (Zoom id) the call used; else the one person the recorder had booked then.
  //    An invited contact with nothing booked then gives way to it (D227: Corina's stale invite on Beth's booked call)
  //    A different known client who spoke is a difference: linked to no one, the operator is told, the team is asked (the Link button)
  const mine = fits.filter(theirs), mineThen = uniq(mine);
  const byTime = room?.contact_id ?? (mineThen.length === 1 ? mineThen[0] : null);
  if (byTime) {
    const d = await differs(byTime, room ? "the call used the meeting link of the booking of" : "the recorder's booking then is");
    if (d) return { match: null, reason: d, conflict: d };
    return matched(byTime, room ? "meeting" : "time");
  }
  // 3. the invite's email with no booking then: still theirs (where it goes is placed by D236)
  if (byEmail.size === 1) { const id = [...byEmail][0]; return matched(id, "email", await differs(id, "the invite's email is")); }

  // 4. last name: who spoke, then the meeting's title ("Shay and Carly Vu"): the one booked person the name agrees with, else the one
  //    contact who has that full name (or joined with an address of theirs)
  const said = named.map((p) => p.name);
  const spoken = [...said, ...titleNames(input.title, staffNames)];
  if (spoken.length) {
    const agree: Fit[] = [];
    for (const f of fits) { const e = await emailsOf(f.contact_id); if (spoken.some((n) => nameAgrees(n, f.first, f.last, e))) agree.push(f); }
    const agreeing = uniq(agree);
    if (agreeing.length === 1) return matched(agreeing[0], (said.some((n) => nameAgrees(n, agree[0].first, agree[0].last)) ? "speaker" : "title"));
    if (agreeing.length > 1) return { match: null, reason: `${spoken.join(", ")} on the call, and ${agreeing.length} bookings then fit them (${agree.map(who).join(", ")}): which one is a person's call` };
    const people = new Set<string>();
    for (const n of spoken) {
      const rows = await many<{ id: string }>(c, "select id from contacts where company_id=$1 and merged_into is null and lower(regexp_replace(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')), '[^[:alnum:]]+', ' ', 'g'))=$2", [companyId, normName(n)]);
      if (rows.length === 1 && tokens(n).length > 1) people.add(rows[0].id);   // a full name one contact has; a first name alone is not a person
    }
    for (const p of named) if (p.email) {
      const r = await one<{ id: string; first_name: string | null; last_name: string | null }>(c, "select ct.id, ct.first_name, ct.last_name from contact_identifiers i join contacts ct on ct.id=i.contact_id where i.company_id=$1 and i.kind='email' and i.value=$2 and ct.merged_into is null", [companyId, p.email]);
      if (r && (p.byAddress || nameAgrees(p.name, r.first_name, r.last_name, [p.email]))) people.add(r.id);   // the address they joined with is them
    }
    if (people.size === 1) { const id = [...people][0]; return matched(id, said.length ? "speaker" : "title"); }
    if (people.size > 1) return { match: null, reason: `${spoken.join(", ")} on the call are ${people.size} different contacts: which one is a person's call` };
  }

  // 5. an invitee's name exactly one contact has, booked then
  const notes: string[] = [];
  const byName = new Set<string>();
  for (const n of names.map(normName).filter((x): x is string => !!x)) {
    const rows = await many<{ id: string }>(c, "select id from contacts where company_id=$1 and merged_into is null and lower(regexp_replace(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')), '[^[:alnum:]]+', ' ', 'g'))=$2", [companyId, n]);
    if (rows.length === 1) byName.add(rows[0].id); else if (rows.length > 1) notes.push(`"${n}" is the name of ${rows.length} contacts`);
  }
  const nameThen = uniq(fits.filter((f) => byName.has(f.contact_id)));
  if (nameThen.length === 1) return matched(nameThen[0], "name");

  const heard = said.length ? `; ${said.join(", ")} spoke, and nobody in the CRM has that name` : lines.length ? "" : ", and no transcript says who joined";
  if (byEmail.size > 1) return { match: null, reason: `the invite names ${byEmail.size} different contacts and ${emailThen.length ? `${emailThen.length} were booked then` : "none has a booking then"}${heard}${shared}` };
  if (byName.size === 1) {
    const id = [...byName][0];
    const own = await one<{ starts_at: Date }>(c, `select a.starts_at from appointments a where a.company_id=$1 and a.contact_id=$2 and ${standsSql("a")} order by abs(extract(epoch from (a.starts_at - $3::timestamptz))) limit 1`, [companyId, id, input.startedAt]);
    return { match: null, reason: `the invite names ${await named_(id)}${own ? `, booked ${when(own.starts_at)}, which this recording (${when(input.startedAt)}) does not fit` : ", who has no booking"}; a name alone is not enough${heard}${shared}` };
  }
  const seen = [...emails, ...names].join(", ");
  return { match: null, reason: (seen ? `nobody in the CRM matches ${seen}` : staffDropped.length ? `only the team was invited (${staffDropped.join(", ")})` : "no attendees on the recording")
    + heard + (mineThen.length > 1 ? `; the recorder had ${mineThen.length} bookings then (${mine.map(who).join(", ")})` : mine.length ? "" : fits.length ? `; booked then: ${fits.map(who).join(", ")}, none the recorder's` : "")
    + (notes.length ? `; ${notes.join("; ")}` : "") + shared };
}

/**
 * D215: the recordings the ladder could not place, tried again (the ladder has learned since, or the person and their booking arrived
 * after the recording did). A match is linked the backfill's way, silently: no event, no run; the Sales Call backfill reads it after.
 */
export async function rematchRecordings(c: PoolClient, companyId: string, opts: { from: Date; to: Date; dryRun: boolean }): Promise<{ linked: { id: string; title: string | null; started_at: string; contact_id: string; appointment_id: string | null; by: string }[]; still: { id: string; title: string | null; started_at: string; reason: string }[] }> {
  const rows = await many<RecordingRow>(c, "select * from recordings where company_id=$1 and link_status='unlinked' and provider<>'ghl' and started_at >= $2 and started_at < $3 order by started_at", [companyId, opts.from, opts.to]);
  const linked: Awaited<ReturnType<typeof rematchRecordings>>["linked"] = [], still: Awaited<ReturnType<typeof rematchRecordings>>["still"] = [];
  for (const r of rows) {
    const input: RecordingInput = { provider: r.provider, externalId: r.external_id, startedAt: r.started_at, recordedBy: { name: r.recorded_by_name ?? undefined, email: r.recorded_by_email ?? undefined }, invitees: r.invitees ?? [], transcript: r.transcript ?? undefined };
    const { match, reason } = await resolveRecording(c, companyId, input);
    if (!match) {
      if (!opts.dryRun && reason && reason !== r.unlinked_reason) await c.query("update recordings set unlinked_reason=$2 where id=$1", [r.id, reason]);
      still.push({ id: r.id, title: r.title, started_at: r.started_at.toISOString(), reason: reason ?? "no match" }); continue;
    }
    const appointmentId = opts.dryRun ? match.appointmentId ?? null : (await settle(c, companyId, r, match.contactId, match.by, match.appointmentId ?? null, true)).appointmentId;
    linked.push({ id: r.id, title: r.title, started_at: r.started_at.toISOString(), contact_id: match.contactId, appointment_id: appointmentId, by: match.by });
  }
  if (!opts.dryRun && linked.length) await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'recordings.rematched','company',$2,$3)", [companyId, companyId, { from: opts.from, to: opts.to, linked }]);
  return { linked, still };
}

export const eventData = (r: RecordingRow, extra: Record<string, unknown> = {}) => ({ recording_id: r.id, provider: r.provider, external_id: r.external_id, title: r.title, started_at: r.started_at.toISOString(), duration_min: r.duration_min, share_url: r.share_url, recorded_by: r.recorded_by_email, ...extra });

async function settle(c: PoolClient, companyId: string, r: RecordingRow, contactId: string, by: string, appointmentId: string | null, silent = false, placed?: Placed): Promise<{ event: EventRow | null; appointmentId: string | null }> {
  const apptId = appointmentId;   // D227: the booking the match found the recording fits, or none (never merely the nearest)
  await c.query("update recordings set contact_id=$2, appointment_id=$3, link_status='linked', linked_by=$4, unlinked_reason=null where id=$1", [r.id, contactId, apptId, by]);
  if (silent) return { event: null, appointmentId: apptId };
  const appt = apptId ? await one<{ opportunity_id: string | null }>(c, "select opportunity_id from appointments where id=$1", [apptId]) : null;
  const event = await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: appt?.opportunity_id ?? null, appointment_id: apptId, event_type: "recording.received", source: r.provider === "fathom" ? "fathom" : "zapier", occurred_at: r.started_at,
    data: eventData(r, { matched_by: by, appointment_matched: !!apptId, ...(placed ? { placed } : {}) }) });
  return { event, appointmentId: apptId };
}

/** Records a provider recording. Idempotent on (provider, recording id). */
export async function recordRecording(c: PoolClient, companyId: string, input: RecordingInput): Promise<RecordResult>;
export async function recordRecording(c: PoolClient, companyId: string, input: RecordingInput, opts: { silent: true }): Promise<SilentRecordResult>;
export async function recordRecording(c: PoolClient, companyId: string, input: RecordingInput, opts: { silent?: boolean } = {}): Promise<RecordResult | SilentRecordResult> {
  const provider = input.provider ?? "fathom";
  // D87: a webhook body delivers the transcript once, so it is HELD on the row only until the runs that read it are done (transcripts.ts
  // releases it); the provider's summary is never kept (nothing reads it). Whether there was one stays on the row for good.
  const has = !!input.transcript?.length;
  const inserted = await one<RecordingRow>(c, `insert into recordings (company_id, provider, external_id, title, started_at, ended_at, duration_min, url, share_url, recorded_by_email, recorded_by_name, invitees, transcript, summary, raw)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,null,$14) on conflict (company_id, provider, external_id) do nothing returning *`,
    [companyId, provider, input.externalId, input.title ?? null, input.startedAt, input.endedAt ?? null, input.durationMin ?? null, input.url ?? null, input.shareUrl ?? null, normEmail(input.recordedBy?.email) ?? null, input.recordedBy?.name ?? null,
      JSON.stringify(input.invitees), has ? JSON.stringify(input.transcript) : null, { ...(input.raw ?? {}), transcript_status: has ? "ready" : input.raw?.transcript_status ?? "none" }]);
  if (!inserted) return { outcome: "duplicate", recording: (await one<RecordingRow>(c, "select * from recordings where company_id=$1 and provider=$2 and external_id=$3", [companyId, provider, input.externalId]))! };
  await c.query("update recordings set client_spoke=$2 where id=$1", [inserted.id, await clientSpoke(c, companyId, input)]);   // D254
  const { match, reason, internal, conflict } = await resolveRecording(c, companyId, input);
  if (conflict && !opts.silent) {
    const tz = (await one<{ timezone: string }>(c, "select timezone from companies where id=$1", [companyId]))?.timezone ?? "UTC";
    await raise(c, { companyId, key: `recording:conflict:${inserted.id}`, level: "warning", source: "engine",
    text: `A recording's people disagree: ${conflict}. ${match ? "Linked by the invite's email; check it." : "Linked to no one: the team is asked which person it was."} "${input.title ?? "Untitled"}", recorded by ${input.recordedBy?.name ?? input.recordedBy?.email ?? "?"} on ${DateTime.fromJSDate(input.startedAt).setZone(tz).toFormat("ccc MMM d, h:mm a")}${input.shareUrl ? ` (${input.shareUrl})` : ""}.`,
    detail: { recording_id: inserted.id, conflict, linked: !!match } });
  }
  // D271 (Tyler: "Call recorded by 2 people only gets reviewed once"): the same meeting recorded by two of the team. The one that came
  // second is linked as the first was and starts nothing; the review (on the first) is credited to the contact's closer, not the recorder.
  const twin = await copyOf(c, companyId, inserted, match?.contactId ?? null);
  if (twin) {
    if (twin.contact_id) await c.query("update recordings set contact_id=$2, appointment_id=$3, link_status='linked', linked_by=$4, unlinked_reason=null where id=$1", [inserted.id, twin.contact_id, twin.appointment_id, twin.linked_by]);
    const row = (await one<RecordingRow>(c, "update recordings set raw = raw || jsonb_build_object('copy_of', $2::text), unlinked_reason=coalesce(unlinked_reason, $3) where id=$1 returning *", [inserted.id, twin.id, twin.contact_id ? null : `a copy of ${twin.id}, which matched nobody either`]))!;
    return { outcome: "copy", recording: row, of: twin.id };
  }
  if (match) {
    const { event, appointmentId } = await settle(c, companyId, inserted, match.contactId, match.by, match.appointmentId ?? null, opts.silent, match.placed);
    const recording = (await one<RecordingRow>(c, "select * from recordings where id=$1", [inserted.id]))!;
    return event ? { outcome: "linked", recording, event, contactId: match.contactId, appointmentId } : { outcome: "linked", recording };
  }
  const row = (await one<RecordingRow>(c, "update recordings set unlinked_reason=$2 where id=$1 returning *", [inserted.id, reason ?? null]))!;
  if (opts.silent) return { outcome: "unlinked", recording: row, reason: reason ?? "no match" };
  if (internal) return { outcome: "internal", recording: row, reason: reason ?? "only the team spoke" };
  const event = await emitEvent(c, { company_id: companyId, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "recording.unlinked", source: provider === "fathom" ? "fathom" : "zapier", occurred_at: input.startedAt, data: eventData(row, { reason, invitees: input.invitees, attendees: input.invitees.map((i) => i.email ?? i.name).filter(Boolean).join(", ") }) });
  return { outcome: "unlinked", recording: row, event, reason: reason ?? "no match" };
}

const GENERIC_TITLE = /^impromptu\b|^personal meeting room|^zoom meeting$|^meeting$/i;
/**
 * D271: the recording already in that this one is another copy of: the same meeting, recorded by someone else on the team, its time
 * overlapping this one's. The same person on both (this one's match, or theirs), or else the same title, unless the title is only the
 * tool's ("Impromptu Zoom Meeting": two closers can be on two of those at once). A copy of a copy is a copy of the first.
 */
async function copyOf(c: PoolClient, companyId: string, r: RecordingRow, contactId: string | null): Promise<RecordingRow | null> {
  if (r.provider === "ghl") return null;   // a dialer call is the caller's own; its parts are joined by call_conversation
  const end = r.ended_at ?? new Date(r.started_at.getTime() + Math.max(r.duration_min ?? 1, 1) * 60e3);
  const title = (r.title ?? "").trim(), byTitle = !!title && !GENERIC_TITLE.test(title);
  return (await one<RecordingRow>(c, `select * from recordings where company_id=$1 and id<>$2 and provider<>'ghl' and coalesce(raw->>'copy_of','')=''
      and recorded_by_email is distinct from $3 and started_at < $5 and coalesce(ended_at, started_at + make_interval(mins => greatest(coalesce(duration_min,1),1))) > $4
      and (($6::uuid is not null and contact_id=$6) or ($7 and lower(trim(coalesce(title,'')))=lower($8)))
    order by received_at, started_at limit 1`, [companyId, r.id, r.recorded_by_email, r.started_at, end, contactId, byTitle, title])) ?? null;
}

/** A person links an orphan (the Slack button): it then runs as a match on arrival would, Sales call recorded included. The attendee's email is remembered so the next call from them links on its own. */
export async function linkRecording(c: PoolClient, companyId: string, recordingId: string, contactId: string, opts: { remember?: boolean; appointmentId?: string | null; by?: string; placed?: Placed; backfill?: boolean } = {}): Promise<{ event: EventRow; appointmentId: string | null; started: number }> {
  const r = await one<RecordingRow>(c, "select * from recordings where company_id=$1 and id=$2", [companyId, recordingId]);
  if (!r) throw new Error("recording not found");
  if (r.link_status === "linked") throw new Error("recording is already linked");
  if (!(await one(c, "select 1 from contacts where company_id=$1 and id=$2", [companyId, contactId]))) throw new Error("contact not found");
  const { emails } = await prospectsOnCall(c, companyId, { invitees: r.invitees, recordedBy: { email: r.recorded_by_email ?? undefined } });
  if (opts.remember !== false && emails.length === 1) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3) on conflict (company_id, kind, value) do nothing", [companyId, contactId, emails[0]]);
  const by = opts.by ?? "manual";
  // the booking the recording fits; with none, where the ledger places the call (D236)
  let booking = opts.appointmentId, placed = opts.placed;
  if (booking === undefined) { booking = await fittingBooking(c, companyId, contactId, r.started_at); if (!booking) { const p = await placeCall(c, companyId, contactId, r.started_at); booking = p.appointmentId; placed = p.placed; } }
  const { event, appointmentId } = await settle(c, companyId, r, contactId, by, booking, false, placed);
  await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: event!.opportunity_id, appointment_id: appointmentId, event_type: "recording.linked", source: "user", data: { recording_id: r.id, by } });
  if (opts.backfill) return { event: event!, appointmentId, started: 0 };   // D274: filed on the ledger, nothing set off for an old call
  const appt = appointmentId ? await one<Record<string, unknown>>(c, "select a.id, a.starts_at, a.status, json_build_object('category', t.category) as term from appointments a join company_terms t on t.id=a.appointment_term where a.id=$1", [appointmentId]) : null;
  const started = await dispatchEvent(c, event!, { contact: { id: contactId }, appointment: appt ?? undefined, recording: { id: r.id, title: r.title, duration_min: r.duration_min } });
  return { event: event!, appointmentId, started: started.length };
}

// ---- phone calls (D28) -----------------------------------------------------------------------------------------------
/**
 * A call the CRM's dialer logged is a recording too, and lives in the same ledger: provider 'ghl', the call entry's id as
 * external_id, the contact known outright (the thread names them, so no ladder). What is different is timing: the entry
 * appears the moment the call ends, the transcript minutes later, so a connected call sits `pending` and is settled by a
 * later poll (transcript found, or `calls.transcript_wait_min` after hang-up passed). Every call is kept, answered or not —
 * connection rate and speed-to-lead are read from this table later. `call.logged` fires once per call, when it settles.
 * D87: the transcript itself is never stored; the row says whether there is one (`raw.transcript_status`), and a step that
 * reads it fetches it from GHL again (transcripts.ts). A call of 0 seconds is not a connected call, nor a part of one.
 */
export type PhoneCallInput = { externalId: string; contactId: string; startedAt: Date; durationSec: number; direction: "inbound" | "outbound"; status: string; callerGhlUserId?: string; conversationUrl?: string; raw?: Record<string, unknown> };
/** GHL's dialer vocabulary → ours. Unknown statuses are kept as given so nothing is silently rewritten. */
export const callOutcome = (status: string) => ({ completed: "connected", answered: "connected", "no-answer": "no_answer", noanswer: "no_answer", busy: "busy", failed: "failed", canceled: "failed", cancelled: "failed", voicemail: "voicemail" } as Record<string, string>)[status.toLowerCase()] ?? status.toLowerCase();

/** D275: a call GHL has not finished (still ringing or in progress): no final status or length yet, so it is read again until it has one. */
export const UNFINISHED_CALL = new Set(["ringing", "in-progress", "in_progress", "initiated", "queued", "dialing"]);
const outcomeOf = (status: string, durationSec: number) => { const said = callOutcome(status); return said === "connected" && !(durationSec > 0) ? "zero_seconds" : said; };
export async function recordPhoneCall(c: PoolClient, companyId: string, input: PhoneCallInput): Promise<{ recording: RecordingRow; isNew: boolean }> {
  // D87: "Calls under a minimum of 0, for sure. Don't count it." The dialer says completed for a 0-second connect; it is no call
  const outcome = outcomeOf(input.status, input.durationSec);
  const connected = outcome === "connected", unfinished = UNFINISHED_CALL.has(outcome);
  const caller = input.callerGhlUserId ? await one<{ name: string; email: string }>(c, "select name, email from users where company_id=$1 and ghl_user_id=$2", [companyId, input.callerGhlUserId]) : null;
  const raw = { ...(input.raw ?? {}), kind: "phone", direction: input.direction, call_status: outcome, call_status_raw: input.status, duration_sec: input.durationSec, caller_ghl_user_id: input.callerGhlUserId ?? null, transcript_status: unfinished ? "unfinished" : connected ? "pending" : "none" };
  const inserted = await one<RecordingRow>(c, `insert into recordings (company_id, contact_id, provider, external_id, title, started_at, ended_at, duration_min, share_url, recorded_by_email, recorded_by_name, invitees, link_status, linked_by, raw)
    values ($1,$2,'ghl',$3,$4,$5,$6,$7,$8,$9,$10,'[]','linked','contact',$11) on conflict (company_id, provider, external_id) do nothing returning *`,
    [companyId, input.contactId, input.externalId, `${input.direction === "inbound" ? "Inbound" : "Outbound"} call · ${outcome.replace("_", " ")}`, input.startedAt, new Date(input.startedAt.getTime() + input.durationSec * 1000), Math.round(input.durationSec / 60), input.conversationUrl ?? null,
      caller ? normEmail(caller.email) ?? null : null, caller?.name ?? null, raw]);
  if (inserted) return { recording: inserted, isNew: true };
  return { recording: (await one<RecordingRow>(c, "select * from recordings where company_id=$1 and provider='ghl' and external_id=$2", [companyId, input.externalId]))!, isNew: false };
}

/**
 * Writes whether there is a transcript (never the transcript: GHL keeps it and a step fetches it again, D87) and fires
 * `call.logged` exactly once. `silent` for the baseline poll: the row is kept, nothing is dispatched. `hold` is for a source
 * that cannot be asked again (the simulator's synthetic call): the transcript is held like a webhook's until its runs are done.
 */
export async function settlePhoneCall(c: PoolClient, r: RecordingRow, media: { recordingUrl?: string; transcript: RecordingRow["transcript"] | null } | null, opts: { silent?: boolean; hold?: boolean } = {}): Promise<{ recording: RecordingRow; event: EventRow | null }> {
  const has = !!media?.transcript?.length;
  const raw = { ...r.raw, transcript_status: has ? "ready" : "none", ...(opts.silent ? { baseline: true } : {}) };
  const row = (await one<RecordingRow>(c, "update recordings set transcript=$2, url=coalesce($3, url), raw=$4 where id=$1 returning *", [r.id, has && opts.hold ? JSON.stringify(media!.transcript) : null, media?.recordingUrl ?? null, raw]))!;
  if (opts.silent) return { recording: row, event: null };
  const event = await emitEvent(c, { company_id: r.company_id, contact_id: r.contact_id, opportunity_id: null, appointment_id: null, event_type: "call.logged", source: "ghl_poll", occurred_at: r.started_at, data: eventData(row, phoneFacts(row)) });
  return { recording: row, event };
}
/** The call as a trigger sees it (`{{recording.*}}` in a match), the same fields context.ts exposes to the run. */
export const phoneFacts = (r: RecordingRow) => { const raw = r.raw as Record<string, unknown>; return { kind: "phone", direction: raw.direction, status: raw.call_status, connected: isConnected(r), duration_sec: raw.duration_sec, has_transcript: hasTranscript(r), caller: r.recorded_by_name }; };
/** A call that connected for more than 0 seconds (rows from before D87 may say connected for a 0-second connect). */
export const isConnected = (r: Pick<RecordingRow, "raw">) => r.raw.call_status === "connected" && !(Number(r.raw.duration_sec ?? 1) <= 0);
/** Whether the recording has a transcript to read: settled with one (D87: the row keeps only that fact), or one is held. */
// "at_source": a recording read back from the recorder's history (D115), whose transcript is read from it when needed
export const hasTranscript = (r: Pick<RecordingRow, "raw" | "transcript">) => r.raw.transcript_status === "ready" || r.raw.transcript_status === "at_source" || !!r.transcript?.length;
/**
 * D275: these calls as GHL has them now (status and length), read through each person's threads, one read per person. GHL refuses
 * the single-message read (/conversations/messages/<id>) to a private integration token, so the thread is the read.
 */
export async function callsNow(c: PoolClient, adapters: Adapters, ac: Company, rows: RecordingRow[]): Promise<Map<string, { status: string; durationSec?: number }>> {
  const out = new Map<string, { status: string; durationSec?: number }>();
  if (!adapters.read.contactCalls || !rows.length) return out;
  const ids = [...new Set(rows.map((r) => r.contact_id).filter((x): x is string => !!x))];
  const people = await many<{ id: string; ghl_contact_id: string | null }>(c, "select id, ghl_contact_id from contacts where id = any($1::uuid[])", [ids]);
  const want = new Set(rows.map((r) => r.external_id));
  for (const p of people) {
    if (!p.ghl_contact_id) continue;
    for (const m of await adapters.read.contactCalls(ac, p.ghl_contact_id)) if (want.has(m.id)) out.set(m.id, { status: m.call?.status ?? m.status ?? "", durationSec: m.call?.durationSec });
  }
  return out;
}
/** D275: calls first seen before they ended, still waiting for GHL's final status. */
export const unfinishedPhoneCalls = (c: PoolClient, companyId: string, limit = 100) => many<RecordingRow>(c, "select * from recordings where company_id=$1 and provider='ghl' and raw->>'transcript_status'='unfinished' order by started_at limit $2", [companyId, limit]);
/**
 * D275: a call's final status and length, as GHL now has it, written on its row (status, length, end, title); a connected call then
 * waits for its transcript like any other. `settled` keeps the transcript state a call already settled with (the backlog's repair).
 */
export async function finishPhoneCall(c: PoolClient, r: RecordingRow, now: { status: string; durationSec?: number }, opts: { settled?: boolean } = {}): Promise<RecordingRow> {
  const sec = now.durationSec ?? 0, outcome = outcomeOf(now.status, sec);
  const status = opts.settled ? r.raw.transcript_status : UNFINISHED_CALL.has(outcome) ? "unfinished" : outcome === "connected" ? "pending" : "none";
  const raw = { ...r.raw, call_status: outcome, call_status_raw: now.status, duration_sec: sec, transcript_status: status, finished_late: true };
  const title = `${r.raw.direction === "inbound" ? "Inbound" : "Outbound"} call · ${outcome.replace("_", " ")}`;
  return (await one<RecordingRow>(c, "update recordings set raw=$2, ended_at=$3, duration_min=$4, title=$5 where id=$1 returning *", [r.id, raw, new Date(r.started_at.getTime() + sec * 1000), Math.round(sec / 60), title]))!;
}
export const pendingPhoneCalls = (c: PoolClient, companyId: string, limit = 100) => many<RecordingRow>(c, "select * from recordings where company_id=$1 and provider='ghl' and raw->>'transcript_status'='pending' order by started_at limit $2", [companyId, limit]);

export const unlinkedRecordings = (c: PoolClient, companyId: string) => many<RecordingRow>(c, "select * from recordings where company_id=$1 and link_status='unlinked' order by started_at desc", [companyId]);
