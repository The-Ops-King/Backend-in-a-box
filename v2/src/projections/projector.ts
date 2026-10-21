import { isoDay, toInstant } from "@/workflow/dates";
import { normEmail, normPhone } from "@/engine/gate";
import type { EventRow } from "@/engine/types";
import {
  type AppointmentRow, type CallRow, type ContactRow, type DailyFactRow, type DealRow, type PaymentRow, type PersonRow, type ProjQuery, type ProjTable, type Rows,
  matches,
} from "./tables";

/**
 * The projectors: one pure function from a fact (and the rows it touches, as they are before it) to the row changes it
 * makes. Nothing here reads a setting, the clock or a vendor: a projection is what the facts say, so dropping the tables
 * and running every fact through again in order gives the same rows (`rebuildProjections`). What depends on an offer's
 * settings (a payment's kind, who the closer is) is worked out when it is read (`derived.ts`), never stored.
 *
 * The one piece of configuration a projector reads is the offer's time zone, for the day a daily count lands on: a
 * zone change is followed by a rebuild.
 */

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const at = (v: unknown): Date | null => toInstant(v) ?? null;

/**
 * Facts the platform works out for a contact, an appointment or a recording. A vendor's snapshot never sets them: they
 * come from the projections when they are read, so a fact that carries one (a stale copy, a guess) cannot overrule them.
 */
export const DERIVED_KEYS = {
  contact: ["id", "paid", "paid_non_deposit", "deposit_paid", "payments_count", "cash_collected", "first_paid_at", "agreement_signed", "agreement_sent", "owner", "closer", "setter",
    "first_booked_at", "days_to_close", "revenue", "latest_appointment_id", "latest_recording_id", "has_upcoming_call", "records", "cards"],
  appointment: ["id", "outcome", "call_outcome", "pending_read", "started", "reschedules"],
  recording: ["caller", "closer", "set_until", "connected", "has_transcript"],
  payment: ["kind", "cleared", "contract_value", "outstanding", "prior_non_deposit_total", "running_total", "prior_total"],
} as const;

const without = (o: J, keys: readonly string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** A team member, as a key a count is filed under: their CRM user id when known, else the name as given. */
export const repKey = (p: unknown): string | null => {
  if (!isObj(p)) return str(p) ? `name:${str(p)}` : null;
  const id = str(p.ghl_user_id) ?? str(p.crm_user_id);
  if (id) return `crm:${id}`;
  const name = str(p.name) ?? str(p.first_name);
  return name ? `name:${name}` : null;
};

/** The rows a fact may touch, to be read before it is projected. */
export type Need = { table: ProjTable; id: string } | { table: ProjTable; query: ProjQuery };

export const paymentIdOf = (e: Pick<EventRow, "id" | "payload">): string =>
  str(e.payload.payment_id) ?? (isObj(e.payload.payment) ? str(e.payload.payment.id) : null) ?? str(e.payload.provider_payment_id) ?? `event:${e.id}`;
export const recordingIdOf = (p: J): string | null => str(p.recording_id) ?? (isObj(p.recording) ? str(p.recording.id) : null);

export function needs(e: EventRow): Need[] {
  const out: Need[] = [{ table: "people", query: {} }];
  if (e.contactId) {
    out.push({ table: "contacts_index", id: e.contactId });
    for (const t of ["appointments", "calls", "deals", "payments"] as const) out.push({ table: t, query: { where: { contactId: e.contactId } } });
  }
  if (e.appointmentId) { out.push({ table: "appointments", id: e.appointmentId }, { table: "calls", id: e.appointmentId }); }
  if (e.dealId) out.push({ table: "deals", id: e.dealId });
  if (e.type.startsWith("payment.")) out.push({ table: "payments", id: paymentIdOf(e) });
  const rec = recordingIdOf(e.payload);
  if (rec) out.push({ table: "calls", query: { where: { recordingId: rec } } }, { table: "calls", id: rec });
  return out;
}

/** The rows read for a fact: by table and id. */
export type Loaded = { [T in ProjTable]: Map<string, Rows[T]> };
export const emptyLoaded = (): Loaded => ({ contacts_index: new Map(), appointments: new Map(), calls: new Map(), deals: new Map(), payments: new Map(), people: new Map(), daily_facts: new Map() });

export type Change = { put: { table: ProjTable; row: Rows[ProjTable] } } | { inc: DailyFactRow };

/** One fact through the projectors: the rows it changes, from the rows it touches. Pure. */
export function project(e: EventRow, loaded: Loaded, offer: { zone: string }): Change[] {
  // the rows read are not touched: the work is on copies
  const own = Object.fromEntries(Object.entries(loaded).map(([t, m]) => [t, new Map(m as Map<string, unknown>)])) as unknown as Loaded;
  const w = new Work(e, own, offer.zone);
  w.run();
  return w.changes();
}

class Work {
  private dirty = new Set<string>();
  private incs: DailyFactRow[] = [];
  constructor(private e: EventRow, private t: Loaded, private zone: string) {}

  private get<T extends ProjTable>(table: T, id: string): Rows[T] | undefined { return this.t[table].get(id) as Rows[T] | undefined; }
  private put<T extends ProjTable>(table: T, row: Rows[T]) { (this.t[table] as Map<string, Rows[T]>).set(row.id, row); this.dirty.add(`${table}\u0000${row.id}`); }
  private all<T extends ProjTable>(table: T, q: ProjQuery = {}): Rows[T][] { return [...(this.t[table] as Map<string, Rows[T]>).values()].filter((r) => matches(r as unknown as J, q)); }
  changes(): Change[] {
    const out: Change[] = [];
    for (const k of this.dirty) {
      const [table, id] = k.split("\u0000") as [ProjTable, string];
      out.push({ put: { table, row: this.t[table].get(id)! } });
    }
    for (const i of this.incs) out.push({ inc: i });
    return out;
  }

  private get p(): J { return this.e.payload; }
  private get when(): Date { return this.e.occurredAt; }

  /** A count (and an amount) for the day `on` falls on, by closer, setter and source. */
  private count(metric: string, on: Date, dims: { closer?: string | null; setter?: string | null; source?: string | null } = {}, amount = 0) {
    const day = isoDay(on, this.zone), closer = dims.closer ?? "", setter = dims.setter ?? "", source = dims.source ?? "";
    this.incs.push({ offerId: this.e.offerId, id: [day, metric, closer, setter, source].join("|"), day, metric, closer, setter, source, n: 1, amount });
  }

  /** The appointment as it was before this fact. */
  private apptBefore: AppointmentRow | undefined;

  run() {
    const e = this.e;
    this.apptBefore = e.appointmentId ? this.get("appointments", e.appointmentId) : undefined;
    if (e.contactId) this.contact();
    if (e.appointmentId && (isObj(this.p.appointment) || e.type.startsWith("appointment."))) { this.appointment(); if (e.type !== "appointment.booked") this.countBooking(); }
    if (e.type.startsWith("appointment.") && !e.appointmentId) return undefined;
    switch (e.type) {
      case "lead.created": return this.e.contactId ? this.lead() : undefined;
      case "appointment.booked": return this.booked();
      case "appointment.rescheduled": return this.rescheduled();
      case "appointment.status_changed": case "appointment.cancelled": return this.status();
      case "appointment.outcome": case "appointment.outcome_recorded": return this.outcome();
      case "appointment.pending_read": return this.pending(true);
      case "appointment.pending_read_cleared": return this.pending(false);
      case "call.held": return this.held();
      case "call.logged": return this.dialed();
      case "recording.received": return this.recorded();
      case "call.closing": return this.closing();
      case "payment.received": case "payment.refunded": case "payment.failed": case "payment.unlinked": return this.payment();
      case "payment.linked": return this.linked();
      case "deal.opened": case "deal.won": case "deal.lost": case "deal.reopened": return this.ledgerDeal();
      case "crm.deal_written": case "card.moved": case "card.updated": return this.card();
      case "crm.deal_status_set": return this.cardStatus();
      case "crm.record_written": return this.record();
      case "agreement.sent": case "agreement.signed": case "agreement.voided": case "agreement.status_changed": return this.agreement();
      case "person.added": case "person.updated": case "person.removed": return this.person();
      case "eod.filed": return this.eod();
      case "contact.merged": return this.merged();
      default: return undefined;
    }
  }

  // ---- contacts ------------------------------------------------------------------------------------------------------

  private contactRow(): ContactRow {
    const id = this.e.contactId!;
    return this.get("contacts_index", id) ?? { offerId: this.e.offerId, id, crmId: null, phones: [], emails: [], mergedInto: null, attrs: {}, records: {}, agreement: null, leadAt: null, firstDialAt: null, speedToLeadMin: null, updatedAt: this.when };
  }

  private contact() {
    const c = { ...this.contactRow() };
    const snap = isObj(this.p.contact) ? without(this.p.contact, DERIVED_KEYS.contact) : {};
    c.attrs = { ...c.attrs, ...snap };
    c.crmId = str(c.attrs.ghl_contact_id) ?? str(c.attrs.crm_id) ?? c.crmId;
    const phone = normPhone(str(snap.phone)), email = normEmail(str(snap.email));
    if (phone && !c.phones.includes(phone)) c.phones = [...c.phones, phone];
    if (email && !c.emails.includes(email)) c.emails = [...c.emails, email];
    if (this.when > c.updatedAt) c.updatedAt = this.when;
    this.put("contacts_index", c);
  }

  private lead() {
    const c = { ...this.contactRow() };
    if (c.leadAt) return;
    c.leadAt = this.when;
    this.put("contacts_index", c);
    this.count("leads", this.when, { source: str(c.attrs.source) });
  }

  private merged() {
    const c = { ...this.contactRow(), mergedInto: str(this.p.into) };
    this.put("contacts_index", c);
  }

  private record() {
    const c = { ...this.contactRow() };
    const object = str(this.p.object);
    if (!object) return;
    c.records = { ...c.records, [object.replace(/^custom_objects\./, "")]: { key: str(this.p.key), id: str(this.p.record_id) } };
    this.put("contacts_index", c);
  }

  private agreement() {
    const c = { ...this.contactRow() };
    const a = isObj(this.p.agreement) ? this.p.agreement : {};
    const prior = c.agreement ?? {};
    const status = this.e.type === "agreement.signed" ? "signed" : this.e.type === "agreement.voided" ? "voided" : this.e.type === "agreement.sent" ? "sent" : str(a.status) ?? str(prior.status) ?? "sent";
    c.agreement = {
      ...prior, ...a, status,
      sent_at: str(a.sent_at) ?? str(prior.sent_at) ?? (this.e.type === "agreement.sent" ? this.when.toISOString() : null),
      signed_at: status === "signed" ? str(a.signed_at) ?? this.when.toISOString() : null,
    };
    this.put("contacts_index", c);
  }

  // ---- appointments and calls ------------------------------------------------------------------------------------------

  private apptRow(): AppointmentRow {
    const id = this.e.appointmentId!;
    return this.get("appointments", id) ?? {
      offerId: this.e.offerId, id, contactId: this.e.contactId, status: null, kind: null, startsAt: null, endsAt: null, bookedAt: null, bookingSource: null, setBy: null,
      closerKey: null, reschedules: 0, outcome: null, callOutcome: null, outcomeSource: null, outcomeAt: null, pendingRead: null, attrs: {}, updatedAt: this.when,
    };
  }

  private appointment() {
    const a = { ...this.apptRow() };
    const snap = isObj(this.p.appointment) ? without(this.p.appointment, DERIVED_KEYS.appointment) : {};
    a.attrs = { ...a.attrs, ...snap };
    const x = a.attrs;
    a.contactId = a.contactId ?? this.e.contactId;
    a.startsAt = at(x.starts_at) ?? a.startsAt;
    a.endsAt = at(x.ends_at) ?? a.endsAt;
    a.bookedAt = at(x.booked_at) ?? a.bookedAt;
    a.kind = (isObj(x.term) ? str(x.term.category) : null) ?? str(x.call_type) ?? str(x.kind) ?? a.kind;
    a.bookingSource = str(x.booking_source) ?? (x.self_booked === true ? "self" : x.self_booked === false ? "setter" : null) ?? a.bookingSource;
    a.setBy = str(x.set_by) ?? a.setBy;
    a.closerKey = repKey(x.closer) ?? a.closerKey;
    if (snap.status !== undefined) a.status = str(snap.status) ?? a.status;
    if (this.when > a.updatedAt) a.updatedAt = this.when;
    this.put("appointments", a);
    this.syncCall(a);
  }

  /** The booked call an appointment is: one row, beside the dialer's calls and the meeting recordings. */
  private syncCall(a: AppointmentRow) {
    const c = this.get("calls", a.id);
    const base: CallRow = c ?? {
      offerId: a.offerId, id: a.id, contactId: a.contactId, appointmentId: a.id, source: "booking", kind: null, booked: true, startsAt: null, held: null, outcome: null,
      repKey: null, recordingId: null, recording: null, startedAt: null, endedAt: null, durationSec: null, direction: null, connected: null, updatedAt: this.when,
    };
    const held = a.outcome === "showed" ? true : a.outcome === "noshow" ? false : base.held;
    this.put("calls", { ...base, contactId: a.contactId, kind: a.kind, startsAt: a.startsAt, repKey: a.closerKey, outcome: a.callOutcome ?? a.outcome ?? null, held, updatedAt: this.when > base.updatedAt ? this.when : base.updatedAt });
  }

  private booked() {
    const a = { ...this.apptRow() };
    if (!a.status) a.status = "booked";
    a.bookedAt ??= this.when;
    this.put("appointments", a);
    this.syncCall(a);
    this.countBooking();
  }

  /** A booking counts once, on the day it was made, the first time the appointment has a booked time. */
  private countBooking() {
    const a = this.get("appointments", this.e.appointmentId ?? "");
    if (!a?.bookedAt || this.apptBefore?.bookedAt) return;
    const source = str((this.get("contacts_index", this.e.contactId ?? "")?.attrs ?? {}).source);
    const dims = { closer: a.closerKey, setter: a.setBy ? `name:${a.setBy}` : null, source };
    this.count("booked", a.bookedAt, dims);
    if (a.bookingSource === "self") this.count("booked_self", a.bookedAt, dims);
    if (a.bookingSource === "setter") this.count("booked_set", a.bookedAt, dims);
  }

  private rescheduled() {
    const a = { ...this.apptRow() };
    a.reschedules += 1;
    this.put("appointments", a);
    const source = str((this.get("contacts_index", this.e.contactId ?? "")?.attrs ?? {}).source);
    this.count("reschedules", this.when, { closer: a.closerKey, source });
  }

  private status() {
    const a = { ...this.apptRow() };
    const s = this.p.status;
    const to = isObj(s) ? str(s.to) : str(s);
    a.status = this.e.type === "appointment.cancelled" ? "cancelled" : to ?? a.status;
    this.put("appointments", a);
    this.syncCall(a);
  }

  private outcome() {
    const a = { ...this.apptRow() };
    const outcome = str(this.p.outcome);
    if (!outcome) return;
    a.outcome = outcome;
    a.callOutcome = str(this.p.call_outcome);
    a.outcomeSource = str(this.p.outcome_source) ?? str(this.p.source);
    a.outcomeAt = this.when;
    this.put("appointments", a);
    this.syncCall(a);
  }

  private pending(on: boolean) {
    const a = { ...this.apptRow() };
    a.pendingRead = on ? { at: str(this.p.at) ?? this.when.toISOString(), intent: str(this.p.intent), confidence: num(this.p.confidence) } : null;
    this.put("appointments", a);
  }

  private held() {
    if (!this.e.appointmentId) return;
    const c = this.get("calls", this.e.appointmentId);
    if (c) this.put("calls", { ...c, held: true });
  }

  /** A recording's own facts, as the recorder said them; who the rep is, and the platform's reading of connected. */
  private recordingCall(id: string, source: CallRow["source"]): CallRow {
    const r = isObj(this.p.recording) ? without(this.p.recording, DERIVED_KEYS.recording) : {};
    const rep = isObj(this.p.recording) ? (this.p.recording.caller ?? this.p.recording.closer ?? this.p.caller) : this.p.caller;
    const existing = this.all("calls", { where: { recordingId: id } })[0] ?? this.get("calls", id);
    const started = at(r.started_at) ?? existing?.startedAt ?? this.when;
    const endedSaid = at(r.ended_at);
    const durationSec = num(this.p.duration_sec) ?? num(r.duration_sec) ?? (num(r.duration_min) !== null ? num(r.duration_min)! * 60 : null)
      ?? (endedSaid ? Math.round((endedSaid.getTime() - started.getTime()) / 1000) : null) ?? existing?.durationSec ?? null;
    const ended = endedSaid ?? existing?.endedAt ?? (durationSec !== null ? new Date(started.getTime() + durationSec * 1000) : null);
    const status = str(r.status) ?? str((existing?.recording ?? {}).status);
    const recording: J = { ...(existing?.recording ?? {}), ...r, id, ...(rep !== undefined ? { rep } : {}) };
    if (isObj(this.p.recording) && this.p.recording.has_transcript !== undefined && r.transcript_status === undefined) recording.transcript_status = this.p.recording.has_transcript ? "ready" : "none";
    return {
      offerId: this.e.offerId, id: existing?.id ?? id, contactId: this.e.contactId ?? existing?.contactId ?? null, appointmentId: this.e.appointmentId ?? existing?.appointmentId ?? null,
      source: existing?.source ?? source, kind: existing?.kind ?? null, booked: existing?.booked ?? false, startsAt: existing?.startsAt ?? started, held: existing?.held ?? null,
      outcome: existing?.outcome ?? null, repKey: repKey(rep) ?? existing?.repKey ?? null, recordingId: id, recording, startedAt: started, endedAt: ended, durationSec,
      direction: str(r.direction) ?? existing?.direction ?? null,
      // the dialer's own word, as v1 read it: a call the CRM marked connected that lasted more than no time
      connected: status === "connected" && !(durationSec !== null && durationSec <= 0),
      updatedAt: this.when,
    };
  }

  private dialed() {
    const id = recordingIdOf(this.p);
    if (!id) return;
    const prior = this.all("calls", { where: { recordingId: id } })[0];
    const c = this.recordingCall(id, "dialer");
    this.put("calls", c);
    if (prior) return;
    const outbound = c.direction !== "inbound";
    if (outbound) this.count("dials", c.startedAt!, { setter: c.repKey });
    if (outbound && c.connected) this.count("connected", c.startedAt!, { setter: c.repKey });
    if (outbound && this.e.contactId) {
      const k = { ...this.contactRow() };
      if (!k.firstDialAt || c.startedAt! < k.firstDialAt) {
        k.firstDialAt = c.startedAt;
        k.speedToLeadMin = k.leadAt && c.startedAt! >= k.leadAt ? Math.round((c.startedAt!.getTime() - k.leadAt.getTime()) / 60_000) : null;
        this.put("contacts_index", k);
      }
    }
  }

  private recorded() {
    const id = recordingIdOf(this.p);
    if (!id) return;
    if (this.e.appointmentId) {
      // a meeting recording of a booked call is that call's recording: one call, not two
      const own = this.recordingCall(id, "meeting");
      const booked = this.get("calls", this.e.appointmentId);
      if (booked) { this.put("calls", { ...booked, recordingId: id, recording: own.recording, startedAt: own.startedAt, endedAt: own.endedAt, durationSec: own.durationSec, repKey: booked.repKey ?? own.repKey, updatedAt: this.when }); return; }
      this.put("calls", { ...own, id: this.e.appointmentId, appointmentId: this.e.appointmentId, booked: false });
      return;
    }
    this.put("calls", this.recordingCall(id, "meeting"));
  }

  /** A call read as closing (handed on by Setter call logged, or linked to a booking by the team): the call is a closing call, of that booking when it names one. */
  private closing() {
    const id = recordingIdOf(this.p);
    if (!id) return;
    const known = this.all("calls", { where: { recordingId: id } })[0];
    // a fact that carries the recording (v1's call.closing did) makes the call if it is not known yet
    const c = known ?? (isObj(this.p.recording) ? this.recordingCall(id, str(this.p.recording.kind) === "phone" ? "dialer" : "meeting") : undefined);
    if (!c) return;
    this.put("calls", { ...c, appointmentId: this.e.appointmentId ?? c.appointmentId, kind: c.kind ?? "closing", updatedAt: this.when });
  }

  // ---- payments and deals ----------------------------------------------------------------------------------------------

  /** Whose a sale or a payment is: the closer and setter of the contact's latest call at or before it (else their latest). */
  private credit(on: Date): { closer: string | null; setter: string | null; source: string | null } {
    const appts = this.e.contactId ? this.all("appointments", { where: { contactId: this.e.contactId } }).filter((a) => a.status !== "cancelled" && a.startsAt) : [];
    const sorted = appts.sort((a, b) => b.startsAt!.getTime() - a.startsAt!.getTime() || (a.id < b.id ? 1 : -1));
    const a = sorted.find((x) => x.startsAt! <= on) ?? sorted[0];
    const source = str((this.get("contacts_index", this.e.contactId ?? "")?.attrs ?? {}).source);
    return { closer: a?.closerKey ?? null, setter: a?.setBy ? `name:${a.setBy}` : null, source };
  }

  private payment() {
    const id = paymentIdOf(this.e);
    const prior = this.get("payments", id);
    const status: PaymentRow["status"] = this.e.type === "payment.refunded" ? "refunded" : this.e.type === "payment.failed" ? "failed"
      : this.e.type === "payment.unlinked" ? ((str(this.p.status) as PaymentRow["status"] | null) ?? "succeeded") : "succeeded";
    const raw = num(this.p.amount) ?? 0;
    const amount = status === "refunded" ? -Math.abs(raw) : raw;
    const paidAt = at(this.p.paid_at) ?? this.when;
    const product = Object.fromEntries(["product_id", "plan_id", "plan", "product_name", "plan_name"].filter((k) => str(this.p[k]) !== null).map((k) => [k, str(this.p[k])]));
    const customer = Object.fromEntries([["email", "customer_email"], ["phone", "customer_phone"], ["member_id", "whop_member_id"]].filter(([, k]) => str(this.p[k!]) !== null).map(([n, k]) => [n, str(this.p[k!])]));
    const row: PaymentRow = {
      offerId: this.e.offerId, id, contactId: this.e.contactId ?? prior?.contactId ?? null, dealId: this.e.dealId ?? prior?.dealId ?? null,
      providerPaymentId: str(this.p.provider_payment_id) ?? prior?.providerPaymentId ?? null, status, amount, currency: str(this.p.currency) ?? prior?.currency ?? null, paidAt,
      product: { ...(prior?.product ?? {}), ...product }, refundOf: str(this.p.refund_of) ?? (isObj(this.p.raw) ? str(this.p.raw.payment_id) : null) ?? prior?.refundOf ?? null,
      customer: { ...(prior?.customer ?? {}), ...customer }, linkedBy: str(this.p.linked_by) ?? prior?.linkedBy ?? null, seq: prior?.seq ?? this.e.id, updatedAt: this.when,
    };
    this.put("payments", row);
    if (prior || !row.contactId || status === "failed") return;
    const credit = this.credit(paidAt);
    if (status === "succeeded") this.count("cash_gross", paidAt, credit, amount);
    if (status === "refunded") this.count("refunds", paidAt, credit, Math.abs(amount));
    this.count("cash_collected", paidAt, credit, amount);
  }

  private linked() {
    const id = paymentIdOf(this.e);
    const prior = this.get("payments", id);
    if (!prior || !this.e.contactId) return;
    this.put("payments", { ...prior, contactId: this.e.contactId, linkedBy: str(this.p.by) ?? "manual", updatedAt: this.when });
    if (prior.contactId || prior.status === "failed") return;
    const credit = this.credit(prior.paidAt);
    if (prior.status === "succeeded") this.count("cash_gross", prior.paidAt, credit, prior.amount);
    if (prior.status === "refunded") this.count("refunds", prior.paidAt, credit, Math.abs(prior.amount));
    this.count("cash_collected", prior.paidAt, credit, prior.amount);
  }

  private dealRow(id: string, kind: DealRow["kind"]): DealRow {
    return this.get("deals", id) ?? { offerId: this.e.offerId, id, contactId: this.e.contactId, kind, pipeline: null, crmId: null, stage: null, status: null, ownerKey: null, name: null, value: null, openedAt: null, wonAt: null, lostAt: null, seq: this.e.id, updatedAt: this.when };
  }

  private ledgerDeal() {
    if (!this.e.dealId) return;
    const d = { ...this.dealRow(this.e.dealId, "ledger") };
    const was = d.status;
    d.contactId ??= this.e.contactId;
    d.value = num(this.p.value) ?? num(this.p.contract_value) ?? d.value;
    d.openedAt ??= this.when;
    if (this.e.type === "deal.won") { d.status = "won"; d.wonAt = this.when; }
    else if (this.e.type === "deal.lost") { d.status = "lost"; d.lostAt = this.when; }
    else d.status = "open";
    d.updatedAt = this.when;
    this.put("deals", d);
    if (this.e.type === "deal.won" && was !== "won") this.count("closes", this.when, this.credit(this.when));
  }

  private card() {
    const moved = this.e.type === "card.moved";
    const crmId = str(this.p.deal_id) ?? str(this.p.crm_card) ?? str(this.p.card_id);
    if (!crmId) return;
    const d = { ...this.dealRow(`card:${crmId}`, "card") };
    d.crmId = crmId;
    d.contactId ??= this.e.contactId;
    d.pipeline = str(this.p.pipeline_id) ?? str(this.p.pipeline) ?? d.pipeline;
    d.stage = (moved ? str(this.p.to_stage) : str(this.p.stage)) ?? d.stage;
    d.status = (moved ? str(this.p.to_status) : str(this.p.status)) ?? d.status ?? "open";
    d.name = str(this.p.name) ?? d.name;
    // a deal moved without naming an owner keeps the one it had (the contact's latest card on that pipeline, when the CRM gave a new id)
    const prior = d.ownerKey ?? this.all("deals", { where: { contactId: this.e.contactId ?? "", kind: "card" } }).filter((x) => x.pipeline === d.pipeline && x.ownerKey).sort((a, b) => b.seq - a.seq)[0]?.ownerKey ?? null;
    d.ownerKey = repKey(isObj(this.p.owner) ? this.p.owner : str(this.p.owner) ? { ghl_user_id: this.p.owner } : null) ?? prior;
    d.value = num(this.p.value) ?? d.value;
    d.openedAt ??= this.when;
    d.seq = this.e.id;
    d.updatedAt = this.when;
    this.put("deals", d);
  }

  private cardStatus() {
    const pipeline = str(this.p.pipeline), status = str(this.p.status);
    if (!pipeline || !status || !this.e.contactId) return;
    const card = this.all("deals", { where: { contactId: this.e.contactId, kind: "card", pipeline } }).sort((a, b) => b.seq - a.seq)[0];
    if (card) this.put("deals", { ...card, status, updatedAt: this.when });
  }

  // ---- people ----------------------------------------------------------------------------------------------------------

  private person() {
    const p = isObj(this.p.person) ? this.p.person : {};
    const id = str(p.id);
    if (!id) return;
    const prior = this.get("people", id);
    const roles = Array.isArray(p.roles) ? p.roles.map(String) : str(p.role) ? [str(p.role)!] : prior?.roles ?? [];
    const row: PersonRow = {
      offerId: this.e.offerId, id, name: str(p.name) ?? prior?.name ?? null, email: normEmail(str(p.email)) || prior?.email || null,
      slackUserId: str(p.slack_user_id) ?? prior?.slackUserId ?? null, crmUserId: str(p.crm_user_id) ?? str(p.ghl_user_id) ?? prior?.crmUserId ?? null,
      roles, active: this.e.type !== "person.removed", eodDays: prior?.eodDays ?? [], updatedAt: this.when,
    };
    this.put("people", row);
  }

  private eod() {
    const id = str(this.p.user_id) ?? (isObj(this.p.person) ? str(this.p.person.id) : null);
    const day = str(this.p.day);
    const prior = id ? this.get("people", id) : undefined;
    if (!prior || !day || prior.eodDays.includes(day)) return;
    this.put("people", { ...prior, eodDays: [...prior.eodDays, day].sort() });
  }
}
