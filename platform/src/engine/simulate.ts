import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { many, one } from "@/db/client";
import type { CompanyRow } from "./context";
import { dispatchEvent, emitEvent } from "./dispatch";
import { ensureOpportunityForBooking, applyPayment } from "./lifecycle";
import { phoneFacts, recordPhoneCall, recordRecording, settlePhoneCall } from "./recordings";
import { applyDocument, facts as agreementFacts } from "./agreements";

/**
 * D23: the test harness lives in the engine, not in the CRM. A simulated step is a real event through the real
 * dispatcher and the real runs; what is synthetic is the FACT (a booking that exists only in our table, source 'test')
 * so nothing at the booking source, the CRM, Calendly or any Zap is touched. Triggered by a `sys-test-<action>` tag
 * the poll sees on a contact, by the admin API, or by a button on the contact page. Refused for a live company unless
 * forced: in live mode a run would write real tags and cards for the test person.
 */
export const SIM_ACTIONS = ["create", "book", "book-self", "reschedule", "cancel", "pay", "record", "call", "agreement", "sign", "reset"] as const;
export type SimAction = (typeof SIM_ACTIONS)[number];
export const simTag = (tag: string): SimAction | null => { const m = /^sys-test-([a-z-]+)$/.exec(tag.trim().toLowerCase()); return m && (SIM_ACTIONS as readonly string[]).includes(m[1]) ? (m[1] as SimAction) : null; };

type Ctx = { c: PoolClient; company: CompanyRow; contactId: string; force?: boolean; daysOut?: number };
export type SimResult = { ok: true; action: SimAction; detail: Record<string, unknown>; runsStarted: number } | { ok: false; why: string };

async function closerCalendar(c: PoolClient, companyId: string) {
  const bound = await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='calendar.closer_call'", [companyId]);
  const ext = bound?.value.toString("utf8");
  return (ext && (await one<{ id: string; appointment_term: string; term_category: string; default_user_id: string | null }>(c, "select cal.id, cal.appointment_term, t.category as term_category, cal.default_user_id from calendars cal join company_terms t on t.id=cal.appointment_term where cal.company_id=$1 and cal.external_id=$2", [companyId, ext])))
    ?? (await one<{ id: string; appointment_term: string; term_category: string; default_user_id: string | null }>(c, "select cal.id, cal.appointment_term, t.category as term_category, cal.default_user_id from calendars cal join company_terms t on t.id=cal.appointment_term where cal.company_id=$1 and cal.active and t.category='closing' order by cal.self_booked desc nulls last limit 1", [companyId]));
}
const openTestAppointment = (c: PoolClient, companyId: string, contactId: string) => one<{ id: string; starts_at: Date; status: string; external_id: string; assigned_user_id: string | null; appointment_term: string; term_category: string; self_booked: boolean | null }>(c,
  "select a.id, a.starts_at, a.status, a.external_id, a.assigned_user_id, a.appointment_term, t.category as term_category, a.self_booked from appointments a join company_terms t on t.id=a.appointment_term where a.company_id=$1 and a.contact_id=$2 and a.source='test' and a.status<>'cancelled' order by a.booked_at desc limit 1", [companyId, contactId]);

export async function simulate(x: Ctx, action: SimAction): Promise<SimResult> {
  const { c, company, contactId } = x;
  if (company.mode === "live" && !x.force) return { ok: false, why: "company is live: a simulated run would write real tags and cards. Switch to shadow, or force it." };
  const contact = await one<{ id: string; ghl_contact_id: string | null; first_name: string | null; last_name: string | null; timezone: string | null }>(c, "select id, ghl_contact_id, first_name, last_name, timezone from contacts where company_id=$1 and id=$2", [company.id, contactId]);
  if (!contact) return { ok: false, why: "contact not found" };
  const ctx = { contact: { id: contact.id, ghl_contact_id: contact.ghl_contact_id } };
  const name = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Test";
  const tz = contact.timezone ?? company.timezone;
  switch (action) {
    case "create": {
      const ev = await emitEvent(c, { company_id: company.id, contact_id: contact.id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: { ghl_contact_id: contact.ghl_contact_id, simulated: true } });
      return { ok: true, action, detail: { event: ev.id }, runsStarted: (await dispatchEvent(c, ev, ctx)).length };
    }
    case "book": case "book-self": {
      const cal = await closerCalendar(c, company.id);
      if (!cal) return { ok: false, why: "no closing calendar is mapped for this company" };
      const start = DateTime.now().setZone(tz).plus({ days: x.daysOut ?? 3 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
      const selfBooked = action === "book-self";   // the harness states the fact outright; the company's setter rule is what the poll applies to a real booking
      // the closer: the calendar's own host when we know it (GHL calendars), else the company's bound default closer, else the first closer on the roster — the poll learns it from the booking source, which a staged booking never touches
      const closerId = cal.default_user_id
        ?? (await one<{ id: string }>(c, "select u.id from bindings b join users u on u.company_id=b.company_id and u.ghl_user_id=convert_from(b.value,'utf8') where b.company_id=$1 and b.key='crm.default_closer'", [company.id]))?.id
        ?? (await one<{ id: string }>(c, "select id from users where company_id=$1 and role='closer' and active order by created_at, name limit 1", [company.id]))?.id ?? null;
      const closerName = closerId ? (await one<{ name: string }>(c, "select name from users where id=$1", [closerId]))?.name : undefined;
      const row = await one<{ id: string }>(c, `insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, self_booked, set_by, reschedule_url, cancel_url, tracking, booked_at, status, source_updated_at)
        values ($1,$2,'test',$3,$4,$5,$6,$7,$8,$9,$10,'https://example.test/reschedule','https://example.test/cancel',$11,now(),'confirmed',now()) returning id`,
        [company.id, contact.id, `test-${randomUUID().slice(0, 8)}`, cal.id, cal.appointment_term, closerId, start.toJSDate(), start.plus({ minutes: 45 }).toJSDate(), selfBooked, selfBooked ? null : "Test Setter", JSON.stringify({ utm_source: "sys-test" })]);
      const ev = await emitEvent(c, { company_id: company.id, contact_id: contact.id, opportunity_id: null, appointment_id: row!.id, event_type: "appointment.booked", source: "test", data: { source: "test", status: "confirmed", starts_at: start.toISO(), self_booked: selfBooked, simulated: true } });
      const oppId = await ensureOpportunityForBooking(c, company.id, contact.id, row!.id, ev);
      const started = await dispatchEvent(c, { ...ev, opportunity_id: oppId || null }, { ...ctx, appointment: { id: row!.id, starts_at: start.toISO(), term: { category: cal.term_category }, status: "confirmed", self_booked: selfBooked, set_by: selfBooked ? null : "Test Setter" }, opportunity: { id: oppId } });
      return { ok: true, action, detail: { appointment: row!.id, starts_at: start.toISO(), self_booked: selfBooked, name, closer: closerName ?? null }, runsStarted: started.length };
    }
    case "reschedule": case "cancel": {
      const a = await openTestAppointment(c, company.id, contact.id);
      if (!a) return { ok: false, why: "no open simulated appointment to change; run sys-test-book first" };
      const moved = action === "reschedule" ? DateTime.fromJSDate(a.starts_at).plus({ days: 2 }) : null;
      const status = action === "cancel" ? "cancelled" : a.status;
      await c.query("update appointments set status=$2, starts_at=coalesce($3, starts_at), ends_at=coalesce($4, ends_at), source_updated_at=now(), cancelled_by=case when $2='cancelled' then $5 else cancelled_by end, cancel_reason=case when $2='cancelled' then 'simulated cancel' else cancel_reason end where id=$1", [a.id, status, moved?.toJSDate() ?? null, moved?.plus({ minutes: 45 }).toJSDate() ?? null, name]);
      await c.query("update runs set next_run_at=now() where company_id=$1 and appointment_id=$2 and status='waiting'", [company.id, a.id]);
      const changes = moved ? { starts_at: { from: a.starts_at.toISOString(), to: moved.toISO() } } : { status: { from: a.status, to: "cancelled" }, cancelled_by: name, cancel_reason: "simulated cancel" };
      const ev = await emitEvent(c, { company_id: company.id, contact_id: contact.id, opportunity_id: null, appointment_id: a.id, event_type: moved ? "appointment.rescheduled" : "appointment.status_changed", source: "test", data: { source: "test", ...changes, simulated: true } });
      const started = await dispatchEvent(c, ev, { ...ctx, appointment: { id: a.id, starts_at: (moved ?? DateTime.fromJSDate(a.starts_at)).toISO(), status, term: { category: a.term_category }, self_booked: a.self_booked } });
      return { ok: true, action, detail: { appointment: a.id, ...changes }, runsStarted: started.length };
    }
    case "pay": {
      const price = (await one<{ v: string | null }>(c, "select contract_value_default as v from companies where id=$1", [company.id]))?.v;
      const ev = await applyPayment(c, company.id, contact.id, { whopPaymentId: `test-${randomUUID().slice(0, 8)}`, amount: price ? Number(price) : 1000, currency: "USD", status: "succeeded", paidAt: new Date(), raw: { simulated: true } });
      return { ok: true, action, detail: { event: ev.id, amount: ev.data.amount, kind: ev.data.kind }, runsStarted: (await dispatchEvent(c, ev, ctx)).length };
    }
    case "record": {
      const a = await openTestAppointment(c, company.id, contact.id);
      const closer = a?.assigned_user_id ? await one<{ email: string; name: string }>(c, "select email, name from users where id=$1", [a.assigned_user_id]) : null;
      const email = (await one<{ value: string }>(c, "select value from contact_identifiers where contact_id=$1 and kind='email' limit 1", [contact.id]))?.value;
      const startedAt = a ? new Date(a.starts_at.getTime() + 60e3) : new Date();
      const r = await recordRecording(c, company.id, { provider: "fathom", externalId: `test-${randomUUID().slice(0, 8)}`, title: `${name} <> ${closer?.name ?? "Closer"}`, startedAt, durationMin: 41, shareUrl: "https://example.test/recording", recordedBy: closer ? { name: closer.name, email: closer.email } : undefined,
        invitees: [...(closer ? [{ name: closer.name, email: closer.email, isExternal: false }] : []), { name, email, isExternal: true }],
        transcript: [{ speaker: closer?.name ?? "Closer", text: "Thanks for hopping on. Tell me what you have been noticing." }, { speaker: name, text: "It has been thinning at the crown for about two years and I want to fix it before it gets worse." }, { speaker: closer?.name ?? "Closer", text: "Got it. Here is how the program works and what it costs." }, { speaker: name, text: "That is a lot right now, but I want to do this. Can I split it?" }, { speaker: closer?.name ?? "Closer", text: "Yes, two payments. Let us get you started." }], raw: { simulated: true } });
      if (r.outcome !== "linked") return { ok: false, why: r.outcome === "duplicate" ? "duplicate recording id" : `recording did not link to this contact: ${r.reason}` };
      const appt = r.appointmentId ? await one<Record<string, unknown>>(c, "select a.id, a.starts_at, a.status, json_build_object('category', t.category) as term from appointments a join company_terms t on t.id=a.appointment_term where a.id=$1", [r.appointmentId]) : null;
      return { ok: true, action, detail: { recording: r.recording.id, appointment: r.appointmentId }, runsStarted: (await dispatchEvent(c, r.event, { ...ctx, appointment: appt ?? undefined })).length };
    }
    case "call": {
      // a connected setter call, 20 minutes ago so the template's wait is already over, with a transcript the classifier will read as a setting call
      const setter = await one<{ ghl_user_id: string }>(c, "select ghl_user_id from users where company_id=$1 and ghl_user_id is not null and active order by (role='setter') desc, name limit 1", [company.id]);
      const loc = (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='crm.location_id'", [company.id]))?.value.toString("utf8");
      const { recording, isNew } = await recordPhoneCall(c, company.id, { externalId: `test-call-${randomUUID().slice(0, 8)}`, contactId: contact.id, startedAt: new Date(Date.now() - 20 * 60e3), durationSec: 184, direction: "outbound", status: "completed", callerGhlUserId: setter?.ghl_user_id,
        conversationUrl: loc && contact.ghl_contact_id ? `https://app.gohighlevel.com/v2/location/${loc}/conversations/conversations/${contact.ghl_contact_id}` : undefined, raw: { simulated: true } });
      if (!isNew) return { ok: false, why: "duplicate call id" };
      const { recording: row, event } = await settlePhoneCall(c, recording, { transcript: [
        { speaker: "0", text: `Hey ${name.split(" ")[0]}, this is the team calling about the form you filled out. Got two minutes?` }, { speaker: "1", text: "Yeah, sure." },
        { speaker: "0", text: "What made you reach out?" }, { speaker: "1", text: "It has been getting worse for about a year and I want to deal with it before it gets any further." },
        { speaker: "0", text: "Makes sense. If we could fix that, what would that change for you?" }, { speaker: "1", text: "Honestly just feeling like myself again. What does it cost?" },
        { speaker: "0", text: "The specialist walks you through pricing on the call. Does Thursday at two work?" }, { speaker: "1", text: "Thursday at two works." }] });
      return { ok: true, action, detail: { recording: row.id, caller: row.recorded_by_name }, runsStarted: event ? (await dispatchEvent(c, event, { ...ctx, recording: { id: row.id, ...phoneFacts(row) } })).length : 0 };
    }
    case "agreement": case "sign": {
      // a document the CRM would list: `agreement` = sent and unsigned; `sign` = the same document (or a new one) completed now
      const existing = await one<{ external_id: string; sent_at: Date }>(c, "select external_id, sent_at from agreements where company_id=$1 and contact_id=$2 and signed_at is null order by sent_at desc limit 1", [company.id, contact.id]);
      const ext = action === "sign" && existing ? existing.external_id : `test-doc-${randomUUID().slice(0, 8)}`;
      const createdAt = existing && action === "sign" ? existing.sent_at.toISOString() : new Date().toISOString();
      const { row, events } = await applyDocument(c, company.id, { id: ext, name: "Purchase agreement (test)", status: action === "sign" ? "completed" : "sent", contactId: contact.ghl_contact_id ?? undefined, createdAt, signedAt: action === "sign" ? new Date().toISOString() : undefined, raw: { simulated: true } }, contact.id);
      let runs = 0; for (const ev of events) runs += (await dispatchEvent(c, ev, { ...ctx, agreement: agreementFacts(row) })).length;
      return { ok: true, action, detail: { agreement: row.id, status: row.status, events: events.map((e) => e.event_type) }, runsStarted: runs };
    }
    case "reset": {
      // the engine forgets everything it did for this person; the contact row and identifiers stay (they mirror the CRM)
      const runs = await many<{ id: string }>(c, "select id from runs where company_id=$1 and contact_id=$2", [company.id, contact.id]);
      for (const r of runs) await c.query("delete from run_steps where run_id=$1", [r.id]);
      await c.query("delete from sends where company_id=$1 and (contact_id=$2 or run_id in (select id from runs where company_id=$1 and contact_id=$2))", [company.id, contact.id]);
      await c.query("delete from runs where company_id=$1 and contact_id=$2", [company.id, contact.id]);
      await c.query("update appointments set disposition_id=null where company_id=$1 and contact_id=$2", [company.id, contact.id]);
      await c.query("delete from form_submissions where company_id=$1 and contact_id=$2", [company.id, contact.id]);
      await c.query("delete from recordings where company_id=$1 and contact_id=$2", [company.id, contact.id]);
      await c.query("delete from agreements where company_id=$1 and contact_id=$2", [company.id, contact.id]);
      await c.query("delete from crm_records where company_id=$1 and contact_id=$2", [company.id, contact.id]);
      await c.query("delete from payments where company_id=$1 and contact_id=$2", [company.id, contact.id]);
      await c.query("delete from events where company_id=$1 and contact_id=$2", [company.id, contact.id]);
      await c.query("delete from appointments where company_id=$1 and contact_id=$2 and source='test'", [company.id, contact.id]);
      await c.query("update appointments set opportunity_id=null where company_id=$1 and contact_id=$2", [company.id, contact.id]);
      await c.query("delete from pipeline_cards where company_id=$1 and contact_id=$2", [company.id, contact.id]);
      await c.query("delete from opportunities where company_id=$1 and contact_id=$2", [company.id, contact.id]);
      return { ok: true, action, detail: { runs_removed: runs.length }, runsStarted: 0 };
    }
  }
}
