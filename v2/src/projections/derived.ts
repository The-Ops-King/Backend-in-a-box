import type { z } from "zod";
import type { Tx } from "@/engine/store";
import type { OfferRow } from "@/engine/types";
import { DERIVED_KEYS, recordingIdOf } from "./projector";
import type { AppointmentRow, CallRow, ContactRow, DealRow, PaymentRow, PersonRow } from "./tables";
import { FACT_SETTINGS, type FactSetting } from "./facts";
export { DERIVED_FACTS, FACT_SETTINGS, derivedFactOf, type FactSetting } from "./facts";

/**
 * What a run reads about its subjects, from the projections: the contact, appointment, deal, payment, recording and
 * agreement as the facts left them, and the facts the platform works out from them (paid beyond a deposit, signed,
 * the next call, owner / closer / setter, record keys and cards, the payment's kind, the Set window).
 *
 * Every worked-out fact that rests on a business rule reads the rule's parameters from the offer's typed settings
 * (`DERIVED_FACTS`), never from code: while one it needs is unset, the fact is not there (a template reading it is
 * blank, a condition on it is false), and a workflow that reads it cannot be enabled (`validateWorkflow` lists the
 * settings it requires).
 */

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
const money = (n: number) => Math.round(n * 100) / 100;

/** A setting's value when it is set and of its type; else undefined (and every fact that needs it is not there). */
export function factSetting<K extends FactSetting>(settings: J, key: K): z.infer<(typeof FACT_SETTINGS)[K]["type"]> | undefined {
  const v = settings[key];
  if (v === undefined || v === null || v === "") return undefined;
  const r = FACT_SETTINGS[key].type.safeParse(v);
  return r.success ? (r.data as never) : undefined;
}


// ---- the rules --------------------------------------------------------------------------------------------------------

/** A word "deposit", whole and in any case, as v1's naming convention reads a product or plan name. */
export const DEPOSIT_WORD = /(?<![\p{L}\p{N}])deposit(?![\p{L}\p{N}])/iu;

/** Whether a payment is a deposit, by the offer's rule; undefined while the rule is not set. */
export function isDeposit(p: Pick<PaymentRow, "product">, settings: J): boolean | undefined {
  const products = factSetting(settings, "payments.deposit_products"), byName = factSetting(settings, "payments.deposit_by_name");
  if (products === undefined || byName === undefined) return undefined;
  const pr = p.product;
  if (products.length) return ["product_id", "plan_id", "plan"].some((k) => typeof pr[k] === "string" && products.includes((pr[k] as string).trim()));
  return byName && (DEPOSIT_WORD.test(String(pr.product_name ?? "")) || DEPOSIT_WORD.test(String(pr.plan_name ?? "")));
}

/** v1's kinds: failed, refund, deposit, then paid in full (first money clears the price), balance (this clears it), installment. */
export function paymentKind(amount: number, status: PaymentRow["status"], prior: number, deposit: boolean, cleared: (total: number) => boolean): string {
  if (status === "failed") return "failed";
  if (amount < 0 || status === "refunded") return "refund";
  if (deposit) return "deposit";
  if (prior <= 0 && cleared(amount)) return "paid_in_full";
  if (cleared(money(prior + amount))) return "balance";
  return "installment";
}

// ---- reading the subjects ------------------------------------------------------------------------------------------------

export type Team = { people: PersonRow[] };

/** A person as a step reads them. */
export function personView(p: PersonRow): J {
  const first = p.name?.trim().split(/\s+/)[0];
  return { id: p.id, name: p.name ?? undefined, first_name: first, email: p.email ?? undefined, ghl_user_id: p.crmUserId ?? undefined, slack_user_id: p.slackUserId ?? undefined, mention: p.slackUserId ? `<@${p.slackUserId}>` : p.name ?? undefined, roles: p.roles };
}

/** Someone named by a key a projection filed (a CRM user id, or a name), as the team knows them; else as the fact named them. */
export function repView(key: string | null | undefined, team: Team, said?: unknown): J | undefined {
  const person = !key ? undefined : key.startsWith("crm:") ? team.people.find((p) => p.crmUserId === key.slice(4))
    : team.people.find((p) => (p.name ?? "").toLowerCase() === key.slice(5).toLowerCase());
  const snap = isObj(said) ? said : undefined;
  if (person) return { ...(snap ?? {}), ...personView(person) };
  if (snap) {
    const name = str(snap.name) ?? str(snap.first_name);
    return { ...snap, ...(name && !snap.first_name ? { first_name: name.split(/\s+/)[0] } : {}), ...(name && !snap.mention ? { mention: name } : {}) };
  }
  if (key?.startsWith("name:")) { const name = key.slice(5); return { name, first_name: name.split(/\s+/)[0], mention: name }; }
  return undefined;
}

const notCancelled = (a: AppointmentRow) => a.status !== "cancelled";
const byStartDesc = (a: AppointmentRow, b: AppointmentRow) => (b.startsAt?.getTime() ?? 0) - (a.startsAt?.getTime() ?? 0) || (a.id < b.id ? 1 : -1);

export type SubjectRefs = { contactId: string | null; appointmentId: string | null; dealId: string | null; paymentId?: string | null; recordingId?: string | null };

/** The ids of a payment and a recording a run's starting event names. */
export function eventRefs(event: J | undefined): { paymentId: string | null; recordingId: string | null } {
  if (!event) return { paymentId: null, recordingId: null };
  const fallback = str(event.type)?.startsWith("payment.") && event.fact_id !== undefined ? `event:${String(event.fact_id)}` : undefined;
  return { paymentId: str(event.payment_id) ?? (isObj(event.payment) ? str(event.payment.id) : undefined) ?? str(event.provider_payment_id) ?? fallback ?? null, recordingId: recordingIdOf(event) };
}

type Read = { contact?: J; appointment?: J; deal?: J; payment?: J; recording?: J; agreement?: J };

/** Every subject root a run reads, from the projections, with the worked-out facts its offer's settings allow. */
export async function readSubjects(tx: Tx, x: { offer: OfferRow; settings: J; now: Date; refs: SubjectRefs }): Promise<Read> {
  const { offer, settings, now, refs } = x;
  const team: Team = { people: await tx.projFind("people", offer.id) };
  const out: Read = {};
  let contact: ContactRow | undefined, appts: AppointmentRow[] = [], calls: CallRow[] = [], deals: DealRow[] = [], pays: PaymentRow[] = [];
  if (refs.contactId) {
    [contact, appts, calls, deals, pays] = await Promise.all([
      tx.projGet("contacts_index", offer.id, refs.contactId), tx.projFind("appointments", offer.id, { where: { contactId: refs.contactId } }),
      tx.projFind("calls", offer.id, { where: { contactId: refs.contactId } }), tx.projFind("deals", offer.id, { where: { contactId: refs.contactId } }),
      tx.projFind("payments", offer.id, { where: { contactId: refs.contactId } }),
    ]);
  }
  const ledgerDeal = refs.dealId ? await tx.projGet("deals", offer.id, refs.dealId) : deals.filter((d) => d.kind === "ledger" && (d.status === "open" || d.status === "won")).sort((a, b) => (a.status === "open" ? -1 : 1) - (b.status === "open" ? -1 : 1) || b.seq - a.seq)[0];
  const cv = ledgerDeal?.value ?? factSetting(settings, "payments.contract_value");

  if (refs.contactId) out.contact = contactView({ id: refs.contactId, contact, appts, calls, deals, pays, settings, team, now, appointmentId: refs.appointmentId, contractValue: cv });
  if (contact?.agreement) out.agreement = { ...contact.agreement, signed: contact.agreement.status === "signed" };

  if (refs.appointmentId) {
    const a = appts.find((r) => r.id === refs.appointmentId) ?? (await tx.projGet("appointments", offer.id, refs.appointmentId));
    out.appointment = a ? appointmentView(a, team, now) : { id: refs.appointmentId };
  }
  if (refs.dealId) out.deal = ledgerDeal ? { id: ledgerDeal.id, status: ledgerDeal.status ?? undefined, value: ledgerDeal.value ?? undefined, opened_at: iso(ledgerDeal.openedAt), won_at: iso(ledgerDeal.wonAt), lost_at: iso(ledgerDeal.lostAt) } : { id: refs.dealId };

  if (refs.paymentId) {
    const p = pays.find((r) => r.id === refs.paymentId) ?? (await tx.projGet("payments", offer.id, refs.paymentId));
    // the payments before it are its person's; a payment nobody is linked to has none before it
    if (p) out.payment = paymentView(p, !p.contactId ? [p] : p.contactId === refs.contactId ? pays : await tx.projFind("payments", offer.id, { where: { contactId: p.contactId } }), settings, cv);
  }
  if (refs.recordingId) {
    const c = calls.find((r) => r.recordingId === refs.recordingId) ?? (await tx.projFind("calls", offer.id, { where: { recordingId: refs.recordingId } }))[0];
    if (c) out.recording = recordingView(c, team, settings);
  }
  return out;
}

function contactView(x: { id: string; contact: ContactRow | undefined; appts: AppointmentRow[]; calls: CallRow[]; deals: DealRow[]; pays: PaymentRow[]; settings: J; team: Team; now: Date; appointmentId: string | null; contractValue: number | undefined }): J {
  const { contact, appts, settings, team } = x;
  const attrs = { ...(contact?.attrs ?? {}) };
  const name = str(attrs.name) ?? ([str(attrs.first_name), str(attrs.last_name)].filter(Boolean).join(" ") || undefined);
  const first = str(attrs.first_name) ?? name?.split(/\s+/)[0];
  const v: J = { ...attrs, id: x.id, ...(name ? { name } : {}), ...(first ? { first_name: first } : {}), ...(contact?.crmId && !attrs.ghl_contact_id ? { ghl_contact_id: contact.crmId } : {}) };
  for (const k of DERIVED_KEYS.contact) if (k !== "id") delete v[k];

  // payments: cash is net of refunds; a deposit is told by the offer's rule
  const ok = x.pays.filter((p) => p.status === "succeeded"), counted = x.pays.filter((p) => p.status === "succeeded" || p.status === "refunded");
  v.paid = ok.length > 0;
  v.payments_count = ok.length;
  v.cash_collected = money(counted.reduce((n, p) => n + p.amount, 0));
  const firstPaid = ok.map((p) => p.paidAt).sort((a, b) => a.getTime() - b.getTime())[0];
  v.first_paid_at = iso(firstPaid) ?? null;
  if (factSetting(settings, "payments.deposit_products") !== undefined && factSetting(settings, "payments.deposit_by_name") !== undefined) {
    v.paid_non_deposit = ok.some((p) => isDeposit(p, settings) === false);
    v.deposit_paid = ok.some((p) => isDeposit(p, settings) === true);
  }
  // the agreement
  v.agreement_signed = contact?.agreement?.status === "signed";
  v.agreement_sent = !!contact?.agreement;
  // bookings
  const live = appts.filter(notCancelled).sort(byStartDesc);
  const firstBooked = live.map((a) => a.startsAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0];
  if (firstBooked) v.first_booked_at = iso(firstBooked);
  if (firstBooked && firstPaid) v.days_to_close = Math.max(0, Math.round((firstPaid.getTime() - firstBooked.getTime()) / 86_400_000));
  if (live[0]) v.latest_appointment_id = live[0].id;
  const rec = x.calls.filter((c) => c.recordingId && c.startedAt).sort((a, b) => b.startedAt!.getTime() - a.startedAt!.getTime())[0];
  if (rec) v.latest_recording_id = rec.recordingId;
  v.has_upcoming_call = appts.some((a) => a.kind === "closing" && a.status !== "cancelled" && a.status !== "noshow" && !!a.startsAt && a.startsAt > x.now && a.id !== x.appointmentId);
  if (x.contractValue !== undefined) v.revenue = x.contractValue;
  // the CRM records we wrote, by object and by what each is (crm.object_<role> names the object)
  const records: J = { ...(contact?.records ?? {}) };
  for (const [k, val] of Object.entries(settings)) if (k.startsWith("crm.object_") && typeof val === "string") { const r = records[val.replace(/^custom_objects\./, "")]; if (r) records[k.slice("crm.object_".length)] = r; }
  v.records = records;
  // the contact's open card on each of the offer's pipelines (crm.pipeline_<name>)
  const cards: J = {};
  const cardsOn = (name: string, pid: string) => x.deals.filter((d) => d.kind === "card" && (d.pipeline === pid || d.pipeline === name));
  for (const [k, pid] of Object.entries(settings)) {
    if (!k.startsWith("crm.pipeline_") || typeof pid !== "string") continue;
    const name = k.slice("crm.pipeline_".length);
    const open = cardsOn(name, pid).filter((d) => d.status === "open").sort((a, b) => b.seq - a.seq)[0];
    if (open) cards[name] = { id: open.crmId ?? "", stage: open.stage ?? undefined, name: open.name ?? undefined, owner: repView(open.ownerKey, team) };
  }
  v.cards = cards;
  // owner, closer, setter
  const ownerId = str(attrs.assigned_user_id) ?? str(attrs.owner_id), fallback = str(settings["crm.default_closer"]);
  const owner = ownerId ? repView(`crm:${ownerId}`, team) : fallback ? repView(`crm:${fallback}`, team) : undefined;
  if (owner) v.owner = { ...owner, inherited: !ownerId };
  const closerFrom = factSetting(settings, "people.closer_from");
  if (closerFrom) {
    for (const from of closerFrom) {
      let c: J | undefined;
      if (from === "closer_card") {
        const pid = str(settings["crm.pipeline_closer"]);
        // the card's owner, as v1 read it: a card nobody owns names no closer
        const card = pid ? cardsOn("closer", pid).filter((d) => (d.status === "open" || d.status === "won") && d.ownerKey).sort((a, b) => (a.status === "open" ? -1 : 1) - (b.status === "open" ? -1 : 1) || b.seq - a.seq)[0] : undefined;
        c = card ? repView(card.ownerKey, team) : undefined;
      } else if (from === "contact_owner") c = owner;
      else if (from === "latest_call") c = live[0] ? repView(live[0].closerKey, team, live[0].attrs.closer) : undefined;
      if (c) { v.closer = { ...c, from }; break; }
    }
  }
  const setterFrom = factSetting(settings, "people.setter_from");
  if (setterFrom) {
    for (const from of setterFrom) {
      const n = from === "booking" ? str(live[0]?.setBy) : str((attrs.fields as J | undefined)?.[from.slice("field:".length)]);
      if (n) { v.setter = repView(`name:${n.trim()}`, team); break; }
    }
  }
  return v;
}

export function appointmentView(a: AppointmentRow, team: Team, now: Date): J {
  const v: J = { ...a.attrs, id: a.id };
  for (const k of DERIVED_KEYS.appointment) if (k !== "id") delete v[k];
  return {
    ...v, status: a.status ?? undefined, kind: a.kind ?? undefined, starts_at: iso(a.startsAt) ?? v.starts_at, ends_at: iso(a.endsAt) ?? v.ends_at,
    booked_at: iso(a.bookedAt) ?? v.booked_at, booking_source: a.bookingSource ?? undefined, set_by: a.setBy ?? undefined,
    closer: repView(a.closerKey, team, a.attrs.closer), outcome: a.outcome, call_outcome: a.callOutcome, pending_read: a.pendingRead,
    started: !!a.startsAt && a.startsAt.getTime() <= now.getTime(), reschedules: a.reschedules,
  };
}

/** A payment, with what came before it (in the order they were recorded) and its kind by the offer's rule. */
export function paymentView(p: PaymentRow, all: PaymentRow[], settings: J, contractValue: number | undefined): J {
  const before = all.filter((x) => x.seq < p.seq && x.id !== p.id && (x.status === "succeeded" || x.status === "refunded"));
  const prior = money(before.reduce((n, x) => n + x.amount, 0));
  const running = p.status === "failed" ? prior : money(prior + p.amount);
  const tol = factSetting(settings, "payments.cleared_tolerance");
  const v: J = {
    id: p.id, amount: p.amount, currency: p.currency ?? undefined, status: p.status, paid_at: p.paidAt.toISOString(), provider_payment_id: p.providerPaymentId ?? undefined,
    linked_by: p.linkedBy ?? undefined, ...p.product, customer_email: p.customer.email, customer_phone: p.customer.phone, whop_member_id: p.customer.member_id,
    prior_total: prior, running_total: running,
  };
  if (contractValue !== undefined) { v.contract_value = contractValue; v.outstanding = money(Math.max(contractValue - running, 0)); }
  const cleared = contractValue !== undefined && tol !== undefined ? (t: number) => t >= contractValue - tol : undefined;
  if (cleared) v.cleared = cleared(running);
  const dep = isDeposit(p, settings);
  if (dep !== undefined) {
    const depositIds = new Set(all.filter((x) => x.status === "succeeded" && isDeposit(x, settings)).flatMap((x) => [x.id, x.providerPaymentId].filter(Boolean) as string[]));
    v.prior_non_deposit_total = money(before.filter((x) => !(x.status === "succeeded" && isDeposit(x, settings)) && !(x.status === "refunded" && x.refundOf && depositIds.has(x.refundOf))).reduce((n, x) => n + x.amount, 0));
    if (cleared) v.kind = paymentKind(p.amount, p.status, prior, dep, cleared);
  }
  return v;
}

export function recordingView(c: CallRow, team: Team, settings: J): J {
  const r = { ...(c.recording ?? {}) };
  const rep = repView(c.repKey, team, r.rep);
  delete r.rep;
  const ts = String(r.transcript_status ?? "");
  const v: J = {
    ...r, id: c.recordingId, kind: str(r.kind) ?? (c.source === "dialer" ? "phone" : "meeting"), started_at: iso(c.startedAt), ended_at: iso(c.endedAt), duration_sec: c.durationSec ?? undefined,
    duration_min: c.durationSec !== null ? Math.round(c.durationSec / 60) : r.duration_min, direction: c.direction ?? undefined, connected: !!c.connected,
    has_transcript: ts === "ready" || ts === "at_source", caller: rep, closer: rep, appointment_id: c.appointmentId ?? undefined,
  };
  const within = factSetting(settings, "setter_result.set_within_min");
  if (within !== undefined) v.set_until = new Date((c.endedAt ?? c.startedAt ?? new Date(0)).getTime() + within * 60_000).toISOString();
  return v;
}
