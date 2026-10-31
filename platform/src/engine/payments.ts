import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { dispatchEvent, emitEvent, type EventRow } from "./dispatch";
import { companyScopeTag, inScope } from "./scope";
import { nameThePayment, saysDeposit } from "./deposit-names";
import type { Adapters, Company, ObjectRecord } from "@/adapters/types";
import { SETTING_DEFAULTS } from "./setting-defaults";

/**
 * The ledger (D21). Every payment the provider reports is recorded, linked to a person or not. Linking is a ladder,
 * most reliable first, and one unambiguous hit or nothing: member id already seen on a linked payment, then email,
 * then phone (last ten digits). Guessing attributes revenue to the wrong person; an unlinked row gets fixed by hand.
 * D117: with a scope tag, a hit on someone out of scope is no hit: the location holds the other business's people too, so the
 * payment stays unlinked and the team links it by hand (a person's decision, which settles as before).
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
export type PaymentRow = { id: string; company_id: string; contact_id: string | null; opportunity_id: string | null; provider: string; whop_payment_id: string; amount: string; currency: string; status: string; kind: string | null; customer_email: string | null; customer_phone: string | null; whop_member_id: string | null; link_status: string; linked_by: string | null; paid_at: Date; raw?: Record<string, unknown> | null };
export type RecordResult =
  | { outcome: "duplicate"; payment: PaymentRow }
  | { outcome: "linked"; payment: PaymentRow; event: EventRow; contactId: string; healed: number }
  | { outcome: "unlinked"; payment: PaymentRow; event: EventRow }
  | { outcome: "skipped"; why: string };

import { normEmail } from "./identity";
export const phoneKey = (p?: string | null) => { const d = (p ?? "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : undefined; };
const money = (n: number) => Math.round(n * 100) / 100;
/** Over by a rounding cent still clears. */
export const cleared = (total: number, contractValue: number | null) => contractValue != null && total >= contractValue - 0.01;

/**
 * deposit / installment / balance / paid_in_full / refund, from what came before. D119: a deposit is a payment for one of the
 * company's declared deposit products, or (addendum) for a product or plan named with the word "deposit" (`isDeposit`), never a
 * guess from the amount: a first payment short of the price is the first installment. A deposit counts toward the price, so the payment that clears it after a deposit is the balance.
 */
export function deriveKind(amount: number, priorTotal: number, contractValue: number | null, status: PaymentInput["status"], deposit = false, rules?: PayRules & { reason?: string | null }): string {
  if (status === "failed") return "failed";
  if (amount < 0 || status === "refunded") return "refund";
  if (deposit) return "deposit";
  if (rules?.fullPrices.length) {
    // D270 (Tyler, 2026-10-30), every number and word the offer's own setting: under its deposit threshold is a deposit; one payment
    // of a full price (or up to its slack under it), for a billing reason it counts, is paid in full; the payment that brings the
    // total to the deal's price is its balance
    if (rules.depositUnder !== null && amount > 0 && amount < rules.depositUnder) return "deposit";
    if (fullPriceOf(amount, rules) !== null && fullReason(rules.reason, rules)) return "paid_in_full";
    if (clearedBy(money(priorTotal + amount), contractValue ?? rules.fullPrices[0] ?? null, rules.slack)) return "balance";
    return "installment";
  }
  if (priorTotal <= 0 && cleared(amount, contractValue)) return "paid_in_full";
  if (cleared(money(priorTotal + amount), contractValue)) return "balance";
  return "installment";
}

/**
 * D270: what a payment is, by the offer's own settings (Tyler: "don't hard code ... settings in the offer. this should be fully
 * configurable"). Nothing here has a value of the engine's: an offer that has not set `payments.full_prices` goes by the rules it had
 * before (D119), and each other setting it leaves unset is a rule it does not apply.
 * - `payments.full_prices`: its full prices (a list; PMU: 10000, 12000)
 * - `payments.price_slack`: how far under a full price still counts as it (PMU: 3, for Whop's $9,997)
 * - `payments.deposit_under`: a payment under this is a deposit (PMU: 500)
 * - `payments.deposit_words`: words in a product or plan name that make it a deposit (PMU: deposit)
 * - `payments.full_reasons`: Whop billing reasons a paid-in-full payment can have (PMU: one_time, subscription_create)
 */
export type PayRules = { fullPrices: number[]; slack: number; depositUnder: number | null; depositWords: string[]; fullReasons: string[] };
export const PAY_SETTINGS = { fullPrices: "payments.full_prices", slack: "payments.price_slack", depositUnder: "payments.deposit_under", depositWords: "payments.deposit_words", fullReasons: "payments.full_reasons" } as const;
/** A list setting, written as JSON or as words separated by commas. */
export function listSetting(value: string | undefined | null): string[] {
  const v = (value ?? "").trim(); if (!v) return [];
  let list: unknown; try { list = JSON.parse(v); } catch { list = v.split(","); }
  return (Array.isArray(list) ? list : [list]).map((x) => String(x).trim()).filter(Boolean);
}
const numberSetting = (value: string | undefined | null) => { const n = Number(String(value ?? "").replace(/[$,\s]/g, "")); return (value ?? "").trim() && Number.isFinite(n) ? n : null; };
export function payRulesOf(bindings: Record<string, string>): PayRules {
  return { fullPrices: listSetting(bindings[PAY_SETTINGS.fullPrices]).map((x) => numberSetting(x)).filter((n): n is number => n !== null && n > 0),
    slack: numberSetting(bindings[PAY_SETTINGS.slack]) ?? 0, depositUnder: numberSetting(bindings[PAY_SETTINGS.depositUnder]),
    depositWords: listSetting(bindings[PAY_SETTINGS.depositWords]).map((w) => w.toLowerCase()), fullReasons: listSetting(bindings[PAY_SETTINGS.fullReasons]).map((r) => r.toLowerCase()) };
}
export async function payRules(c: PoolClient, companyId: string): Promise<PayRules> {
  const rows = await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and key like 'payments.%'", [companyId]);
  return payRulesOf(Object.fromEntries(rows.map((r) => [r.key, r.value.toString("utf8")])));
}
/** Whop's billing reason against the offer's list; no list set, or a payment that names no reason (a Zap's, an old row's), is not held to it. */
export const fullReason = (reason: string | null | undefined, rules: Pick<PayRules, "fullReasons">) => !rules.fullReasons.length || !reason || rules.fullReasons.includes(String(reason).trim().toLowerCase());
export function fullPriceOf(amount: number, rules: Pick<PayRules, "fullPrices" | "slack">): number | null {
  return rules.fullPrices.filter((p) => amount <= p + 0.01 && amount >= p - rules.slack - 0.01).sort((a, b) => a - b)[0] ?? null;
}
const clearedBy = (total: number, price: number | null, slack: number) => price != null && total >= price - slack - 0.01;
/** A product or plan name with one of the offer's deposit words. */
export const namedDeposit = (raw: Record<string, unknown> | null | undefined, words: string[]) => !!raw && words.some((w) => [raw.product_name, raw.plan_name].some((n) => typeof n === "string" && n.toLowerCase().includes(w)));
/** The full price a payment beyond a deposit stands for: the one it is, else the deal's when that is one, else the offer's first (D270: the deal is worth it from its first real payment). */
export function fullPriceFor(amount: number, dealValue: number | null, rules: PayRules): number | null {
  return fullPriceOf(amount, rules) ?? (dealValue != null && rules.fullPrices.includes(dealValue) ? dealValue : rules.fullPrices[0] ?? dealValue);
}

/** D119: the company's deposit products (`payments.deposit_products`, set at install from `depositProducts`): Whop product or plan ids. */
export const DEPOSIT_PRODUCTS_KEY = "payments.deposit_products";
export function depositProducts(value: string | undefined | null): string[] {
  try { const j = JSON.parse(value ?? "[]") as unknown; return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []; } catch { return []; }
}
/** A payment is for a deposit product when its product or plan (Whop's `product_id` / `plan_id`, a Zap's `plan`) is one the company declared. */
export function isDepositProduct(raw: Record<string, unknown> | null | undefined, products: string[]): boolean {
  if (!products.length || !raw) return false;
  return ["product_id", "plan_id", "plan"].some((k) => typeof raw[k] === "string" && products.includes((raw[k] as string).trim()));
}
/**
 * D119 addendum: a payment is a deposit when its product or plan is one the company declared, or, for a company that declares
 * none, when its product's or plan's name (`product_name` / `plan_name`, kept on raw) has the word "deposit" (`saysDeposit`).
 * A declaration is the whole truth for its company: the names are not read beside it.
 */
export function isDeposit(raw: Record<string, unknown> | null | undefined, products: string[]): boolean {
  if (products.length) return isDepositProduct(raw, products);
  return !!raw && (saysDeposit(raw.product_name) || saysDeposit(raw.plan_name));
}
async function companyDepositProducts(c: PoolClient, companyId: string): Promise<string[]> {
  const b = await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [companyId, DEPOSIT_PRODUCTS_KEY]);
  return depositProducts(b?.value.toString("utf8"));
}

/** One unambiguous match or nothing. */
export async function resolvePayer(c: PoolClient, companyId: string, p: Pick<PaymentInput, "email" | "phone" | "memberId">): Promise<{ contactId: string; by: string } | null> {
  const hit = await ladder(c, companyId, p);
  return hit && (await inScope(c, hit.contactId, await companyScopeTag(c, companyId))) ? hit : null;
}
async function ladder(c: PoolClient, companyId: string, p: Pick<PaymentInput, "email" | "phone" | "memberId">): Promise<{ contactId: string; by: string } | null> {
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

/**
 * D270 (Tyler: "Engine should be checking GHL in all cases"): the buyer and what they paid before are read live from GHL, as the Zap
 * read them. `GhlPay` is the offer's GHL; without it (tests, history) the ledger answers as before.
 */
export type GhlPay = { ac: Company; adapters: Adapters; bindings: Record<string, string>; tz: string };
/** Every record on the offer's payment object (Cash at PMU). */
export const cashRecords = (g: GhlPay): Promise<ObjectRecord[]> => g.adapters.read.objectRecords(g.ac, g.bindings["crm.object_payment"] || SETTING_DEFAULTS["crm.object_payment"].default);
const prop = (r: ObjectRecord, k: string) => String(r.properties[k] ?? "").trim();
/**
 * The buyer in GHL, one or nothing, the Zap's ladder: a Whop user an earlier payment record linked to one contact, then the contact
 * whose email is exactly this one, then the one whose phone ends in the same ten digits. Then the engine's own person for them
 * (made from GHL when it has none), in the offer's scope.
 */
export async function resolvePayerGhl(c: PoolClient, companyId: string, g: GhlPay, p: Pick<PaymentInput, "email" | "phone" | "memberId">, cash: ObjectRecord[]): Promise<{ contactId: string; ghlId: string; by: string } | null> {
  let ghlId: string | null = null, by = "";
  if (p.memberId) {
    const ids = [...new Set(cash.filter((r) => prop(r, "whop_user_id") === p.memberId && prop(r, "contact_id")).map((r) => prop(r, "contact_id")))];
    if (ids.length === 1) { ghlId = ids[0]; by = "member_id"; }
  }
  const email = normEmail(p.email), dup = g.adapters.read.findDuplicate;
  if (!ghlId && email && dup) { const s = await dup(g.ac, { email }); if (s && normEmail(s.email) === email) { ghlId = s.id; by = "email"; } }
  const key = phoneKey(p.phone);
  if (!ghlId && key && dup) { const s = await dup(g.ac, { phone: p.phone! }); if (s && phoneKey(s.phone) === key) { ghlId = s.id; by = "phone"; } }
  if (!ghlId) return null;
  const known = await one<{ id: string }>(c, `select ct.id from contacts ct where ct.company_id=$1 and ct.merged_into is null and (ct.ghl_contact_id=$2
    or ct.id in (select contact_id from contact_identifiers where company_id=$1 and kind='ghl_contact' and value=$2 and retired_at is null)) limit 1`, [companyId, ghlId]);
  let contactId = known?.id;
  if (!contactId) {
    const snap = await g.adapters.read.getContact(g.ac, ghlId); if (!snap) return null;
    const { upsertContact, boundFieldIds } = await import("./poll");
    contactId = (await upsertContact(c, companyId, g.tz, snap, boundFieldIds(g.bindings))).id;
  }
  return (await inScope(c, contactId, await companyScopeTag(c, companyId))) ? { contactId, ghlId, by } : null;
}
/**
 * What this person paid before, from the offer's payment records in GHL (theirs by contact, Whop user or email), this transaction left
 * out; refunds are negative rows. "Before" is before `paidAt` (the record's `occurred_at`, else its `paid_date`): a payment that arrives
 * late or is linked after later ones (D229) never counts what came after it. A record with no date counts.
 */
export function priorFromCash(cash: ObjectRecord[], who: { ghlId: string; memberId?: string | null; email?: string | null }, transactionId: string, paidAt?: Date): { total: number; nonDeposit: number } {
  const email = normEmail(who.email ?? undefined);
  const earlier = (r: ObjectRecord) => {
    if (!paidAt) return true;
    const at = Date.parse(prop(r, "occurred_at"));
    if (Number.isFinite(at)) return at < paidAt.getTime();
    const day = prop(r, "paid_date");
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day < paidAt.toISOString().slice(0, 10) : true;
  };
  const mine = cash.filter((r) => prop(r, "transaction_id") !== transactionId && earlier(r) && (prop(r, "contact_id") === who.ghlId || (!!who.memberId && prop(r, "whop_user_id") === who.memberId) || (!!email && normEmail(prop(r, "customer_email")) === email)));
  const amt = (r: ObjectRecord) => { const v = r.properties.amount as unknown; const n = typeof v === "object" && v !== null ? Number((v as { value?: unknown }).value) : Number(v); return Number.isFinite(n) ? n : 0; };
  return { total: money(mine.reduce((s, r) => s + amt(r), 0)), nonDeposit: money(mine.filter((r) => prop(r, "type") !== "deposit").reduce((s, r) => s + amt(r), 0)) };
}

/** Totals for a pursuit: succeeded charges plus negative refunds, this payment excluded. */
async function priorTotal(c: PoolClient, opportunityId: string, excludePaymentId: string): Promise<number> {
  const r = await one<{ t: string }>(c, "select coalesce(sum(amount),0) as t from payments where opportunity_id=$1 and status in ('succeeded','refunded') and id<>$2", [opportunityId, excludePaymentId]);
  return money(Number(r!.t));
}
/** D119: the same total without the deposits and their refunds (before `before`, when given): 0 means this is the first money toward the price beyond a deposit. */
async function priorNonDeposit(c: PoolClient, opportunityId: string, excludePaymentId: string, before?: Date): Promise<number> {
  const r = await one<{ t: string }>(c, `select coalesce(sum(p.amount),0) as t from payments p where p.opportunity_id=$1 and p.status in ('succeeded','refunded') and p.id<>$2 and ($3::timestamptz is null or p.paid_at < $3)
    and coalesce(p.kind,'')<>'deposit' and not (p.status='refunded' and exists (select 1 from payments d where d.opportunity_id=p.opportunity_id and d.kind='deposit' and d.whop_payment_id=p.raw->>'payment_id'))`, [opportunityId, excludePaymentId, before ?? null]);
  return money(Number(r!.t));
}

/** Link + settle: attach the person and pursuit, derive the kind, heal earlier orphans of the same identity, emit the event. */
async function settle(c: PoolClient, companyId: string, contactId: string, payment: PaymentRow, linkedBy: string, dispatch = true, ghlPrior?: { total: number; nonDeposit: number }): Promise<{ event: EventRow; healed: number }> {
  const opp = await opportunityFor(c, companyId, contactId, payment);
  const products = await companyDepositProducts(c, companyId);
  // D270: the offer's own payment settings; an offer with no full prices set goes by D119 as before
  const rules = await payRules(c, companyId), ruled = rules.fullPrices.length > 0;
  const depositOf = (raw: Record<string, unknown> | null | undefined) => isDeposit(raw, products) || (ruled && namedDeposit(raw, rules.depositWords));
  const reasonOf = (raw: Record<string, unknown> | null | undefined) => (typeof raw?.billing_reason === "string" ? raw.billing_reason : null);
  // heal: earlier unlinked rows with the same member id or email now belong to this person and this pursuit
  const healed = await many<PaymentRow>(c, `update payments set contact_id=$2, opportunity_id=$3, link_status='linked', linked_by='heal'
    where company_id=$1 and link_status='unlinked' and id<>$4 and ((whop_member_id is not null and whop_member_id=$5) or (customer_email is not null and customer_email=$6)) returning *`,
    [companyId, contactId, opp.id, payment.id, payment.whop_member_id ?? "", payment.customer_email ?? ""]);
  for (const h of healed.sort((a, b) => a.paid_at.getTime() - b.paid_at.getTime())) {
    await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: opp.id, appointment_id: null, event_type: "payment.linked", source: "engine", data: { payment_id: h.id, by: "heal", via: payment.id } });
    // G18: a healed row is a payment this person made and the CRM never heard of; it gets its own event, with its own totals as of its day, so Payment recorded runs once for it (never twice: an event already written for it ends this)
    const already = await one(c, "select 1 from events where company_id=$1 and event_type in ('payment.received','payment.refunded','payment.failed') and data->>'payment_id'=$2", [companyId, h.id]);
    if (already) continue;
    const hPrior = money(Number((await one<{ t: string }>(c, "select coalesce(sum(amount),0) as t from payments where opportunity_id=$1 and status in ('succeeded','refunded') and id<>$2 and paid_at < $3", [opp.id, h.id, h.paid_at]))!.t));
    const hAmount = Number(h.amount), hStatus = h.status as PaymentInput["status"];
    const hKind = deriveKind(hAmount, hPrior, opp.contract_value, hStatus, depositOf(h.raw), ruled ? { ...rules, reason: reasonOf(h.raw) } : undefined);
    await c.query("update payments set kind=$2 where id=$1", [h.id, hKind]);
    const hPriorPaid = await priorNonDeposit(c, opp.id, h.id, h.paid_at);
    const hRunning = hStatus === "failed" ? hPrior : money(hPrior + hAmount);
    const hev = await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: opp.id, appointment_id: null, event_type: hStatus === "succeeded" ? "payment.received" : hStatus === "refunded" ? "payment.refunded" : "payment.failed", source: "whop", occurred_at: h.paid_at,
      data: { payment_id: h.id, provider_payment_id: h.whop_payment_id, amount: hAmount, currency: h.currency, kind: hKind, paid_at: h.paid_at.toISOString(), prior_total: hPrior, prior_non_deposit_total: hPriorPaid, running_total: hRunning, contract_value: opp.contract_value, outstanding: opp.contract_value == null ? null : money(Math.max(opp.contract_value - hRunning, 0)), cleared: cleared(hRunning, opp.contract_value), linked_by: "heal", healed_via: payment.id, customer_email: h.customer_email, whop_member_id: h.whop_member_id } });
    if (dispatch) await dispatchEvent(c, hev, { contact: { id: contactId } });
  }
  // D270: what they paid before is GHL's payment records when the offer's GHL was read, else the ledger's
  const prior = ghlPrior?.total ?? await priorTotal(c, opp.id, payment.id);
  const amount = Number(payment.amount);
  const kind = deriveKind(amount, prior, opp.contract_value, payment.status as PaymentInput["status"], depositOf(payment.raw), ruled ? { ...rules, reason: reasonOf(payment.raw) } : undefined);
  // D270: a payment beyond a deposit makes the deal worth its full price (the one it is, else the deal's, else the offer's first)
  const fullPrice = ruled && payment.status === "succeeded" && !["deposit", "refund", "failed"].includes(kind) ? fullPriceFor(amount, opp.contract_value, rules) : null;
  if (fullPrice !== null && opp.contract_value !== fullPrice) { await c.query("update opportunities set contract_value=$2 where id=$1", [opp.id, fullPrice]); opp.contract_value = fullPrice; }
  const priorPaid = ghlPrior?.nonDeposit ?? await priorNonDeposit(c, opp.id, payment.id);
  await c.query("update payments set contact_id=$2, opportunity_id=$3, kind=$4, link_status='linked', linked_by=$5 where id=$1", [payment.id, contactId, opp.id, kind, linkedBy]);
  const running = payment.status === "failed" ? prior : money(prior + amount);
  const isCleared = ruled ? clearedBy(running, opp.contract_value, rules.slack) : cleared(running, opp.contract_value);
  const type = payment.status === "succeeded" ? "payment.received" : payment.status === "refunded" ? "payment.refunded" : "payment.failed";
  const ev = await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: opp.id, appointment_id: null, event_type: type, source: "whop", occurred_at: payment.paid_at,
    data: { payment_id: payment.id, provider_payment_id: payment.whop_payment_id, amount, currency: payment.currency, kind, paid_at: payment.paid_at.toISOString(), prior_total: prior, prior_non_deposit_total: priorPaid, running_total: running, contract_value: opp.contract_value, outstanding: opp.contract_value == null ? null : money(Math.max(opp.contract_value - running, 0)), cleared: isCleared, linked_by: linkedBy, customer_email: payment.customer_email, whop_member_id: payment.whop_member_id,
      customer_phone: payment.customer_phone ?? null, billing_reason: reasonOf(payment.raw), full_price: fullPrice } });
  if (payment.status === "succeeded") {
    // D88 (A9): the opportunity is won by Payment recorded's update_opportunity step, where the company decides on which payment
    if (isCleared) {
      const already = await one(c, "select 1 from events where opportunity_id=$1 and event_type='payment.paid_in_full'", [opp.id]);
      if (!already) {
        const full = await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: opp.id, appointment_id: null, event_type: "payment.paid_in_full", source: "engine", data: { total: running, contract_value: opp.contract_value } });
        if (dispatch) await dispatchEvent(c, full, { contact: { id: contactId }, opportunity: { id: opp.id } });
      }
    }
  }
  return { event: ev, healed: healed.length };
}

/** A refund names the payment it reverses (`raw.payment_id`); a refund event may carry no buyer identity, and that payment's person is not a guess. */
async function refundedPayer(c: PoolClient, companyId: string, provider: string, input: PaymentInput): Promise<{ contactId: string; by: string } | null> {
  const original = input.status === "refunded" ? input.raw?.payment_id : undefined;
  if (typeof original !== "string" || !original) return null;
  const row = await one<{ contact_id: string | null }>(c, "select contact_id from payments where company_id=$1 and provider=$2 and whop_payment_id=$3 and link_status='linked'", [companyId, provider, original]);
  return row?.contact_id ? { contactId: row.contact_id, by: "refunded_payment" } : null;
}

/**
 * D229: an offer that says so (`payments.unmatched_failures` = drop) keeps no failed charge that matches nobody: a declined checkout
 * from a stranger is not a missed installment. A failed charge from someone it knows is kept (that is how a missed installment
 * shows). Returns why it is dropped, or null to record it. The webhooks and the backfill ask before recording.
 */
export async function dropUnmatchedFailure(c: PoolClient, companyId: string, input: PaymentInput): Promise<string | null> {
  if (input.status !== "failed") return null;
  const b = await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='payments.unmatched_failures'", [companyId]);
  if (b?.value.toString("utf8").trim() !== "drop") return null;
  if (await one(c, "select 1 from payments where company_id=$1 and provider=$2 and whop_payment_id=$3", [companyId, input.provider ?? "whop", input.providerPaymentId])) return null;
  return (await resolvePayer(c, companyId, input)) ? null : "a failed charge that matches nobody (payments.unmatched_failures = drop)";
}

/**
 * Records a provider payment. Idempotent on (provider, payment id). `forceContactId` is for callers that already know the person (tests, manual entry).
 * `dispatch: false` (history backfill) records and emits but starts no workflow, the healed rows' and paid-in-full's included.
 */
export async function recordPayment(c: PoolClient, companyId: string, input: PaymentInput, forceContactId?: string, opts: { dispatch?: boolean; ghl?: GhlPay } = {}): Promise<RecordResult> {
  // D270 (Tyler: "skip it. we don't need to record it"): a $0 charge is no payment: nothing is recorded, nothing runs
  if (input.status === "succeeded" && Number(input.amount) === 0) return { outcome: "skipped", why: "a $0 payment" };
  const provider = input.provider ?? "whop";
  const email = normEmail(input.email), phone = input.phone?.trim() || null;
  const inserted = await one<PaymentRow>(c, `insert into payments (company_id, provider, whop_payment_id, amount, currency, installment_no, status, customer_email, customer_phone, whop_member_id, link_status, paid_at, raw)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unlinked',$11,$12) on conflict (company_id, provider, whop_payment_id) do nothing returning *`,
    [companyId, provider, input.providerPaymentId, input.amount, (input.currency ?? "USD").toUpperCase(), input.installmentNo ?? null, input.status, email ?? null, phone, input.memberId ?? null, input.paidAt, input.raw ?? {}]);
  if (!inserted) {
    const prior = (await one<PaymentRow>(c, "select * from payments where company_id=$1 and provider=$2 and whop_payment_id=$3", [companyId, provider, input.providerPaymentId]))!;
    return { outcome: "duplicate", payment: prior };
  }
  // D119 addendum: a new payment without its product's or plan's name gets them from Whop (flagged and alerted when it cannot), so its kind can be told by the name
  const named = await nameThePayment(c, companyId, inserted, await companyDepositProducts(c, companyId));
  if (named) { await c.query("update payments set raw=$2 where id=$1", [inserted.id, named]); inserted.raw = named; }
  // D270: with the offer's GHL, the buyer is found there (a GHL that cannot be read throws: the provider retries, nothing is guessed)
  const cash = opts.ghl && !forceContactId ? await cashRecords(opts.ghl) : null;
  const viaGhl = cash ? await resolvePayerGhl(c, companyId, opts.ghl!, input, cash) : null;
  const match = forceContactId ? { contactId: forceContactId, by: "known" } : (await refundedPayer(c, companyId, provider, input)) ?? (cash ? viaGhl : await resolvePayer(c, companyId, input));
  if (match) {
    const ghlId = viaGhl?.contactId === match.contactId ? viaGhl.ghlId : (await one<{ g: string | null }>(c, "select ghl_contact_id as g from contacts where id=$1", [match.contactId]))?.g;
    const ghlPrior = cash && ghlId ? priorFromCash(cash, { ghlId, memberId: input.memberId, email: input.email }, input.providerPaymentId, input.paidAt) : undefined;
    const { event, healed } = await settle(c, companyId, match.contactId, inserted, match.by, opts.dispatch ?? true, ghlPrior);
    return { outcome: "linked", payment: (await one<PaymentRow>(c, "select * from payments where id=$1", [inserted.id]))!, event, contactId: match.contactId, healed };
  }
  const ev = await emitEvent(c, { company_id: companyId, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "payment.unlinked", source: "whop", occurred_at: input.paidAt,
    data: { payment_id: inserted.id, provider_payment_id: input.providerPaymentId, amount: input.amount, currency: inserted.currency, status: input.status, customer_email: email ?? null, customer_phone: phone, whop_member_id: input.memberId ?? null, paid_at: input.paidAt.toISOString() } });   // D270: paid_at for the UNLINKED record
  return { outcome: "unlinked", payment: inserted, event: ev };
}

/** A person links an orphan to a contact (the Slack button). The payment then settles exactly as if it had matched on arrival, Payment recorded included. */
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
  await dispatchEvent(c, out.event, { contact: { id: contactId } });
  return out;
}

/**
 * D229: an unlinked payment whose buyer was learned after it came in (read back from Whop) is linked by the same ladder as on
 * arrival, one unambiguous person or nothing. `dispatch: false` records it and starts no workflow (what Payment recorded would
 * have done for it is a separate, named step).
 */
export async function linkFoundBuyer(c: PoolClient, companyId: string, paymentId: string, opts: { dispatch?: boolean } = {}): Promise<{ contactId: string; by: string; event: EventRow; healed: number } | null> {
  const p = await one<PaymentRow>(c, "select * from payments where company_id=$1 and id=$2 and link_status='unlinked'", [companyId, paymentId]);
  if (!p) return null;
  const match = await resolvePayer(c, companyId, { email: p.customer_email ?? undefined, phone: p.customer_phone ?? undefined, memberId: p.whop_member_id ?? undefined });
  if (!match) return null;
  const out = await settle(c, companyId, match.contactId, p, match.by, opts.dispatch ?? true);
  await emitEvent(c, { company_id: companyId, contact_id: match.contactId, opportunity_id: out.event.opportunity_id, appointment_id: null, event_type: "payment.linked", source: "engine", data: { payment_id: p.id, by: match.by, via: "whop_api" } });
  if (opts.dispatch ?? true) await dispatchEvent(c, out.event, { contact: { id: match.contactId } });
  return { ...match, ...out };
}

/** D229: a person's pick for a payment the ladder could not place: linked to them with Whop's email remembered, starting no workflow. */
export async function linkPicked(c: PoolClient, companyId: string, paymentId: string, contactId: string): Promise<void> {
  const p = await one<PaymentRow>(c, "select * from payments where company_id=$1 and id=$2 and link_status='unlinked'", [companyId, paymentId]);
  if (!p) return;
  if (p.customer_email) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3) on conflict (company_id, kind, value) do nothing", [companyId, contactId, p.customer_email]);
  const out = await settle(c, companyId, contactId, p, "manual", false);
  await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: out.event.opportunity_id, appointment_id: null, event_type: "payment.linked", source: "user", data: { payment_id: p.id, by: "manual", via: "whop_api" } });
}

export const unlinkedPayments = (c: PoolClient, companyId: string) => many<PaymentRow>(c, "select * from payments where company_id=$1 and link_status='unlinked' order by paid_at desc", [companyId]);
