import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { asOperator, many, one } from "@/db/client";
import { bookingFor, type Adapters, type AppointmentSnapshot, type Company, type ContactSnapshot, type MessageSnapshot } from "@/adapters/types";
import { loadCompany, type CompanyRow } from "./context";
import { dispatchEvent, emitEvent } from "./dispatch";
import { ensureOpportunityForBooking, ensureUser, userIdByEmail } from "./lifecycle";
import { simTag, simulate } from "./simulate";
import { pendingPhoneCalls, phoneFacts, recordPhoneCall, settlePhoneCall, TRANSCRIPT_WAIT_MIN, type RecordingRow } from "./recordings";
import { applyDocument, facts as agreementFacts } from "./agreements";
import { foldCard } from "./cards";
import { handMoved } from "./card-moves";

export type PollReport = { companies: number; contacts: number; appointmentsNew: number; appointmentsChanged: number; inbound: number; calls: number; agreements: number; cardsMoved: number; eventsDispatched: number; baselined: number; errors: { company: string; entity: string; error: string }[] };

// US/CA: ten digits, or eleven with a leading 1, with or without the plus, are one number; any other length stays as typed
const normPhone = (p?: string) => p ? p.replace(/[^\d+]/g, "").replace(/^\+?1?(\d{10})$/, "+1$1") : undefined;
const normEmail = (e?: string) => e?.trim().toLowerCase() || undefined;
/** As typed (case, hyphens, apostrophes), minus surrounding and doubled spaces; blank is null so a template's `default:` can speak. */
const normName = (n?: string | null) => n?.trim().replace(/\s+/g, " ") || null;
/** A zone the CRM or a booking sent that Luxon cannot use is no zone at all (the company's stands in). */
const validZone = (tz?: string | null) => (tz && DateTime.now().setZone(tz).isValid ? tz : undefined);

/**
 * The FIRST poll of an entity is a silent baseline: it fills the replica and emits NOTHING. Otherwise installing a
 * company with 480 existing contacts would dispatch 480 lead.created events into speed-to-lead. Only deltas after the
 * baseline are events. `isBaseline` is true when no cursor row exists yet.
 */
async function cursor(c: PoolClient, companyId: string, entity: string, fallback: DateTime): Promise<{ since: DateTime; isBaseline: boolean }> {
  const r = await one<{ cursor: string }>(c, "select cursor from poll_cursors where company_id=$1 and entity=$2", [companyId, entity]);
  const parsed = r?.cursor ? DateTime.fromISO(r.cursor) : undefined;
  return parsed?.isValid ? { since: parsed, isBaseline: false } : { since: fallback, isBaseline: true };   // no row, or an unusable cursor → still baseline
}
async function saveCursor(c: PoolClient, companyId: string, entity: string, value: string, ok: boolean) {
  if (!ok) {   // a failure never creates a row (that would end the baseline before it happened); it only counts against an existing one
    await c.query("update poll_cursors set last_polled_at=now(), consecutive_failures=consecutive_failures+1 where company_id=$1 and entity=$2", [companyId, entity]);
    return;
  }
  await c.query(`insert into poll_cursors (company_id, entity, cursor, last_polled_at, last_success_at, consecutive_failures) values ($1,$2,$3,now(),now(),0)
    on conflict (company_id, entity) do update set cursor=$3, last_polled_at=now(), last_success_at=now(), consecutive_failures=0`, [companyId, entity, value]);
}

/** Upserts a contact replica + identifiers; returns our id and whether it was new. */
export async function upsertContact(c: PoolClient, companyId: string, companyTz: string, s: ContactSnapshot, keepFields?: Set<string>): Promise<{ id: string; isNew: boolean; rejoined: boolean; prevTags: string[] }> {
  // D29: the replica keeps only the custom fields a binding names (crm.field_contact_*); a sub-account can carry hundreds, and form answers live as one JSON on the contact instead
  if (keepFields) s = { ...s, customFields: Object.fromEntries(Object.entries(s.customFields).filter(([id]) => keepFields.has(id))) };
  const existing = await one<{ id: string; tags: string[] }>(c, "select id, tags from contacts where company_id=$1 and ghl_contact_id=$2", [companyId, s.id]);
  const email = normEmail(s.email), phone = normPhone(s.phone), zone = validZone(s.timezone);
  const firstName = normName(s.firstName), lastName = normName(s.lastName);
  let id = existing?.id, matched = false;
  if (!id) {
    // identity resolution: an email/phone we've already seen (and still current, G15) means this is the same person's
    // history. The record the CRM is delivering now is the truth and becomes the primary id writes go to (D65). It is
    // still a new lead: the CRM made a new contact, and that is the fact the workflows answer to (D65 addendum).
    const match = await one<{ contact_id: string }>(c, `select i.contact_id from contact_identifiers i where i.company_id=$1 and i.retired_at is null and ((i.kind='email' and i.value=$2) or (i.kind='phone' and i.value=$3)) limit 1`, [companyId, email ?? "", phone ?? ""]);
    if (match) { id = match.contact_id; matched = true; await c.query("update contacts set ghl_contact_id=$2, gone_at=null where id=$1", [id, s.id]); }
  }
  const tz = zone ?? companyTz;
  if (!id) {
    const row = await one<{ id: string }>(c, `insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone, timezone_source, tags, ghl_fields, ghl_updated_at, ghl_added_at, assigned_ghl_user_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`, [companyId, s.id, firstName, lastName, tz, zone ? "ghl" : "company_default", s.tags, s.customFields, s.dateUpdated, s.dateAdded ?? null, s.assignedTo ?? null]);
    id = row!.id;
  } else {
    await c.query("update contacts set first_name=coalesce($2,first_name), last_name=coalesce($3,last_name), timezone=coalesce($4,timezone), tags=$5, ghl_fields=$6, ghl_updated_at=$7, ghl_added_at=coalesce(ghl_added_at,$8), ghl_contact_id=coalesce(ghl_contact_id,$9), assigned_ghl_user_id=$10, gone_at=null, updated_at=now() where id=$1", [id, firstName, lastName, zone ?? null, s.tags, s.customFields, s.dateUpdated, s.dateAdded ?? null, s.id, s.assignedTo ?? null]);
    // G15: this CRM record's own number or email changed; the old one no longer names this person. Retired, not deleted (the
    // history stays readable), and never matched again, so a recycled number is a stranger, not this person
    for (const [kind, value] of [["email", email], ["phone", phone]] as const)
      if (value) await c.query("update contact_identifiers set retired_at=now() where company_id=$1 and contact_id=$2 and kind=$3 and value<>$4 and retired_at is null", [companyId, id, kind, value]);
  }
  for (const [kind, value] of [["ghl_contact", s.id], ["email", email], ["phone", phone]] as const)
    if (value) await attachIdentifier(c, companyId, id, kind, value);
  return { id, isNew: !existing, rejoined: matched, prevTags: existing?.tags ?? [] };
}

/** Attaches an identifier; one the CRM had retired from someone (a recycled number) moves to the person who carries it now. A current identifier of another person is left alone. */
async function attachIdentifier(c: PoolClient, companyId: string, contactId: string, kind: "ghl_contact" | "email" | "phone", value: string) {
  await c.query(`insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,$3,$4)
    on conflict (company_id, kind, value) do update set contact_id=excluded.contact_id, retired_at=null, created_at=now() where contact_identifiers.retired_at is not null`, [companyId, contactId, kind, value]);
}

/** The custom-field ids the company's bindings name: the only ones the replica keeps. */
export const boundFieldIds = (bindings: Record<string, string>) => new Set(Object.entries(bindings).filter(([k]) => k.startsWith("crm.field_contact_")).map(([, v]) => v));

async function pollContacts(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, rep: PollReport, bindings: Record<string, string>) {
  const { since, isBaseline } = await cursor(c, co.id, "contacts", DateTime.now().minus({ days: 7 }));
  const rows = await adapters.read.contactsChangedSince(ac, since.toISO()!);
  let max = since;
  const keep = boundFieldIds(bindings);
  for (const s of rows) {
    const { id, isNew, prevTags } = await upsertContact(c, co.id, co.timezone, s, keep);
    rep.contacts++;
    const u = DateTime.fromISO(s.dateUpdated); if (u > max) max = u;
    if (isBaseline) { rep.baselined++; continue; }
    const ctx = { contact: { id, ghl_contact_id: s.id, tags: s.tags } };
    if (isNew) rep.eventsDispatched += (await dispatchEvent(c, await emitEvent(c, { company_id: co.id, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: { ghl_contact_id: s.id } }), ctx)).length;
    for (const t of s.tags.filter((t) => !prevTags.includes(t))) {
      // a sys-test-<action> tag is an instruction to the harness, not a fact about the person: it never becomes a tag.added event
      const sim = simTag(t);
      if (sim) { const r = await simulate({ c, company: co, contactId: id }, sim); if (r.ok) rep.eventsDispatched += r.runsStarted; await emitEvent(c, { company_id: co.id, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "run.exited", source: "test", data: { harness: sim, ...(r.ok ? { detail: r.detail, runs_started: r.runsStarted } : { refused: r.why }) } }); continue; }
      rep.eventsDispatched += (await dispatchEvent(c, await emitEvent(c, { company_id: co.id, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "ghl_poll", data: { tag: t } }), ctx)).length;
    }
    for (const t of prevTags.filter((t) => !s.tags.includes(t))) rep.eventsDispatched += (await dispatchEvent(c, await emitEvent(c, { company_id: co.id, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "tag.removed", source: "ghl_poll", data: { tag: t } }), ctx)).length;
  }
  await saveCursor(c, co.id, "contacts", max.toISO()!, true);
}

/** A booking whose source is not the CRM names the person, not a CRM id. Find them by email/phone; otherwise hold a local replica until the CRM poll sees them and attaches the ghl_contact_id (identity resolution in upsertContact). */
async function resolveContactForBooking(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, s: AppointmentSnapshot): Promise<{ id: string; lead?: { ghlContactId: string; tags: string[] } } | null> {
  if (s.contactId) {
    const byId = await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id=$2", [co.id, s.contactId]);
    if (byId) return byId;
    const live = await adapters.read.getContact(ac, s.contactId);
    if (!live) return null;
    // G16: a person whose first appearance is their booking is a new lead here and now; the contacts poll will see an existing row
    const up = await upsertContact(c, co.id, co.timezone, live);
    return { id: up.id, lead: up.isNew ? { ghlContactId: live.id, tags: live.tags } : undefined };
  }
  const inv = s.invitee; if (!inv) return null;
  const email = normEmail(inv.email), phone = normPhone(inv.phone), zone = validZone(inv.timezone);
  if (!email && !phone) return null;
  const match = await one<{ contact_id: string }>(c, `select contact_id from contact_identifiers where company_id=$1 and retired_at is null and ((kind='email' and value=$2) or (kind='phone' and value=$3)) limit 1`, [co.id, email ?? "", phone ?? ""]);
  if (match) {
    if (zone) await c.query("update contacts set timezone=$2, timezone_source='booking', updated_at=now() where id=$1 and timezone_source is distinct from 'ghl'", [match.contact_id, zone]);
    return { id: match.contact_id };
  }
  const row = await one<{ id: string }>(c, `insert into contacts (company_id, first_name, last_name, timezone, timezone_source) values ($1,$2,$3,$4,$5) returning id`,
    [co.id, normName(inv.firstName), normName(inv.lastName), zone ?? co.timezone, zone ? "booking" : "company_default"]);
  for (const [kind, value] of [["email", email], ["phone", phone]] as const)
    if (value) await attachIdentifier(c, co.id, row!.id, kind, value);
  return { id: row!.id };
}

/**
 * Setter or self-booked is decided by the company's rule (D24), because offers differ:
 *   calendar  — the calendar says (a separate setter event type / calendar)                      [default]
 *   question  — the booking question names the setter; no name → self-booked (one calendar for both)
 *   either    — setter-booked if the calendar is a setter calendar OR a setter was named
 */
export function decideSelfBooked(rule: string | undefined, calendarSelfBooked: boolean | null, setBy: string | undefined | null, perCalendar?: "self" | "setter" | "question"): boolean | null {
  const named = !!(setBy && setBy.trim());
  // the calendar's own rule wins over the company default
  if (perCalendar === "self") return true;
  if (perCalendar === "setter") return false;
  if (perCalendar === "question") return !named;
  switch (rule) {
    case "question": return !named;
    case "either": return calendarSelfBooked === false || named ? false : calendarSelfBooked === true ? true : !named;
    default: return calendarSelfBooked;
  }
}

export async function applyAppointment(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, s: AppointmentSnapshot, rep?: PollReport, baseline = false): Promise<void> {
  const source = ac.booking.source;
  const calRow = await one<{ id: string; appointment_term: string; self_booked: boolean | null; config: { booking?: "self" | "setter" | "question" } }>(c, "select id, appointment_term, self_booked, config from calendars where company_id=$1 and source=$2 and external_id=$3", [co.id, source, s.calendarId]);
  if (!calRow) return;
  const rule = (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='booking.setter_rule'", [co.id]))?.value.toString("utf8");
  const cal = { ...calRow, self_booked: decideSelfBooked(rule, calRow.self_booked, s.setBy, calRow.config?.booking) };
  // a cancelled booking that was rescheduled is carried by its replacement (same appointment, new time); nothing to do here
  if (s.rescheduledTo) return;
  const contact = await resolveContactForBooking(c, co, ac, adapters, s);
  if (!contact) return;
  const userId = s.assignedUserId ? await ensureUser(c, adapters, ac, s.assignedUserId) : await userIdByEmail(c, co.id, s.assignedUserEmail);
  const find = (ext: string) => one<{ id: string; status: string; starts_at: Date; external_id: string }>(c, "select id, status, starts_at, external_id from appointments where company_id=$1 and source=$2 and external_id=$3", [co.id, source, ext]);
  let existing = await find(s.id);
  if (!existing && s.rescheduledFrom) {
    // the source cancelled the old booking and created this one; to us it is the same appointment moved
    const prior = await find(s.rescheduledFrom);
    if (prior) { await c.query("update appointments set external_id=$2, reschedule_url=coalesce($3, reschedule_url), cancel_url=coalesce($4, cancel_url) where id=$1", [prior.id, s.id, s.rescheduleUrl ?? null, s.cancelUrl ?? null]); existing = { ...prior, external_id: s.id }; }
  }
  if (!existing) {
    const row = await one<{ id: string }>(c, `insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, self_booked, set_by, answers, reschedule_url, cancel_url, tracking, booked_at, status, source_updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`, [co.id, contact.id, source, s.id, cal.id, cal.appointment_term, userId, s.startTime, s.endTime, cal.self_booked, s.setBy ?? null, JSON.stringify(s.answers ?? {}), s.rescheduleUrl ?? null, s.cancelUrl ?? null, s.tracking ?? {}, s.dateAdded ?? new Date(), s.status, s.dateUpdated ?? null]);
    if (baseline) { if (rep) rep.baselined++; return; }   // replica only; an appointment that existed before install is not a new booking
    if (contact.lead) {   // the booking brought a new person: lead.created first (New lead, Speed to lead), the same shape the contacts poll emits, then the booking
      const started = await dispatchEvent(c, await emitEvent(c, { company_id: co.id, contact_id: contact.id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: { ghl_contact_id: contact.lead.ghlContactId } }), { contact: { id: contact.id, ghl_contact_id: contact.lead.ghlContactId, tags: contact.lead.tags } });
      if (rep) rep.eventsDispatched += started.length;
    }
    const ev = await emitEvent(c, { company_id: co.id, contact_id: contact.id, opportunity_id: null, appointment_id: row!.id, event_type: "appointment.booked", source: "ghl_poll", data: { source, calendar_id: s.calendarId, status: s.status, starts_at: s.startTime, self_booked: cal.self_booked } });
    const oppId = await ensureOpportunityForBooking(c, co.id, contact.id, row!.id, ev);
    const term = await one<{ name: string; category: string }>(c, "select name, category from company_terms where id=$1", [cal.appointment_term]);
    const ctx = { contact: { id: contact.id }, appointment: { id: row!.id, starts_at: s.startTime, term, status: s.status, self_booked: cal.self_booked, set_by: s.setBy ?? null }, opportunity: { id: oppId } };
    const started = await dispatchEvent(c, { ...ev, opportunity_id: oppId || null }, ctx);
    if (rep) { rep.appointmentsNew++; rep.eventsDispatched += started.length; }
    return;
  }
  const changes: Record<string, unknown> = {};
  if (existing.status !== s.status) changes.status = { from: existing.status, to: s.status };
  if (Math.abs(existing.starts_at.getTime() - new Date(s.startTime).getTime()) > 60e3) changes.starts_at = { from: existing.starts_at.toISOString(), to: s.startTime };
  if (!Object.keys(changes).length) return;
  if (baseline) { await c.query("update appointments set status=$2, starts_at=$3, ends_at=$4, source_updated_at=$5 where id=$1", [existing.id, s.status, s.startTime, s.endTime, s.dateUpdated ?? new Date()]); if (rep) rep.baselined++; return; }
  await c.query("update appointments set status=$2, starts_at=$3, ends_at=$4, assigned_user_id=coalesce($5,assigned_user_id), source_updated_at=$6, cancelled_by=coalesce($7,cancelled_by), cancel_reason=coalesce($8,cancel_reason) where id=$1",
    [existing.id, s.status, s.startTime, s.endTime, userId, s.dateUpdated ?? new Date(), s.cancellation?.by ?? null, s.cancellation?.reason ?? null]);
  const type = changes.starts_at ? "appointment.rescheduled" : "appointment.status_changed";
  // runs parked on this appointment wake now: a wait anchored to it recomputes from the new start, and a run whose premise
  // no longer holds (reminder for a cancelled call) exits moot immediately instead of at its old wake time
  await c.query("update runs set next_run_at=now() where company_id=$1 and appointment_id=$2 and status='waiting'", [co.id, existing.id]);
  const ev = await emitEvent(c, { company_id: co.id, contact_id: contact.id, opportunity_id: null, appointment_id: existing.id, event_type: type, source: "ghl_poll", data: { source, ...changes, ...(s.cancellation ? { cancelled_by: s.cancellation.by, cancel_reason: s.cancellation.reason } : {}) } });
  const term = await one<{ name: string; category: string }>(c, "select name, category from company_terms where id=$1", [cal.appointment_term]);
  const started = await dispatchEvent(c, ev, { contact: { id: contact.id }, appointment: { id: existing.id, starts_at: s.startTime, status: s.status, term, self_booked: cal.self_booked } });
  if (rep) { rep.appointmentsChanged++; rep.eventsDispatched += started.length; }
}

async function pollCalendar(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, rep: PollReport, calendarId: string) {
  const entity = `appointments:${calendarId}`;
  const from = DateTime.now().minus({ days: 2 }).toJSDate(), to = DateTime.now().plus({ days: 60 }).toJSDate();
  const { isBaseline } = await cursor(c, co.id, entity, DateTime.now());
  for (const s of await bookingFor(adapters, ac).appointmentsInWindow(ac, calendarId, from, to)) await applyAppointment(c, co, ac, adapters, s, rep, isBaseline);
  await saveCursor(c, co.id, entity, DateTime.now().toISO()!, true);
}

async function pollInbound(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, rep: PollReport) {
  const { since, isBaseline } = await cursor(c, co.id, "conversations", DateTime.now().minus({ hours: 24 }));
  const msgs = await adapters.read.inboundSince(ac, since.toISO()!);
  let max = since;
  for (const m of msgs) {
    // G14: the sender may be a duplicate CRM record folded into one person; those ids live as ghl_contact identifiers, the primary on the row
    let contact = await one<{ id: string }>(c, `select contact_id as id from contact_identifiers where company_id=$1 and kind='ghl_contact' and value=$2 and retired_at is null
      union all select id from contacts where company_id=$1 and ghl_contact_id=$2 limit 1`, [co.id, m.contactId]);
    if (!contact && m.channel === "call") {   // a call to a brand-new lead can land before the contacts poll has them; the call is a fact worth keeping, so fetch the person now
      const live = await adapters.read.getContact(ac, m.contactId);
      if (live) contact = { id: (await upsertContact(c, co.id, co.timezone, live)).id };
    }
    if (!contact) continue;
    if (m.channel === "call") { await applyCall(c, co, ac, adapters, m, contact.id, isBaseline, rep); const d = DateTime.fromISO(m.dateAdded); if (d > max) max = d; continue; }
    // D38: the hub is not the CRM. Only a reply is kept (the wait-for-reply step reads it for a few hours), never the outbound side or a human's messages; retention drops the reply later.
    if (m.direction !== "inbound") { const d = DateTime.fromISO(m.dateAdded); if (d > max) max = d; continue; }
    const ins = await one<{ id: string }>(c, `insert into messages (company_id, contact_id, ghl_message_id, ghl_conversation_id, channel, direction, body, subject, sent_by, status, occurred_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (company_id, ghl_message_id) do nothing returning id`,
      [co.id, contact.id, m.id, m.conversationId, m.channel, m.direction, m.body ?? null, m.subject ?? null, m.direction === "inbound" ? null : "other", m.status ?? null, m.dateAdded]);
    if (ins && m.direction === "inbound" && !isBaseline) {
      rep.inbound++;
      const ev = await emitEvent(c, { company_id: co.id, contact_id: contact.id, opportunity_id: null, appointment_id: null, event_type: "message.received", source: "ghl_poll", data: { channel: m.channel, message_id: m.id, body: m.channel === "sms" ? m.body : undefined }, occurred_at: new Date(m.dateAdded) });
      rep.eventsDispatched += (await dispatchEvent(c, ev, { contact: { id: contact.id } })).length;
      // only runs parked on wait_for_reply wake; a reminder waiting for 8am must not fire because the contact texted about something else
      await c.query("update runs set next_run_at=now() where company_id=$1 and contact_id=$2 and status='waiting' and wake_on_reply", [co.id, contact.id]);
    }
    const d = DateTime.fromISO(m.dateAdded); if (d > max) max = d;
  }
  await saveCursor(c, co.id, "conversations", max.toISO()!, true);
}

/** A call entry in the thread → a ledger row. Connected calls wait for their transcript (settled here if it is already there, else by pollPendingCalls); the rest settle at once. */
async function applyCall(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, m: MessageSnapshot, contactId: string, isBaseline: boolean, rep: PollReport) {
  const call = m.call ?? { status: m.status ?? "" };
  if (call.userId) await ensureUser(c, adapters, ac, call.userId);
  const { recording, isNew } = await recordPhoneCall(c, co.id, { externalId: m.id, contactId, startedAt: new Date(m.dateAdded), durationSec: call.durationSec ?? 0, direction: m.direction, status: call.status, callerGhlUserId: call.userId,
    conversationUrl: `https://app.gohighlevel.com/v2/location/${ac.locationId}/conversations/conversations/${m.contactId}` });
  if (!isNew) return;
  rep.calls++;
  if (recording.raw.transcript_status === "pending") {
    const media = await adapters.read.callMedia(ac, m.id);
    if (!media?.transcript && !isBaseline) return;   // stays pending; the calls poll settles it when the transcript lands or the wait runs out
    await settleCall(c, recording, media, contactId, isBaseline, rep);
  } else await settleCall(c, recording, null, contactId, isBaseline, rep);
}
async function settleCall(c: PoolClient, r: RecordingRow, media: Awaited<ReturnType<Adapters["read"]["callMedia"]>>, contactId: string, silent: boolean, rep: PollReport) {
  const { recording, event } = await settlePhoneCall(c, r, media, { silent });
  if (event) rep.eventsDispatched += (await dispatchEvent(c, event, { contact: { id: contactId }, recording: { id: recording.id, ...phoneFacts(recording) } })).length;
}
/** Connected calls still waiting for a transcript: re-read each tick, settle on a transcript or once the wait has run out. */
async function pollPendingCalls(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, rep: PollReport) {
  for (const r of await pendingPhoneCalls(c, co.id)) {
    const media = await adapters.read.callMedia(ac, r.external_id);
    const expired = Date.now() - r.started_at.getTime() > TRANSCRIPT_WAIT_MIN * 60e3;
    if (!media?.transcript && !expired) continue;
    await settleCall(c, r, media, r.contact_id!, false, rep);
  }
}

/** Documents & Contracts (D30): every document the location sent, mirrored; new → agreement.sent, first completion → agreement.signed. The first pass is a silent baseline. */
async function pollAgreements(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, rep: PollReport) {
  const { isBaseline } = await cursor(c, co.id, "agreements", DateTime.now());
  for (const d of await adapters.read.documents(ac)) {
    const contact = d.contactId ? await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id=$2", [co.id, d.contactId]) : null;
    const { row, events } = await applyDocument(c, co.id, d, contact?.id ?? null, { silent: isBaseline });
    for (const ev of events) { rep.agreements++; rep.eventsDispatched += (await dispatchEvent(c, ev, { contact: { id: row.contact_id }, agreement: agreementFacts(row) })).length; }
  }
  await saveCursor(c, co.id, "agreements", DateTime.now().toISO()!, true);
}

/**
 * D61: every card on the bound boards (setter, closer), any status, diffed against `pipeline_cards`. A stage or status
 * the engine did not write, with a CRM stamp newer than our last write, is a hand on a card: `handMoved` records it
 * (event, thread line, the outcome it names). Cards of people the engine does not know yet are left for the contacts
 * poll to bring first. The first pass is a silent baseline: the replica takes the CRM's state and nothing is said.
 * The CRM's search cannot filter by updated time, so each tick reads the boards whole (paged; see `pipelineCards`).
 */
export async function pollCards(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, rep: PollReport, bindings: Record<string, string>) {
  const boards = ["crm.pipeline_setter", "crm.pipeline_closer"].map((k) => bindings[k]).filter((v): v is string => !!v);
  if (!boards.length) return;
  const { isBaseline } = await cursor(c, co.id, "cards", DateTime.now());
  for (const pipelineId of boards) {
    for (const card of await adapters.read.pipelineCards(ac, pipelineId)) {
      if (!card.contactId) continue;
      const contact = await one<{ id: string }>(c, `select contact_id as id from contact_identifiers where company_id=$1 and kind='ghl_contact' and value=$2 and retired_at is null
        union all select id from contacts where company_id=$1 and ghl_contact_id=$2 limit 1`, [co.id, card.contactId]);
      if (!contact) continue;
      const move = await foldCard(c, co.id, contact.id, card);
      if (!move) continue;
      if (isBaseline) { rep.baselined++; continue; }
      await handMoved(c, co.id, adapters, move); rep.cardsMoved++;
    }
  }
  await saveCursor(c, co.id, "cards", DateTime.now().toISO()!, true);
}

type EntityPoll = (c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, rep: PollReport, bindings: Record<string, string>) => Promise<void>;

/**
 * One transaction PER ENTITY. A SQL error aborts the whole Postgres transaction, so catching inside it and running
 * more statements only yields "current transaction is aborted" and loses the entities that had succeeded. Each entity
 * commits or rolls back on its own; the failure counter is written afterwards in a fresh transaction.
 */
export async function pollAll(adapters: Adapters): Promise<PollReport> {
  const rep: PollReport = { companies: 0, contacts: 0, appointmentsNew: 0, appointmentsChanged: 0, inbound: 0, calls: 0, agreements: 0, cardsMoved: 0, eventsDispatched: 0, baselined: 0, errors: [] };
  const companies = await asOperator((c) => many<{ id: string }>(c, "select id from companies where status in ('active','hosted')"));
  for (const { id } of companies) {
    rep.companies++;
    let loaded: Awaited<ReturnType<typeof loadCompany>>;
    try { loaded = await asOperator((c) => loadCompany(c, id)); }
    catch (e) { rep.errors.push({ company: id, entity: "bindings", error: `cannot load bindings: ${(e as Error).message}` }); continue; }   // one bad key must not stop every other company
    const { row: co, adapterCompany: ac, bindings } = loaded;
    if (!ac.pit || !ac.locationId) { rep.errors.push({ company: co.slug, entity: "bindings", error: "crm.location_id / secret.ghl_pit not bound" }); continue; }
    const cals = await asOperator((c) => many<{ external_id: string }>(c, "select external_id from calendars where company_id=$1 and source=$2 and active", [co.id, ac.booking.source]));
    const entities: [string, EntityPoll][] = [
      ["contacts", pollContacts],
      ...cals.map((cal): [string, EntityPoll] => [`appointments:${cal.external_id}`, (c, co, ac, adapters, rep) => pollCalendar(c, co, ac, adapters, rep, cal.external_id)]),
      ["conversations", pollInbound],
      ["calls", pollPendingCalls],
      ["agreements", pollAgreements],
      ["cards", pollCards],
    ];
    for (const [entity, fn] of entities) {
      const before = { ...rep };
      try { await asOperator((c) => fn(c, co, ac, adapters, rep, bindings)); }
      catch (e) {
        Object.assign(rep, before, { errors: rep.errors });   // the transaction rolled back; the report must not count what it undid
        rep.errors.push({ company: co.slug, entity, error: String((e as Error).message) });
        await asOperator((c) => saveCursor(c, co.id, entity, "", false)).catch(() => {});
      }
    }
  }
  return rep;
}
