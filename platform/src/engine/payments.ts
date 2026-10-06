import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { emitEvent, type EventRow } from "./dispatch";

/**
 * The ledger (D21). Every payment the provider reports is recorded, linked to a person or not. Linking is a ladder,
 * most reliable first, and one unambiguous hit or nothing: member id already seen on a linked payment, then email,
 * then phone (last ten digits). Guessing attributes revenue to the wrong person; an unlinked row gets fixed by hand.
 */
export type PaymentInput = {
  providerPaymentId: string; provider?: string;
  amount: number;                       // negative for a refund
  currency?: string; installmentNo?: number;
  status: "succeeded" | "failed" | "refunded";
  paidAt: Date;
  email?: string; phone?: string; memberId?: string;
  raw?: Record<string, unknown>;
};
export type PaymentRow = { id: string; company_id: string; contact_id: string | null; opportunity_id: string | null; provider: string; whop_payment_id: string; amount: string; currency: string; status: string; kind: string | null; customer_email: string | null; customer_phone: string | null; whop_member_id: string | null; link_status: string; linked_by: string | null; paid_at: Date };
export type RecordResult =
  | { outcome: "duplicate"; payment: PaymentRow }
  | { outcome: "linked"; payment: PaymentRow; event: EventRow; contactId: string; healed: number }
  | { outcome: "unlinked"; payment: PaymentRow; event: EventRow };

export const normEmail = (e?: string | null) => e?.trim().toLowerCase() || undefined;
export const phoneKey = (p?: string | null) => { const d = (p ?? "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : undefined; };
const money = (n: number) => Math.round(n * 100) / 100;
/** Over by a rounding cent still clears. */
export const cleared = (total: number, contractValue: number | null) => contractValue != null && total >= contractValue - 0.01;

/** deposit / installment / balance / paid_in_full / refund, from what came before. */
export function deriveKind(amount: number, priorTotal: number, contractValue: number | null, status: PaymentInput["status"]): string {
  if (status === "failed") return "failed";
  if (amount < 0 || status === "refunded") return "refund";
  if (priorTotal <= 0 && cleared(amount, contractValue)) return "paid_in_full";
  if (cleared(money(priorTotal + amount), contractValue)) return "balance";
  if (priorTotal <= 0) return "deposit";
  return "installment";
}

/** One unambiguous match or nothing. */
export async function resolvePayer(c: PoolClient, companyId: string, p: Pick<PaymentInput, "email" | "phone" | "memberId">): Promise<{ contactId: string; by: string } | null> {
  if (p.memberId) {
    const rows = await many<{ contact_id: string }>(c, "select distinct contact_id from payments where company_id=$1 and whop_member_id=$2 and contact_id is not null", [companyId, p.memberId]);
    if (rows.length === 1) return { contactId: rows[0].contact_id, by: "member_id" };
  }
  const email = normEmail(p.email);
  if (email) {
    const rows = await many<{ contact_id: string }>(c, "select distinct i.contact_id from contact_identifiers i join contacts ct on ct.id=i.contact_id where i.company_id=$1 and i.kind='email' and i.value=$2 and ct.merged_into is null", [companyId, email]);
    if (rows.length === 1) return { contactId: rows[0].contact_id, by: "email" };
  }
  const key = phoneKey(p.phone);
  if (key) {
    const rows = await many<{ contact_id: string }>(c, "select distinct i.contact_id from contact_identifiers i join contacts ct on ct.id=i.contact_id where i.company_id=$1 and i.kind='phone' and right(regexp_replace(i.value, '\\D', '', 'g'), 10)=$2 and ct.merged_into is null", [companyId, key]);
    if (rows.length === 1) return { contactId: rows[0].contact_id, by: "phone" };
  }
  return null;
}

/** The pursuit a payment belongs to: the contact's latest open or won opportunity; a paying customer with none gets one. */
async function opportunityFor(c: PoolClient, companyId: string, contactId: string, payment: PaymentRow): Promise<{ id: string; contract_value: number | null; status: string }> {
  let opp = await one<{ id: string; contract_value: string | null; status: string }>(c, "select id, contract_value, status from opportunities where company_id=$1 and contact_id=$2 and status in ('open','won') order by (status='open') desc, opened_at desc limit 1", [companyId, contactId]);
  if (!opp) {
    opp = await one<{ id: string; contract_value: string | null; status: string }>(c, "insert into opportunities (company_id, contact_id, opened_by) values ($1,$2,'payment') returning id, contract_value, status", [companyId, contactId]);
    await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: opp!.id, appointment_id: null, event_type: "opportunity.opened", source: "whop", data: { by: "payment", payment_id: payment.id } });
  }
  if (opp!.contract_value == null) {
    const d = await one<{ v: string | null }>(c, "select contract_value_default as v from companies where id=$1", [companyId]);
    if (d?.v != null) { await c.query("update opportunities set contract_value=$2 where id=$1 and contract_value is null", [opp!.id, d.v]); opp!.contract_value = d.v; }
  }
  return { id: opp!.id, contract_value: opp!.contract_value == null ? null : Number(opp!.contract_value), status: opp!.status };
}

/** Totals for a pursuit: succeeded charges plus negative refunds, this payment excluded. */
async function priorTotal(c: PoolClient, opportunityId: string, excludePaymentId: string): Promise<number> {
  const r = await one<{ t: string }>(c, "select coalesce(sum(amount),0) as t from payments where opportunity_id=$1 and status in ('succeeded','refunded') and id<>$2", [opportunityId, excludePaymentId]);
  return money(Number(r!.t));
}

/** Link + settle: attach the person and pursuit, derive the kind, heal earlier orphans of the same identity, emit the event. */
async function settle(c: PoolClient, companyId: string, contactId: string, payment: PaymentRow, linkedBy: string): Promise<{ event: EventRow; healed: number }> {
  const opp = await opportunityFor(c, companyId, contactId, payment);
  // heal: earlier unlinked rows with the same member id or email now belong to this person and this pursuit
  const healed = await many<{ id: string }>(c, `update payments set contact_id=$2, opportunity_id=$3, link_status='linked', linked_by='heal'
    where company_id=$1 and link_status='unlinked' and id<>$4 and ((whop_member_id is not null and whop_member_id=$5) or (customer_email is not null and customer_email=$6)) returning id`,
    [companyId, contactId, opp.id, payment.id, payment.whop_member_id ?? "", payment.customer_email ?? ""]);
  for (const h of healed) await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: opp.id, appointment_id: null, event_type: "payment.linked", source: "engine", data: { payment_id: h.id, by: "heal", via: payment.id } });
  const prior = await priorTotal(c, opp.id, payment.id);
  const amount = Number(payment.amount);
  const kind = deriveKind(amount, prior, opp.contract_value, payment.status as PaymentInput["status"]);
  await c.query("update payments set contact_id=$2, opportunity_id=$3, kind=$4, link_status='linked', linked_by=$5 where id=$1", [payment.id, contactId, opp.id, kind, linkedBy]);
  const running = payment.status === "failed" ? prior : money(prior + amount);
  const isCleared = cleared(running, opp.contract_value);
  const type = payment.status === "succeeded" ? "payment.received" : payment.status === "refunded" ? "payment.refunded" : "payment.failed";
  const ev = await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: opp.id, appointment_id: null, event_type: type, source: "whop", occurred_at: payment.paid_at,
    data: { payment_id: payment.id, provider_payment_id: payment.whop_payment_id, amount, currency: payment.currency, kind, paid_at: payment.paid_at.toISOString(), prior_total: prior, running_total: running, contract_value: opp.contract_value, outstanding: opp.contract_value == null ? null : money(Math.max(opp.contract_value - running, 0)), cleared: isCleared, linked_by: linkedBy, customer_email: payment.customer_email, whop_member_id: payment.whop_member_id } });
  if (payment.status === "succeeded") {
    const co = await one<{ opp_won_on: string }>(c, "select opp_won_on from companies where id=$1", [companyId]);
    if (opp.status === "open" && co?.opp_won_on === "first_payment") {
      await c.query("update opportunities set status='won', won_at=now() where id=$1 and status='open'", [opp.id]);
      await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: opp.id, appointment_id: null, event_type: "opportunity.won", source: "engine", data: { by: "first_payment" } });
    }
    if (isCleared) {
      const already = await one(c, "select 1 from events where opportunity_id=$1 and event_type='payment.paid_in_full'", [opp.id]);
      if (!already) await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: opp.id, appointment_id: null, event_type: "payment.paid_in_full", source: "engine", data: { total: running, contract_value: opp.contract_value } });
    }
  }
  return { event: ev, healed: healed.length };
}

/** Records a provider payment. Idempotent on (provider, payment id). `forceContactId` is for callers that already know the person (tests, manual entry). */
export async function recordPayment(c: PoolClient, companyId: string, input: PaymentInput, forceContactId?: string): Promise<RecordResult> {
  const provider = input.provider ?? "whop";
  const email = normEmail(input.email), phone = input.phone?.trim() || null;
  const inserted = await one<PaymentRow>(c, `insert into payments (company_id, provider, whop_payment_id, amount, currency, installment_no, status, customer_email, customer_phone, whop_member_id, link_status, paid_at, raw)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unlinked',$11,$12) on conflict (company_id, provider, whop_payment_id) do nothing returning *`,
    [companyId, provider, input.providerPaymentId, input.amount, (input.currency ?? "USD").toUpperCase(), input.installmentNo ?? null, input.status, email ?? null, phone, input.memberId ?? null, input.paidAt, input.raw ?? {}]);
  if (!inserted) {
    const prior = (await one<PaymentRow>(c, "select * from payments where company_id=$1 and provider=$2 and whop_payment_id=$3", [companyId, provider, input.providerPaymentId]))!;
    return { outcome: "duplicate", payment: prior };
  }
  const match = forceContactId ? { contactId: forceContactId, by: "known" } : await resolvePayer(c, companyId, input);
  if (match) {
    const { event, healed } = await settle(c, companyId, match.contactId, inserted, match.by);
    return { outcome: "linked", payment: (await one<PaymentRow>(c, "select * from payments where id=$1", [inserted.id]))!, event, contactId: match.contactId, healed };
  }
  const ev = await emitEvent(c, { company_id: companyId, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "payment.unlinked", source: "whop", occurred_at: input.paidAt,
    data: { payment_id: inserted.id, provider_payment_id: input.providerPaymentId, amount: input.amount, currency: inserted.currency, status: input.status, customer_email: email ?? null, customer_phone: phone, whop_member_id: input.memberId ?? null } });
  return { outcome: "unlinked", payment: inserted, event: ev };
}

/** A person links an orphan to a contact from the dashboard. The payment then settles exactly as if it had matched on arrival. */
export async function linkPayment(c: PoolClient, companyId: string, paymentId: string, contactId: string): Promise<{ event: EventRow; healed: number }> {
  const p = await one<PaymentRow>(c, "select * from payments where company_id=$1 and id=$2", [companyId, paymentId]);
  if (!p) throw new Error("payment not found");
  if (p.link_status === "linked") throw new Error("payment is already linked");
  const ct = await one(c, "select 1 from contacts where company_id=$1 and id=$2", [companyId, contactId]);
  if (!ct) throw new Error("contact not found");
  // remember the identity so the next payment from this buyer links on its own
  if (p.customer_email) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3) on conflict (company_id, kind, value) do nothing", [companyId, contactId, p.customer_email]);
  const out = await settle(c, companyId, contactId, p, "manual");
  await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: out.event.opportunity_id, appointment_id: null, event_type: "payment.linked", source: "user", data: { payment_id: p.id, by: "manual" } });
  return out;
}

export const unlinkedPayments = (c: PoolClient, companyId: string) => many<PaymentRow>(c, "select * from payments where company_id=$1 and link_status='unlinked' order by paid_at desc", [companyId]);
