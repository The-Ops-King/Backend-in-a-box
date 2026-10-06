import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { asOperator, many, one } from "@/db/client";
import type { Adapters, AppointmentSnapshot, Company, ContactSnapshot } from "@/adapters/types";
import { loadCompany, type CompanyRow } from "./context";
import { dispatchEvent, emitEvent } from "./dispatch";
import { ensureOpportunityForBooking, ensureUser } from "./lifecycle";

export type PollReport = { companies: number; contacts: number; appointmentsNew: number; appointmentsChanged: number; inbound: number; eventsDispatched: number; errors: { company: string; entity: string; error: string }[] };

const normPhone = (p?: string) => p ? p.replace(/[^\d+]/g, "").replace(/^(\d{10})$/, "+1$1") : undefined;
const normEmail = (e?: string) => e?.trim().toLowerCase() || undefined;

async function cursor(c: PoolClient, companyId: string, entity: string, fallback: DateTime): Promise<DateTime> {
  const r = await one<{ cursor: string }>(c, "select cursor from poll_cursors where company_id=$1 and entity=$2", [companyId, entity]);
  return r ? DateTime.fromISO(r.cursor) : fallback;
}
async function saveCursor(c: PoolClient, companyId: string, entity: string, value: string, ok: boolean) {
  await c.query(`insert into poll_cursors (company_id, entity, cursor, last_polled_at, last_success_at, consecutive_failures) values ($1,$2,$3,now(),case when $4 then now() end,case when $4 then 0 else 1 end)
    on conflict (company_id, entity) do update set cursor=case when $4 then $3 else poll_cursors.cursor end, last_polled_at=now(),
      last_success_at=case when $4 then now() else poll_cursors.last_success_at end, consecutive_failures=case when $4 then 0 else poll_cursors.consecutive_failures+1 end`, [companyId, entity, value, ok]);
}

/** Upserts a contact replica + identifiers; returns our id and whether it was new. */
export async function upsertContact(c: PoolClient, companyId: string, companyTz: string, s: ContactSnapshot): Promise<{ id: string; isNew: boolean; prevTags: string[] }> {
  const existing = await one<{ id: string; tags: string[] }>(c, "select id, tags from contacts where company_id=$1 and ghl_contact_id=$2", [companyId, s.id]);
  let id = existing?.id;
  if (!id) {
    // identity resolution: an email/phone we've already seen means this is the same person
    const match = await one<{ contact_id: string }>(c, `select contact_id from contact_identifiers where company_id=$1 and ((kind='email' and value=$2) or (kind='phone' and value=$3)) limit 1`, [companyId, normEmail(s.email) ?? "", normPhone(s.phone) ?? ""]);
    if (match) { id = match.contact_id; await c.query("update contacts set ghl_contact_id=$2 where id=$1 and ghl_contact_id is null", [id, s.id]); }
  }
  const tz = s.timezone ?? companyTz;
  if (!id) {
    const row = await one<{ id: string }>(c, `insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone, timezone_source, tags, ghl_fields, ghl_updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [companyId, s.id, s.firstName ?? null, s.lastName ?? null, tz, s.timezone ? "ghl" : "company_default", s.tags, s.customFields, s.dateUpdated]);
    id = row!.id;
  } else {
    await c.query("update contacts set first_name=coalesce($2,first_name), last_name=coalesce($3,last_name), timezone=coalesce($4,timezone), tags=$5, ghl_fields=$6, ghl_updated_at=$7, updated_at=now() where id=$1", [id, s.firstName ?? null, s.lastName ?? null, s.timezone ?? null, s.tags, s.customFields, s.dateUpdated]);
  }
  for (const [kind, value] of [["ghl_contact", s.id], ["email", normEmail(s.email)], ["phone", normPhone(s.phone)]] as const)
    if (value) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,$3,$4) on conflict (company_id, kind, value) do nothing", [companyId, id, kind, value]);
  return { id, isNew: !existing, prevTags: existing?.tags ?? [] };
}

async function pollContacts(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, rep: PollReport) {
  const since = await cursor(c, co.id, "contacts", DateTime.now().minus({ days: 7 }));
  const rows = await adapters.read.contactsChangedSince(ac, since.toISO()!);
  let max = since;
  for (const s of rows) {
    const { id, isNew, prevTags } = await upsertContact(c, co.id, co.timezone, s);
    rep.contacts++;
    const ctx = { contact: { id, ghl_contact_id: s.id, tags: s.tags } };
    if (isNew) rep.eventsDispatched += (await dispatchEvent(c, await emitEvent(c, { company_id: co.id, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: { ghl_contact_id: s.id } }), ctx)).length;
    for (const t of s.tags.filter((t) => !prevTags.includes(t))) rep.eventsDispatched += (await dispatchEvent(c, await emitEvent(c, { company_id: co.id, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "ghl_poll", data: { tag: t } }), ctx)).length;
    for (const t of prevTags.filter((t) => !s.tags.includes(t))) rep.eventsDispatched += (await dispatchEvent(c, await emitEvent(c, { company_id: co.id, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "tag.removed", source: "ghl_poll", data: { tag: t } }), ctx)).length;
    const u = DateTime.fromISO(s.dateUpdated); if (u > max) max = u;
  }
  await saveCursor(c, co.id, "contacts", max.toISO()!, true);
}

export async function applyAppointment(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, s: AppointmentSnapshot, rep?: PollReport): Promise<void> {
  const cal = await one<{ id: string; appointment_term: string }>(c, "select id, appointment_term from calendars where company_id=$1 and ghl_calendar_id=$2", [co.id, s.calendarId]);
  if (!cal) return;
  let contact = await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id=$2", [co.id, s.contactId]);
  if (!contact) { const live = await adapters.read.getContact(ac, s.contactId); if (!live) return; contact = { id: (await upsertContact(c, co.id, co.timezone, live)).id }; }
  const userId = s.assignedUserId ? await ensureUser(c, adapters, ac, s.assignedUserId) : null;
  const existing = await one<{ id: string; ghl_status: string; starts_at: Date }>(c, "select id, ghl_status, starts_at from appointments where company_id=$1 and ghl_appointment_id=$2", [co.id, s.id]);
  if (!existing) {
    const row = await one<{ id: string }>(c, `insert into appointments (company_id, contact_id, ghl_appointment_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, self_booked, booked_at, ghl_status, ghl_updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`, [co.id, contact.id, s.id, cal.id, cal.appointment_term, userId, s.startTime, s.endTime, null, s.dateAdded ?? new Date(), s.status, s.dateUpdated ?? null]);
    const ev = await emitEvent(c, { company_id: co.id, contact_id: contact.id, opportunity_id: null, appointment_id: row!.id, event_type: "appointment.booked", source: "ghl_poll", data: { calendar_id: s.calendarId, status: s.status, starts_at: s.startTime } });
    const oppId = await ensureOpportunityForBooking(c, co.id, contact.id, row!.id, ev);
    const term = await one<{ name: string; category: string }>(c, "select name, category from company_terms where id=$1", [cal.appointment_term]);
    const ctx = { contact: { id: contact.id }, appointment: { id: row!.id, starts_at: s.startTime, term, status: s.status }, opportunity: { id: oppId } };
    const started = await dispatchEvent(c, { ...ev, opportunity_id: oppId || null }, ctx);
    if (rep) { rep.appointmentsNew++; rep.eventsDispatched += started.length; }
    return;
  }
  const changes: Record<string, unknown> = {};
  if (existing.ghl_status !== s.status) changes.status = { from: existing.ghl_status, to: s.status };
  if (Math.abs(existing.starts_at.getTime() - new Date(s.startTime).getTime()) > 60e3) changes.starts_at = { from: existing.starts_at.toISOString(), to: s.startTime };
  if (!Object.keys(changes).length) return;
  await c.query("update appointments set ghl_status=$2, starts_at=$3, ends_at=$4, assigned_user_id=coalesce($5,assigned_user_id), ghl_updated_at=$6 where id=$1", [existing.id, s.status, s.startTime, s.endTime, userId, s.dateUpdated ?? new Date()]);
  const type = changes.starts_at ? "appointment.rescheduled" : "appointment.status_changed";
  const ev = await emitEvent(c, { company_id: co.id, contact_id: contact.id, opportunity_id: null, appointment_id: existing.id, event_type: type, source: "ghl_poll", data: changes });
  const started = await dispatchEvent(c, ev, { contact: { id: contact.id }, appointment: { id: existing.id, starts_at: s.startTime, status: s.status } });
  if (rep) { rep.appointmentsChanged++; rep.eventsDispatched += started.length; }
}

async function pollAppointments(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, rep: PollReport) {
  const cals = await many<{ ghl_calendar_id: string }>(c, "select ghl_calendar_id from calendars where company_id=$1 and active", [co.id]);
  const from = DateTime.now().minus({ days: 2 }).toJSDate(), to = DateTime.now().plus({ days: 60 }).toJSDate();
  for (const cal of cals) {
    const entity = `appointments:${cal.ghl_calendar_id}`;
    try { for (const s of await adapters.read.appointmentsInWindow(ac, cal.ghl_calendar_id, from, to)) await applyAppointment(c, co, ac, adapters, s, rep); await saveCursor(c, co.id, entity, DateTime.now().toISO()!, true); }
    catch (e) { await saveCursor(c, co.id, entity, "", false); rep.errors.push({ company: co.slug, entity, error: String((e as Error).message) }); }
  }
}

async function pollInbound(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, rep: PollReport) {
  const since = await cursor(c, co.id, "conversations", DateTime.now().minus({ hours: 24 }));
  const msgs = await adapters.read.inboundSince(ac, since.toISO()!);
  let max = since;
  for (const m of msgs) {
    const contact = await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id=$2", [co.id, m.contactId]);
    if (!contact) continue;
    const ins = await one<{ id: string }>(c, `insert into messages (company_id, contact_id, ghl_message_id, ghl_conversation_id, channel, direction, body, subject, sent_by, status, occurred_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (company_id, ghl_message_id) do nothing returning id`,
      [co.id, contact.id, m.id, m.conversationId, m.channel, m.direction, m.body ?? null, m.subject ?? null, m.direction === "inbound" ? null : "other", m.status ?? null, m.dateAdded]);
    if (ins && m.direction === "inbound") {
      rep.inbound++;
      const ev = await emitEvent(c, { company_id: co.id, contact_id: contact.id, opportunity_id: null, appointment_id: null, event_type: "message.received", source: "ghl_poll", data: { channel: m.channel, message_id: m.id, body: m.channel === "sms" ? m.body : undefined }, occurred_at: new Date(m.dateAdded) });
      rep.eventsDispatched += (await dispatchEvent(c, ev, { contact: { id: contact.id } })).length;
      // a waiting run on this contact may be waiting precisely for this; let it wake on the next tick
      await c.query("update runs set next_run_at=least(next_run_at, now()) where company_id=$1 and contact_id=$2 and status='waiting'", [co.id, contact.id]);
    }
    const d = DateTime.fromISO(m.dateAdded); if (d > max) max = d;
  }
  await saveCursor(c, co.id, "conversations", max.toISO()!, true);
}

export async function pollAll(adapters: Adapters): Promise<PollReport> {
  const rep: PollReport = { companies: 0, contacts: 0, appointmentsNew: 0, appointmentsChanged: 0, inbound: 0, eventsDispatched: 0, errors: [] };
  const companies = await asOperator((c) => many<{ id: string }>(c, "select id from companies where status in ('active','hosted')"));
  for (const { id } of companies) {
    rep.companies++;
    await asOperator(async (c) => {
      const { row: co, adapterCompany: ac } = await loadCompany(c, id);
      if (!ac.pit || !ac.locationId) { rep.errors.push({ company: co.slug, entity: "bindings", error: "crm.location_id / secret.ghl_pit not bound" }); return; }
      for (const [entity, fn] of [["contacts", pollContacts], ["appointments", pollAppointments], ["conversations", pollInbound]] as const) {
        try { await fn(c, co, ac, adapters, rep); } catch (e) { rep.errors.push({ company: co.slug, entity, error: String((e as Error).message) }); if (entity !== "appointments") await saveCursor(c, co.id, entity, "", false); }
      }
    });
  }
  return rep;
}
