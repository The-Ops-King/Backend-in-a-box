import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { emitEvent, type EventRow } from "./dispatch";
import { normEmail } from "./payments";

/**
 * Call recordings (D22). Same shape as the payments ledger: every recording the provider reports becomes a row, linked
 * to a person or not. The ladder, most reliable first: an invitee email on a known contact; an invitee name that matches
 * exactly one contact; the closer's own calendar (the recorder is a user we know, and they had one appointment within
 * two hours of the recording start). One unambiguous hit or nothing. A miss is an unlinked row the team fixes by hand.
 */
export type RecordingInput = {
  provider?: string; externalId: string;
  title?: string; startedAt: Date; endedAt?: Date; durationMin?: number;
  url?: string; shareUrl?: string;
  recordedBy?: { name?: string; email?: string };
  invitees: { name?: string; email?: string; isExternal?: boolean }[];
  transcript?: { speaker: string; email?: string; text: string; timestamp?: string }[];
  summary?: string;
  raw?: Record<string, unknown>;
};
export type RecordingRow = { id: string; company_id: string; contact_id: string | null; appointment_id: string | null; provider: string; external_id: string; title: string | null; started_at: Date; ended_at: Date | null; duration_min: number | null; url: string | null; share_url: string | null; recorded_by_email: string | null; recorded_by_name: string | null; invitees: { name?: string; email?: string; isExternal?: boolean }[]; transcript: { speaker: string; email?: string; text: string; timestamp?: string }[] | null; summary: string | null; analysis: Record<string, unknown>; link_status: string; linked_by: string | null; unlinked_reason: string | null; raw: Record<string, unknown>; received_at: Date };
export type RecordResult =
  | { outcome: "duplicate"; recording: RecordingRow }
  | { outcome: "linked"; recording: RecordingRow; event: EventRow; contactId: string; appointmentId: string | null }
  | { outcome: "unlinked"; recording: RecordingRow; event: EventRow; reason: string };

const CALENDAR_WINDOW_MIN = 120;      // the closer's appointment must start within this of the recording
const APPOINTMENT_WINDOW_H = 24;      // once the person is known, their appointment nearest the recording, if this close

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

export type Match = { contactId: string; by: "email" | "name" | "calendar"; appointmentId?: string };
export async function resolveRecording(c: PoolClient, companyId: string, input: RecordingInput): Promise<{ match: Match | null; reason?: string }> {
  const { emails, names, staffDropped } = await prospectsOnCall(c, companyId, input);
  // 1. email: identities are unique per company, so a hit is exact
  const byEmail = new Set<string>();
  for (const e of emails) { const r = await one<{ contact_id: string }>(c, "select i.contact_id from contact_identifiers i join contacts ct on ct.id=i.contact_id where i.company_id=$1 and i.kind='email' and i.value=$2 and ct.merged_into is null", [companyId, e]); if (r) byEmail.add(r.contact_id); }
  if (byEmail.size === 1) return { match: { contactId: [...byEmail][0], by: "email" } };
  if (byEmail.size > 1) return { match: null, reason: `attendees match ${byEmail.size} different contacts (${emails.join(", ")})` };
  // 2. name: exact after normalisation, exactly one contact
  const byName = new Set<string>();
  for (const n of names.map(normName).filter((x): x is string => !!x)) {
    const rows = await many<{ id: string }>(c, "select id from contacts where company_id=$1 and merged_into is null and lower(regexp_replace(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')), '[^[:alnum:]]+', ' ', 'g'))=$2", [companyId, n]);
    if (rows.length === 1) byName.add(rows[0].id); else if (rows.length > 1) return { match: null, reason: `"${n}" is the name of ${rows.length} contacts` };
  }
  if (byName.size === 1) return { match: { contactId: [...byName][0], by: "name" } };
  if (byName.size > 1) return { match: null, reason: `attendee names match ${byName.size} different contacts` };
  // 3. the closer's calendar: the recorder is a user we know, with one appointment near the recording start
  const closer = input.recordedBy?.email ? await one<{ id: string }>(c, "select id from users where company_id=$1 and lower(email)=$2 and active", [companyId, input.recordedBy.email.toLowerCase()]) : null;
  if (closer) {
    const near = await many<{ id: string; contact_id: string }>(c, `select id, contact_id from appointments where company_id=$1 and assigned_user_id=$2 and status<>'cancelled' and abs(extract(epoch from (starts_at - $3::timestamptz))) <= $4 order by abs(extract(epoch from (starts_at - $3::timestamptz)))`, [companyId, closer.id, input.startedAt, CALENDAR_WINDOW_MIN * 60]);
    if (near.length === 1) return { match: { contactId: near[0].contact_id, by: "calendar", appointmentId: near[0].id } };
    if (near.length > 1) return { match: null, reason: `the closer had ${near.length} appointments within ${CALENDAR_WINDOW_MIN / 60} hours of this recording` };
  }
  const seen = [...emails, ...names].join(", ");
  return { match: null, reason: emails.length || names.length ? `nobody in the CRM matches ${seen}${closer ? "; no appointment on the closer's calendar near the start" : ""}` : staffDropped.length ? `every attendee is staff (${staffDropped.join(", ")})` : "no attendees on the recording" };
}

/** The contact's appointment nearest the recording, within a day; a reschedule means several, and the nearest one is the one held. */
export async function appointmentNear(c: PoolClient, companyId: string, contactId: string, at: Date): Promise<string | null> {
  const r = await one<{ id: string }>(c, `select id from appointments where company_id=$1 and contact_id=$2 and status<>'cancelled' and abs(extract(epoch from (starts_at - $3::timestamptz))) <= $4 order by abs(extract(epoch from (starts_at - $3::timestamptz))) limit 1`, [companyId, contactId, at, APPOINTMENT_WINDOW_H * 3600]);
  return r?.id ?? null;
}

export const eventData = (r: RecordingRow, extra: Record<string, unknown> = {}) => ({ recording_id: r.id, provider: r.provider, external_id: r.external_id, title: r.title, started_at: r.started_at.toISOString(), duration_min: r.duration_min, share_url: r.share_url, recorded_by: r.recorded_by_email, ...extra });

async function settle(c: PoolClient, companyId: string, r: RecordingRow, contactId: string, by: string, appointmentId: string | null): Promise<{ event: EventRow; appointmentId: string | null }> {
  const apptId = appointmentId ?? (await appointmentNear(c, companyId, contactId, r.started_at));
  await c.query("update recordings set contact_id=$2, appointment_id=$3, link_status='linked', linked_by=$4, unlinked_reason=null where id=$1", [r.id, contactId, apptId, by]);
  const appt = apptId ? await one<{ opportunity_id: string | null }>(c, "select opportunity_id from appointments where id=$1", [apptId]) : null;
  const event = await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: appt?.opportunity_id ?? null, appointment_id: apptId, event_type: "recording.received", source: r.provider === "fathom" ? "fathom" : "zapier", occurred_at: r.started_at,
    data: eventData(r, { matched_by: by, appointment_matched: !!apptId }) });
  return { event, appointmentId: apptId };
}

/** Records a provider recording. Idempotent on (provider, recording id). */
export async function recordRecording(c: PoolClient, companyId: string, input: RecordingInput): Promise<RecordResult> {
  const provider = input.provider ?? "fathom";
  const inserted = await one<RecordingRow>(c, `insert into recordings (company_id, provider, external_id, title, started_at, ended_at, duration_min, url, share_url, recorded_by_email, recorded_by_name, invitees, transcript, summary, raw)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict (company_id, provider, external_id) do nothing returning *`,
    [companyId, provider, input.externalId, input.title ?? null, input.startedAt, input.endedAt ?? null, input.durationMin ?? null, input.url ?? null, input.shareUrl ?? null, normEmail(input.recordedBy?.email) ?? null, input.recordedBy?.name ?? null,
      JSON.stringify(input.invitees), input.transcript ? JSON.stringify(input.transcript) : null, input.summary ?? null, input.raw ?? {}]);
  if (!inserted) return { outcome: "duplicate", recording: (await one<RecordingRow>(c, "select * from recordings where company_id=$1 and provider=$2 and external_id=$3", [companyId, provider, input.externalId]))! };
  const { match, reason } = await resolveRecording(c, companyId, input);
  if (match) {
    const { event, appointmentId } = await settle(c, companyId, inserted, match.contactId, match.by, match.appointmentId ?? null);
    return { outcome: "linked", recording: (await one<RecordingRow>(c, "select * from recordings where id=$1", [inserted.id]))!, event, contactId: match.contactId, appointmentId };
  }
  const row = (await one<RecordingRow>(c, "update recordings set unlinked_reason=$2 where id=$1 returning *", [inserted.id, reason ?? null]))!;
  const event = await emitEvent(c, { company_id: companyId, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "recording.unlinked", source: provider === "fathom" ? "fathom" : "zapier", occurred_at: input.startedAt, data: eventData(row, { reason, invitees: input.invitees }) });
  return { outcome: "unlinked", recording: row, event, reason: reason ?? "no match" };
}

/** A person links an orphan from the dashboard. The attendee's email is remembered so the next call from them links on its own. */
export async function linkRecording(c: PoolClient, companyId: string, recordingId: string, contactId: string): Promise<{ event: EventRow; appointmentId: string | null }> {
  const r = await one<RecordingRow>(c, "select * from recordings where company_id=$1 and id=$2", [companyId, recordingId]);
  if (!r) throw new Error("recording not found");
  if (r.link_status === "linked") throw new Error("recording is already linked");
  if (!(await one(c, "select 1 from contacts where company_id=$1 and id=$2", [companyId, contactId]))) throw new Error("contact not found");
  const { emails } = await prospectsOnCall(c, companyId, { invitees: r.invitees, recordedBy: { email: r.recorded_by_email ?? undefined } });
  if (emails.length === 1) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3) on conflict (company_id, kind, value) do nothing", [companyId, contactId, emails[0]]);
  const out = await settle(c, companyId, r, contactId, "manual", null);
  await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: out.event.opportunity_id, appointment_id: out.appointmentId, event_type: "recording.linked", source: "user", data: { recording_id: r.id, by: "manual" } });
  return out;
}

// ---- phone calls (D28) -----------------------------------------------------------------------------------------------
/**
 * A call the CRM's dialer logged is a recording too, and lives in the same ledger: provider 'ghl', the call entry's id as
 * external_id, the contact known outright (the thread names them, so no ladder). What is different is timing: the entry
 * appears the moment the call ends, the transcript minutes later, so a connected call sits `pending` and is settled by a
 * later poll (transcript found, or the wait ran out). Every call is kept, answered or not — connection rate and
 * speed-to-lead are read from this table later. `call.logged` fires once per call, when it settles.
 */
export type PhoneCallInput = { externalId: string; contactId: string; startedAt: Date; durationSec: number; direction: "inbound" | "outbound"; status: string; callerGhlUserId?: string; conversationUrl?: string; raw?: Record<string, unknown> };
/** GHL's dialer vocabulary → ours. Unknown statuses are kept as given so nothing is silently rewritten. */
export const callOutcome = (status: string) => ({ completed: "connected", answered: "connected", "no-answer": "no_answer", noanswer: "no_answer", busy: "busy", failed: "failed", canceled: "failed", cancelled: "failed", voicemail: "voicemail" } as Record<string, string>)[status.toLowerCase()] ?? status.toLowerCase();
export const TRANSCRIPT_WAIT_MIN = 30;   // a connected call with no transcript yet is re-checked for this long, then settles without one

export async function recordPhoneCall(c: PoolClient, companyId: string, input: PhoneCallInput): Promise<{ recording: RecordingRow; isNew: boolean }> {
  const outcome = callOutcome(input.status);
  const connected = outcome === "connected" && input.durationSec > 0;
  const caller = input.callerGhlUserId ? await one<{ name: string; email: string }>(c, "select name, email from users where company_id=$1 and ghl_user_id=$2", [companyId, input.callerGhlUserId]) : null;
  const raw = { ...(input.raw ?? {}), kind: "phone", direction: input.direction, call_status: outcome, call_status_raw: input.status, duration_sec: input.durationSec, caller_ghl_user_id: input.callerGhlUserId ?? null, transcript_status: connected ? "pending" : "none" };
  const inserted = await one<RecordingRow>(c, `insert into recordings (company_id, contact_id, provider, external_id, title, started_at, ended_at, duration_min, share_url, recorded_by_email, recorded_by_name, invitees, link_status, linked_by, raw)
    values ($1,$2,'ghl',$3,$4,$5,$6,$7,$8,$9,$10,'[]','linked','contact',$11) on conflict (company_id, provider, external_id) do nothing returning *`,
    [companyId, input.contactId, input.externalId, `${input.direction === "inbound" ? "Inbound" : "Outbound"} call · ${outcome.replace("_", " ")}`, input.startedAt, new Date(input.startedAt.getTime() + input.durationSec * 1000), Math.round(input.durationSec / 60), input.conversationUrl ?? null,
      caller ? normEmail(caller.email) ?? null : null, caller?.name ?? null, raw]);
  if (inserted) return { recording: inserted, isNew: true };
  return { recording: (await one<RecordingRow>(c, "select * from recordings where company_id=$1 and provider='ghl' and external_id=$2", [companyId, input.externalId]))!, isNew: false };
}

/** Writes the transcript (or the fact there is none) and fires `call.logged` exactly once. `silent` for the baseline poll: the row is kept, nothing is dispatched. */
export async function settlePhoneCall(c: PoolClient, r: RecordingRow, media: { recordingUrl?: string; transcript: RecordingRow["transcript"] | null } | null, opts: { silent?: boolean } = {}): Promise<{ recording: RecordingRow; event: EventRow | null }> {
  const has = !!media?.transcript?.length;
  const raw = { ...r.raw, transcript_status: has ? "ready" : "none", ...(opts.silent ? { baseline: true } : {}) };
  const row = (await one<RecordingRow>(c, "update recordings set transcript=$2, url=coalesce($3, url), raw=$4 where id=$1 returning *", [r.id, has ? JSON.stringify(media!.transcript) : null, media?.recordingUrl ?? null, raw]))!;
  if (opts.silent) return { recording: row, event: null };
  const event = await emitEvent(c, { company_id: r.company_id, contact_id: r.contact_id, opportunity_id: null, appointment_id: null, event_type: "call.logged", source: "ghl_poll", occurred_at: r.started_at, data: eventData(row, phoneFacts(row)) });
  return { recording: row, event };
}
/** The call as a trigger sees it (`{{recording.*}}` in a match), the same fields context.ts exposes to the run. */
export const phoneFacts = (r: RecordingRow) => { const raw = r.raw as Record<string, unknown>; return { kind: "phone", direction: raw.direction, status: raw.call_status, connected: raw.call_status === "connected", duration_sec: raw.duration_sec, has_transcript: !!r.transcript?.length, caller: r.recorded_by_name }; };
export const pendingPhoneCalls = (c: PoolClient, companyId: string, limit = 20) => many<RecordingRow>(c, "select * from recordings where company_id=$1 and provider='ghl' and raw->>'transcript_status'='pending' order by started_at limit $2", [companyId, limit]);

export const unlinkedRecordings = (c: PoolClient, companyId: string) => many<RecordingRow>(c, "select * from recordings where company_id=$1 and link_status='unlinked' order by started_at desc", [companyId]);
