import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import type { TfAnswer, TfResponse } from "@/adapters/typeform/client";
import { loadCompany, type CompanyRow } from "./context";
import { dispatchEvent, emitEvent } from "./dispatch";
import { ensureOpportunityForBooking, applyPayment } from "./lifecycle";
import { phoneFacts, recordPhoneCall, recordRecording, settlePhoneCall } from "./recordings";
import { applyDocument, facts as agreementFacts } from "./agreements";
import { contactPasses, isTestContact, testDomains, TEST_DOMAINS_KEY } from "./mode";
import { formsOf, takeDelivery, type Submitted, type TypeformFormMap } from "./typeform";
import { depositProducts, DEPOSIT_PRODUCTS_KEY } from "./payments";
import { contactByEmail, normEmail } from "./identity";
import { fileCall, loadEodForm } from "./eod";
import { harnessScripts } from "./harness-scripts";
import { choiceOf, isMoney, isRevenueOutcome, outcomesOf } from "./eod-form";

/**
 * D23: the test harness lives in the engine, not in the CRM. A simulated step is a real event through the real
 * dispatcher and the real runs; what is synthetic is the FACT (a booking that exists only in our table, source 'test')
 * so nothing at the booking source, the CRM, Calendly or any Zap is touched. Triggered by a `sys-test-<action>` tag
 * the poll sees on a contact, by the admin API, or by a button on the contact page. Refused for a live company unless
 * forced: in live mode a run would write real tags and cards for the test person. D92: refused too, for anyone but a
 * test contact, while a workflow that is on stands live on its own: its run about the staged fact would reach a real person.
 */
export const SIM_ACTIONS = ["form", "create", "book", "book-self", "reschedule", "cancel", "pay", "record", "outcome", "call", "agreement", "sign", "reset"] as const;
export type SimAction = (typeof SIM_ACTIONS)[number];
export const simTag = (tag: string): SimAction | null => { const m = /^sys-test-([a-z-]+)$/.exec(tag.trim().toLowerCase()); return m && (SIM_ACTIONS as readonly string[]).includes(m[1]) ? (m[1] as SimAction) : null; };

/**
 * `closer`: the roster name or email to book with (else the calendar's host, the bound default, the first closer); `startsAt`: an
 * exact start (book, or the new start of a reschedule), e.g. earlier today so the call is already due for the end-of-day form.
 * D125: `calendar` (book, book-self, reschedule, cancel, record): which mapped calendar, by its external id, its call type's name
 * ("Triage call") or its own name; without it, book takes the closer call's calendar as before and the others the latest
 * open staged booking. `deposit` (pay): the payment is for a deposit (D119: by its product, or a name saying deposit).
 * D126: `outcome` (outcome): one of the company's end-of-day answers, by its value or its label ("deposit", "Closed", "no_show"), filed
 * for the latest open staged call that has started, by its closer, through the end-of-day form's own per-call path; `amount` is the
 * cash said (a money answer; default the program price, a deposit 100). The closer's day is not filed: their other calls are real.
 * `adapters`: the CRM's, for `form` alone (the door looks the person up in GHL and writes them as the mode allows).
 */
type Ctx = { c: PoolClient; company: CompanyRow; contactId: string; force?: boolean; daysOut?: number; closer?: string; startsAt?: string; amount?: number; calendar?: string; deposit?: boolean; outcome?: string; adapters?: Adapters } & FormInput;
export type SimResult = { ok: true; action: SimAction; detail: Record<string, unknown>; runsStarted: number } | { ok: false; why: string };

type Cal = { id: string; external_id: string; name: string; appointment_term: string; term_name: string; term_category: string; default_user_id: string | null };
const CAL_SELECT = "select cal.id, cal.external_id, cal.name, cal.appointment_term, t.name as term_name, t.category as term_category, cal.default_user_id from calendars cal join company_terms t on t.id=cal.appointment_term";
async function closerCalendar(c: PoolClient, companyId: string) {
  const bound = await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='calendar.closer_call'", [companyId]);
  const ext = bound?.value.toString("utf8");
  return (ext && (await one<Cal>(c, `${CAL_SELECT} where cal.company_id=$1 and cal.external_id=$2`, [companyId, ext])))
    ?? (await one<Cal>(c, `${CAL_SELECT} where cal.company_id=$1 and cal.active and t.category='closing' order by cal.self_booked desc nulls last limit 1`, [companyId]));
}
/** D125: the calendar asked for, among the company's active mapped ones: its external id, else its call type's name, else its own name (case and edge spaces aside). */
async function namedCalendar(c: PoolClient, companyId: string, asked: string): Promise<Cal | undefined> {
  const closer = (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='calendar.closer_call'", [companyId]))?.value.toString("utf8") ?? "";
  return one<Cal>(c, `${CAL_SELECT} where cal.company_id=$1 and cal.active and (cal.external_id=$2 or lower(t.name)=lower($2) or lower(trim(cal.name))=lower($2))
    order by (cal.external_id=$2) desc, (lower(t.name)=lower($2)) desc, (cal.external_id=$3) desc, cal.self_booked desc nulls last, cal.name limit 1`, [companyId, asked.trim(), closer]);
}
const calendarsSaid = async (c: PoolClient, companyId: string) => (await many<{ name: string; external_id: string }>(c, "select t.name, cal.external_id from calendars cal join company_terms t on t.id=cal.appointment_term where cal.company_id=$1 and cal.active order by t.name", [companyId])).map((r) => `"${r.name}" (${r.external_id})`).join(", ") || "none";
const openTestAppointment = (c: PoolClient, companyId: string, contactId: string, calendarId?: string) => one<{ id: string; starts_at: Date; ends_at: Date; status: string; external_id: string; slot_key: string | null; assigned_user_id: string | null; appointment_term: string; term_name: string; term_category: string; self_booked: boolean | null }>(c,
  `select a.id, a.starts_at, a.ends_at, a.status, a.external_id, a.slot_key, a.assigned_user_id, a.appointment_term, t.name as term_name, t.category as term_category, a.self_booked from appointments a join company_terms t on t.id=a.appointment_term
   where a.company_id=$1 and a.contact_id=$2 and a.source='test' and a.status<>'cancelled' and ($3::uuid is null or a.calendar_id=$3) order by a.booked_at desc limit 1`, [companyId, contactId, calendarId ?? null]);

/**
 * Why the harness may not stage a fact for this person, or null when it may. D97: only ever a test contact (tagged sys-test or on
 * a test domain), in every mode and forced or not: a staged booking on a real person lands on their closer's end of day, the
 * reminders and the numbers even when every run about it is ghost. `force` only lets a test contact be staged while live.
 */
export async function harnessRefusal(c: PoolClient, company: Pick<CompanyRow, "id" | "mode">, contactId: string, force = false): Promise<string | null> {
  const domains = (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [company.id, TEST_DOMAINS_KEY]))?.value.toString("utf8");
  if (!(await contactPasses(c, company.id, contactId, "test", domains ? { [TEST_DOMAINS_KEY]: domains } : {})).ok) return NOT_TEST;
  return company.mode === "live" && !force ? LIVE : null;
}
const NOT_TEST = "not a test contact (tag them sys-test, or use an email on a test domain): a staged booking on a real person would show on their closer's end of day and in the numbers.";
const LIVE = "company is live: a simulated run would write real tags and cards for this test contact. Force it to go ahead.";

export async function simulate(x: Ctx, action: SimAction): Promise<SimResult> {
  const { c, company, contactId } = x;
  const refused = await harnessRefusal(c, company, contactId, x.force);
  if (refused) return { ok: false, why: refused };
  const contact = await one<{ id: string; ghl_contact_id: string | null; first_name: string | null; last_name: string | null; timezone: string | null }>(c, "select id, ghl_contact_id, first_name, last_name, timezone from contacts where company_id=$1 and id=$2", [company.id, contactId]);
  if (!contact) return { ok: false, why: "contact not found" };
  const ctx = { contact: { id: contact.id, ghl_contact_id: contact.ghl_contact_id } };
  const name = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Test";
  const tz = contact.timezone ?? company.timezone;
  const cal = x.calendar?.trim() ? await namedCalendar(c, company.id, x.calendar) : null;
  if (x.calendar?.trim() && !cal) return { ok: false, why: `no mapped calendar is "${x.calendar}": say its id or its call type (${await calendarsSaid(c, company.id)})` };
  switch (action) {
    case "form": {
      // the same door with this contact's email: their application, staged
      const email = (await one<{ value: string }>(c, "select value from contact_identifiers where company_id=$1 and contact_id=$2 and kind='email' and retired_at is null order by created_at limit 1", [company.id, contact.id]))?.value;
      if (!email) return { ok: false, why: "this contact has no email to apply with" };
      if (!x.adapters) return { ok: false, why: "form needs the CRM adapters (the door looks the person up in GHL)" };
      return simulateForm({ c, company, adapters: x.adapters, email, force: x.force, form: x.form, answers: x.answers, responseId: x.responseId });
    }
    case "create": {
      const ev = await emitEvent(c, { company_id: company.id, contact_id: contact.id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: { ghl_contact_id: contact.ghl_contact_id, simulated: true } });
      return { ok: true, action, detail: { event: ev.id }, runsStarted: (await dispatchEvent(c, ev, ctx)).length };
    }
    case "book": case "book-self": {
      const on = cal ?? (await closerCalendar(c, company.id));
      if (!on) return { ok: false, why: "no closing calendar is mapped for this company" };
      const at = x.startsAt ? DateTime.fromISO(x.startsAt, { zone: company.timezone }) : null;
      if (at && !at.isValid) return { ok: false, why: `startsAt "${x.startsAt}" is not a time` };
      const start = at ?? DateTime.now().setZone(tz).plus({ days: x.daysOut ?? 3 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
      const asked = x.closer?.trim().toLowerCase();
      const named = asked ? await one<{ id: string }>(c, "select id from users where company_id=$1 and active and (lower(name)=$2 or lower(email)=$2 or lower(split_part(name,' ',1))=$2) order by (role='closer') desc limit 1", [company.id, asked]) : null;
      if (asked && !named) return { ok: false, why: `no one on the roster is "${x.closer}"` };
      const selfBooked = action === "book-self";   // the harness states the fact outright; the company's setter rule is what the poll applies to a real booking
      // the closer: the calendar's own host when we know it (GHL calendars), else the company's bound default closer, else the first closer on the roster — the poll learns it from the booking source, which a staged booking never touches
      const closerId = named?.id ?? on.default_user_id
        ?? (await one<{ id: string }>(c, "select u.id from bindings b join users u on u.company_id=b.company_id and u.ghl_user_id=convert_from(b.value,'utf8') where b.company_id=$1 and b.key='crm.default_closer'", [company.id]))?.id
        ?? (await one<{ id: string }>(c, "select id from users where company_id=$1 and role='closer' and active order by created_at, name limit 1", [company.id]))?.id ?? null;
      const closerName = closerId ? (await one<{ name: string }>(c, "select name from users where id=$1", [closerId]))?.name : undefined;
      const row = await one<{ id: string }>(c, `insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, self_booked, set_by, reschedule_url, cancel_url, tracking, booked_at, status, source_updated_at)
        values ($1,$2,'test',$3,$4,$5,$6,$7,$8,$9,$10,'https://example.test/reschedule','https://example.test/cancel',$11,now(),'confirmed',now()) returning id`,
        [company.id, contact.id, `test-${randomUUID().slice(0, 8)}`, on.id, on.appointment_term, closerId, start.toJSDate(), start.plus({ minutes: 45 }).toJSDate(), selfBooked, selfBooked ? null : "Test Setter", JSON.stringify({ utm_source: "sys-test" })]);
      const ev = await emitEvent(c, { company_id: company.id, contact_id: contact.id, opportunity_id: null, appointment_id: row!.id, event_type: "appointment.booked", source: "test", data: { source: "test", calendar_id: on.external_id, status: "confirmed", starts_at: start.toISO(), self_booked: selfBooked, simulated: true } });
      const oppId = await ensureOpportunityForBooking(c, company.id, contact.id, row!.id, ev);
      const started = await dispatchEvent(c, { ...ev, opportunity_id: oppId || null }, { ...ctx, appointment: { id: row!.id, starts_at: start.toISO(), term: { name: on.term_name, category: on.term_category }, status: "confirmed", self_booked: selfBooked, set_by: selfBooked ? null : "Test Setter" }, opportunity: { id: oppId } });
      return { ok: true, action, detail: { appointment: row!.id, calendar: on.external_id, call_type: on.term_name, starts_at: start.toISO(), self_booked: selfBooked, name, closer: closerName ?? null }, runsStarted: started.length };
    }
    case "reschedule": case "cancel": {
      const a = await openTestAppointment(c, company.id, contact.id, cal?.id);
      if (!a) return { ok: false, why: `no open simulated appointment${cal ? ` on "${cal.term_name}"` : ""} to change; run sys-test-book first` };
      const to = action === "reschedule" && x.startsAt ? DateTime.fromISO(x.startsAt, { zone: company.timezone }) : null;
      if (to && !to.isValid) return { ok: false, why: `startsAt "${x.startsAt}" is not a time` };
      const moved = action === "reschedule" ? to ?? DateTime.fromJSDate(a.starts_at).plus({ days: 2 }) : null;
      const length = a.ends_at.getTime() - a.starts_at.getTime();
      const status = action === "cancel" ? "cancelled" : a.status;
      await c.query("update appointments set status=$2, starts_at=coalesce($3, starts_at), ends_at=coalesce($4, ends_at), source_updated_at=now(), cancelled_by=case when $2='cancelled' then $5 else cancelled_by end, cancel_reason=case when $2='cancelled' then 'simulated cancel' else cancel_reason end where id=$1", [a.id, status, moved?.toJSDate() ?? null, moved?.plus({ milliseconds: length }).toJSDate() ?? null, name]);
      await c.query("update runs set next_run_at=now() where company_id=$1 and appointment_id=$2 and status='waiting'", [company.id, a.id]);
      // the same slot bookkeeping the poll does for a move that keeps the booking's id: the slot left keeps its Sales Call (logged rescheduled), the new slot gets its own (D76)
      const slot = moved ? { from: a.slot_key ?? a.external_id, to: `${a.external_id}@${moved.toUTC().toISO()}` } : null;
      if (slot) await c.query("update appointments set slot_key=$2 where id=$1", [a.id, slot.to]);
      const changes = moved ? { starts_at: { from: a.starts_at.toISOString(), to: moved.toISO() }, slot } : { status: { from: a.status, to: "cancelled" }, cancelled_by: name, cancel_reason: "simulated cancel", before_start: true };
      const ev = await emitEvent(c, { company_id: company.id, contact_id: contact.id, opportunity_id: null, appointment_id: a.id, event_type: moved ? "appointment.rescheduled" : "appointment.status_changed", source: "test", data: { source: "test", ...changes, simulated: true } });
      const started = await dispatchEvent(c, ev, { ...ctx, appointment: { id: a.id, starts_at: (moved ?? DateTime.fromJSDate(a.starts_at)).toISO(), status, term: { name: a.term_name, category: a.term_category }, self_booked: a.self_booked } });
      return { ok: true, action, detail: { appointment: a.id, call_type: a.term_name, ...changes }, runsStarted: started.length };
    }
    case "pay": {
      const price = (await one<{ v: string | null }>(c, "select contract_value_default as v from companies where id=$1", [company.id]))?.v;
      // D119: a deposit is told by its product (the company's first declared one) or, declaring none, by a name saying deposit
      const declared = depositProducts((await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [company.id, DEPOSIT_PRODUCTS_KEY]))?.value.toString("utf8"));
      const deposit = x.deposit ? (declared.length ? { product_id: declared[0] } : { product_name: "Deposit (test)" }) : {};
      const ev = await applyPayment(c, company.id, contact.id, { whopPaymentId: `test-${randomUUID().slice(0, 8)}`, amount: x.amount ?? (x.deposit ? 100 : price ? Number(price) : 1000), currency: "USD", status: "succeeded", paidAt: new Date(), raw: { simulated: true, ...deposit } });
      return { ok: true, action, detail: { event: ev.id, amount: ev.data.amount, kind: ev.data.kind }, runsStarted: (await dispatchEvent(c, ev, ctx)).length };
    }
    case "record": {
      const a = await openTestAppointment(c, company.id, contact.id, cal?.id);
      const closer = a?.assigned_user_id ? await one<{ email: string; name: string }>(c, "select email, name from users where id=$1", [a.assigned_user_id]) : null;
      const email = (await one<{ value: string }>(c, "select value from contact_identifiers where contact_id=$1 and kind='email' limit 1", [contact.id]))?.value;
      const startedAt = a ? new Date(a.starts_at.getTime() + 60e3) : new Date();
      const r = await recordRecording(c, company.id, { provider: "fathom", externalId: `test-${randomUUID().slice(0, 8)}`, title: `${name} <> ${closer?.name ?? "Closer"}`, startedAt, durationMin: 41, shareUrl: "https://example.test/recording", recordedBy: closer ? { name: closer.name, email: closer.email } : undefined,
        invitees: [...(closer ? [{ name: closer.name, email: closer.email, isExternal: false }] : []), { name, email, isExternal: true }],
        transcript: (await harnessScripts(c, company.id)).closerCall.map((l) => ({ speaker: l.speaker === "prospect" ? name : closer?.name ?? "Closer", text: l.text.replace(/\{first\}/g, name.split(" ")[0]) })), raw: { simulated: true } });
      if (r.outcome !== "linked") return { ok: false, why: r.outcome === "duplicate" ? "duplicate recording id" : r.outcome === "copy" ? `a copy of recording ${r.of} (the same meeting, recorded twice)` : `recording did not link to this contact: ${r.reason}` };
      const appt = r.appointmentId ? await one<Record<string, unknown>>(c, "select a.id, a.starts_at, a.status, json_build_object('category', t.category) as term from appointments a join company_terms t on t.id=a.appointment_term where a.id=$1", [r.appointmentId]) : null;
      return { ok: true, action, detail: { recording: r.recording.id, appointment: r.appointmentId }, runsStarted: (await dispatchEvent(c, r.event, { ...ctx, appointment: appt ?? undefined })).length };
    }
    case "outcome": {
      const a = await openTestAppointment(c, company.id, contact.id, cal?.id);
      if (!a) return { ok: false, why: `no open simulated appointment${cal ? ` on "${cal.term_name}"` : ""} to file; run book first` };
      if (a.starts_at.getTime() > Date.now()) return { ok: false, why: `the call starts ${a.starts_at.toISOString()}: only a call that has started is on the end-of-day form (book it with startsAt in the past)` };
      if (!a.assigned_user_id) return { ok: false, why: "the staged call has no closer to file it" };
      const fields = await loadEodForm(c, company.id), asked = x.outcome?.trim() ?? "";
      const choice = choiceOf(asked, fields) ?? outcomesOf(fields).find((o) => o.label.toLowerCase() === asked.toLowerCase());
      if (!choice) return { ok: false, why: `outcome is one of the company's end-of-day answers: ${outcomesOf(fields).map((o) => `"${o.value}" (${o.label})`).join(", ")}` };
      const price = Number((await one<{ v: string | null }>(c, "select contract_value_default as v from companies where id=$1", [company.id]))?.v) || null;
      const cash = isMoney(choice.value, fields) ? x.amount ?? (choice.call_outcome === "deposit" ? 100 : price) : null;
      const r = await fileCall(c, company.id, fields, { appointment_id: a.id, contact_id: contact.id, contact: name, starts_at: a.starts_at.toISOString(), href_contact: null, recording_url: null, outcome: choice.value,
        revenue: isRevenueOutcome(choice.value, fields) ? price : null, cash, next_date: null, next_steps: "", dq_reason: "", dq_note: "", about: "", notes: "Filed by the test harness", extra: {} }, a.assigned_user_id);
      if (r.status === "skipped") return { ok: false, why: `"${choice.label}" could not be filed: the company has no outcome term for it` };
      return { ok: true, action, detail: { appointment: a.id, call_type: a.term_name, outcome: choice.value, label: choice.label, cash, filed: r.status }, runsStarted: r.runs };
    }
    case "call": {
      // a connected setter call, 20 minutes ago (so the post's 15 minutes after hang-up are already over), with a transcript the classifier will read as a setting call;
      // GHL has no such call to read it back from, so the transcript is held like a webhook's until the run is done (D87)
      // the caller: a setter, else one of the company's own team (D125: in a shared location the roster also holds the other business's staff)
      const setter = await one<{ ghl_user_id: string }>(c, "select ghl_user_id from users where company_id=$1 and ghl_user_id is not null and active order by (role='setter') desc, (role in ('closer','manager','owner')) desc, name limit 1", [company.id]);
      const loc = (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='crm.location_id'", [company.id]))?.value.toString("utf8");
      const { recording, isNew } = await recordPhoneCall(c, company.id, { externalId: `test-call-${randomUUID().slice(0, 8)}`, contactId: contact.id, startedAt: new Date(Date.now() - 20 * 60e3), durationSec: 184, direction: "outbound", status: "completed", callerGhlUserId: setter?.ghl_user_id,
        conversationUrl: loc && contact.ghl_contact_id ? `https://app.gohighlevel.com/v2/location/${loc}/conversations/conversations/${contact.ghl_contact_id}` : undefined, raw: { simulated: true } });
      if (!isNew) return { ok: false, why: "duplicate call id" };
      const { recording: row, event } = await settlePhoneCall(c, recording, { transcript: (await harnessScripts(c, company.id)).setterCall.map((l) => ({ speaker: l.speaker === "prospect" ? "1" : "0", text: l.text.replace(/\{first\}/g, name.split(" ")[0]) })) }, { hold: true });
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
      // D125: a staged application's delivery marks go with it, so the same form after a reset is a first application again; a real response's marks stay (Typeform's retries must stay no-ops)
      const staged = await many<{ key: string }>(c, "select distinct (data->>'form_id') || ':' || (data->>'response_id') as key from events where company_id=$1 and contact_id=$2 and event_type='form.submitted' and data->>'response_id' like 'sim-%'", [company.id, contact.id]);
      if (staged.length) await c.query("delete from webhook_deliveries where company_id=$1 and provider in ('typeform','typeform_ghl') and delivery_id = any($2::text[])", [company.id, staged.map((r) => r.key)]);
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
      return { ok: true, action, detail: { runs_removed: runs.length, ...(staged.length ? { applications_removed: staged.length } : {}) }, runsStarted: 0 };
    }
  }
}

/** `form`: which mapped form (its id or name; default the company's only one); `answers`: overrides by question ref, target (`first_name`, `field_contact_app_age` or `app_age`) or hidden field name; `responseId`: the synthetic response id (always `sim-…`; default one per form and email, so the same request twice is one application). */
export type FormInput = { form?: string; answers?: Record<string, string | number | boolean>; responseId?: string };

/** Plausible answers by target, for a form map that names them; anything else gets a plain test answer. */
const ANSWERS: Record<string, string | number> = {
  first_name: "Test", last_name: "Applicant", app_age: 36, app_location: "Los Angeles, CA", app_profession: "Product designer", app_relationship_status: "Single, never married",
  app_income: "$150,000 - $250,000", app_looking_for: "A long-term relationship", app_has_children: "No", app_wants_children: "Open to it", app_religion: "Spiritual, not religious",
  app_shared_faith: "Not important to me", app_relocating: "Open to it for the right person", app_ideal_partner: "Kind, curious and ready for something real.",
  app_dating_challenge: "Meeting people who want the same things I do.", app_support_wanted: "Introductions and coaching", app_open_to_coaching: "Yes", app_strategy_session: "Yes",
  app_consent: "I acknowledge and consent",
};
const HIDDEN: Record<string, string> = { utm_source: "sys-test", utm_medium: "harness", utm_campaign: "simulate" };
const short = (t: string) => t.replace(/^field_contact_/, "");
const answerOf = (ref: string, target: string, v: string | number | boolean): TfAnswer => {
  const field = { id: `sim-${ref.slice(0, 8)}`, ref };
  if (target === "email") return { field: { ...field, type: "email" }, type: "email", email: String(v) };
  if (target === "phone") return { field: { ...field, type: "phone_number" }, type: "phone_number", phone_number: String(v) };
  if (typeof v === "number") return { field: { ...field, type: "number" }, type: "number", number: v };
  if (typeof v === "boolean") return { field: { ...field, type: "yes_no" }, type: "boolean", boolean: v };
  return { field: { ...field, type: "short_text" }, type: "text", text: v };
};

/** The synthetic response for one map: every mapped question answered (the email as given), the overrides applied; an override naming nothing on the form is refused. */
export function stageResponse(form: TypeformFormMap, email: string, responseId: string, overrides: Record<string, string | number | boolean> = {}): { response: TfResponse } | { why: string } {
  const answers = new Map<string, string | number | boolean>(), hidden: Record<string, string> = {};
  // a phone in the range kept for fiction (555-0100…0199), one per email, so GHL's phone lookup finds no real person
  const phone = `+1310555${String(100 + (parseInt(createHash("sha256").update(email).digest("hex").slice(0, 6), 16) % 100)).padStart(4, "0")}`;
  for (const [ref, target] of Object.entries(form.answers)) answers.set(ref, target === "email" ? email : target === "phone" ? phone : ANSWERS[short(target)] ?? "Test answer");
  for (const name of Object.keys(form.hidden ?? {})) if (HIDDEN[name]) hidden[name] = HIDDEN[name];
  for (const [k, v] of Object.entries(overrides)) {
    if (k in form.answers) { answers.set(k, v); continue; }
    const ref = Object.entries(form.answers).find(([, t]) => t === k || short(t) === k)?.[0];
    if (ref) { if (form.answers[ref] === "email") return { why: "the email is the contact's: give it as contact, not as an answer" }; answers.set(ref, v); continue; }
    const name = form.hidden && (k in form.hidden ? k : Object.entries(form.hidden).find(([, t]) => t === k || short(t) === k)?.[0]);
    if (name) { hidden[name] = String(v); continue; }
    return { why: `"${k}" is no question, field or hidden field of the form` };
  }
  const now = new Date().toISOString();
  return { response: { token: responseId, response_id: responseId, landed_at: now, submitted_at: now, hidden, answers: [...answers].map(([ref, v]) => answerOf(ref, form.answers[ref], v)) } };
}

/**
 * D125: a Typeform application staged exactly as the door takes one. The person need not exist: the door finds them in GHL or makes
 * them, as it does for a real applicant. Only for a test contact (an email on a test domain, or someone the ledger has tagged
 * sys-test, D97), and refused while live unless forced. The response is synthetic (`sim-…`) and goes through `takeDelivery`, the
 * function the signed webhook calls, so New from Typeform, New lead and the GHL writes are the live ones: real for a test contact
 * in test mode, would-have in ghost. Typeform is never called. One response id is one application, as at the door.
 */
export async function simulateForm(x: { c: PoolClient; company: CompanyRow; adapters: Adapters; email: string; force?: boolean } & FormInput): Promise<SimResult> {
  const { c, company } = x;
  const email = normEmail(x.email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, why: `"${x.email}" is not an email` };
  const loaded = await loadCompany(c, company.id);
  const forms = formsOf(loaded.bindings), ids = Object.keys(forms), asked = x.form?.trim();
  if (!ids.length) return { ok: false, why: "no Typeform form is mapped for this company" };
  const formId = asked ? ids.find((id) => id === asked || forms[id].name?.trim().toLowerCase() === asked.toLowerCase()) : ids.length === 1 ? ids[0] : undefined;
  const said = ids.map((id) => (forms[id].name ? `${id} "${forms[id].name}"` : id)).join(", ");
  if (!formId) return { ok: false, why: asked ? `no mapped form is "${asked}" (${said})` : `several forms are mapped: say which (${said})` };
  const knownId = await contactByEmail(c, company.id, email);
  const known = knownId ? { contact_id: knownId } : undefined;
  const refused = known ? await harnessRefusal(c, company, known.contact_id, x.force)
    : !isTestContact({ emails: [email] }, testDomains(loaded.bindings)) ? NOT_TEST : company.mode === "live" && !x.force ? LIVE : null;
  if (refused) return { ok: false, why: refused };
  const rid = x.responseId?.trim() ? (x.responseId.trim().startsWith("sim-") ? x.responseId.trim() : `sim-${x.responseId.trim()}`) : `sim-${createHash("sha256").update(`${formId}:${email}`).digest("hex").slice(0, 16)}`;
  const staged = stageResponse(forms[formId], email, rid, x.answers);
  if ("why" in staged) return { ok: false, why: staged.why };
  const out = await takeDelivery(c, loaded, { event_type: "form_response", form_response: { form_id: formId, ...staged.response } }, x.adapters, { simulated: true });
  const r = out.body as Partial<Submitted> & { ignored?: string };
  if (!r.outcome) return { ok: false, why: r.ignored ?? "the door took nothing" };
  if (r.outcome !== "recorded") return { ok: true, action: "form", detail: { outcome: r.outcome, form: formId, response_id: rid, contact: known?.contact_id ?? null }, runsStarted: 0 };
  return { ok: true, action: "form", detail: { outcome: r.outcome, form: formId, response_id: rid, contact: r.contactId, ghl_contact_id: r.ghlContactId, action: r.action, matched: r.matched, ghost: r.ghost }, runsStarted: r.runsStarted ?? 0 };
}

/**
 * Tyler, 2026-10-20: a staged booking left over from a rehearsal sits on a closer's end-of-day form as a call to file (and in the
 * numbers) once its time passes. Voiding it makes it `invalid`, which every reader already leaves out, with no event and so no
 * workflow (a cancel would start Call cancelled and text the test contact); its runs still going end. Staged (source `test`) only.
 */
export async function voidStagedBookings(c: PoolClient, companyId: string, appointmentIds: string[], by: string, dryRun = false): Promise<{ voided: { id: string; starts_at: string; was: string }[]; refused: { id: string; why: string }[]; runsEnded: number }> {
  const rows = await many<{ id: string; source: string; status: string; starts_at: Date }>(c, "select id, source, status, starts_at from appointments where company_id=$1 and id = any($2::uuid[])", [companyId, appointmentIds]);
  const refused = appointmentIds.filter((id) => !rows.some((r) => r.id === id)).map((id) => ({ id, why: "no such booking for this company" }));
  const ok: typeof rows = [];
  for (const r of rows) {
    if (r.source !== "test") refused.push({ id: r.id, why: `a real ${r.source} booking: only staged (test) bookings can be voided here` });
    else if (r.status === "invalid") refused.push({ id: r.id, why: "already void" });
    else ok.push(r);
  }
  let runsEnded = 0;
  if (!dryRun && ok.length) {
    const ids = ok.map((r) => r.id);
    runsEnded = (await c.query("update runs set status='exited', exit_reason='staged booking voided', next_run_at=null where company_id=$1 and appointment_id = any($2::uuid[]) and status in ('active','waiting','paused')", [companyId, ids])).rowCount ?? 0;
    await c.query("update appointments set status='invalid', source_updated_at=now() where company_id=$1 and id = any($2::uuid[])", [companyId, ids]);
    await c.query("insert into audit_log (company_id, action, target_type, after) values ($1,'appointment.voided','appointment',$2)", [companyId, { appointments: ok.map((r) => ({ id: r.id, was: r.status })), runs_ended: runsEnded, by }]);
  }
  return { voided: ok.map((r) => ({ id: r.id, starts_at: r.starts_at.toISOString(), was: r.status })), refused, runsEnded };
}
