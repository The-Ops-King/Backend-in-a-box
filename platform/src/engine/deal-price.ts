/**
 * D322: what a deal is worth, and from that whether it is paid in full, whatever links the money came through (Tyler, 2026-11-08:
 * "it's hard to know if it's $4,000, then $6,000, then another $2,000, or if it's just the $4,000 and the $6,000"). An offer that
 * lists `payments.price_from` (PMU: agreement, eod) takes the deal's price from what was sold, strongest first:
 *   operator (a person put it right) > a signed agreement's price > a sent agreement's > the closer's end-of-day revenue > a payment
 * The agreement's price is the dollar amount in its name ("($9,997 + Guarantee) Beauty Moguls Service Agreement" is $9,997).
 * A weaker source never replaces a stronger one; when the two differ by more than the offer's slack, an alert says so and the
 * stronger stands. Each time the price is set or changes, the deal's payments are checked again against it: the money collected
 * reaching the price (less the slack) is paid in full, short of it is a plan; the payment kinds, the GHL Cash records' type and
 * program price, the paid / plan tags (the offer's own names: `payments.tag_paid_full`, `payments.tag_plan_active`), Revenue
 * Generated and the closer card's value follow. More money than the price stays paid in full, with an alert.
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { emitEvent, dispatchEvent } from "./dispatch";
import { payRules, listSetting } from "./payments";
import { paymentObject } from "./ghl-metrics";
import { raise } from "./alerts";

export const PRICE_SOURCES = ["payment", "eod", "agreement_sent", "agreement", "operator"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];
const rank = (s: string | null | undefined) => (s ? PRICE_SOURCES.indexOf(s as PriceSource) : -1);
const money = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** The first dollar amount in an agreement's name; null when it names none. */
export function priceFromName(name: string | null | undefined): number | null {
  const m = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(name ?? "");
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "") + (m[2] ? `.${m[2]}` : ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Which sources this offer takes a price from (`payments.price_from`); empty: the offer does not use D322. */
export const priceFrom = (bindings: Record<string, string>) => listSetting(bindings["payments.price_from"]).map((x) => x.toLowerCase());

type Deps = { companyId: string; ac: Company; adapters: Adapters; bindings: Record<string, string>; dispatch?: boolean };
export type PriceResult = { changed: boolean; price: number | null; was: number | null; source: string | null; kept?: string; reconciled?: Reconciled | null };

/** Set the deal's price from `source`, when it is at least as strong as what set it before, then check its payments again. */
export async function setDealPrice(c: PoolClient, d: Deps & { contactId: string; price: number; source: PriceSource; what?: string }): Promise<PriceResult> {
  const from = priceFrom(d.bindings);
  const family = d.source.startsWith("agreement") ? "agreement" : d.source;
  if (d.source !== "operator" && d.source !== "payment" && !from.includes(family)) return { changed: false, price: null, was: null, source: null };
  const opp = await one<{ id: string; contract_value: string | null; price_source: string | null }>(c,
    "select id, contract_value, price_source from opportunities where company_id=$1 and contact_id=$2 and status in ('open','won') order by (status='open') desc, opened_at desc limit 1", [d.companyId, d.contactId]);
  if (!opp) return { changed: false, price: null, was: null, source: null };
  const was = opp.contract_value === null ? null : Number(opp.contract_value);
  const rules = await payRules(c, d.companyId);
  const differs = was !== null && Math.abs(was - d.price) > rules.slack + 0.01;
  if (rank(d.source) < rank(opp.price_source)) {
    if (differs && family === "eod" && opp.price_source?.startsWith("agreement")) await priceAlert(c, d, opp.id, `${d.what ?? "The closer's end of day"} says ${usd(d.price)}, the agreement says ${usd(was!)}: the agreement's price stands.`);
    return { changed: false, price: was, was, source: opp.price_source, kept: opp.price_source ?? undefined };
  }
  if (differs && family === "agreement" && opp.price_source === "eod") await priceAlert(c, d, opp.id, `The agreement says ${usd(d.price)}, the closer's end of day said ${usd(was!)}: the agreement's price is used.`);
  const changed = was !== d.price || opp.price_source !== d.source;
  if (changed) await c.query("update opportunities set contract_value=$2, price_source=$3 where id=$1", [opp.id, d.price, d.source]);
  const reconciled = await reconcileDeal(c, { ...d, opportunityId: opp.id, contactId: d.contactId });
  return { changed, price: d.price, was, source: d.source, reconciled };
}

async function priceAlert(c: PoolClient, d: Deps & { contactId: string }, oppId: string, text: string) {
  const who = await one<{ name: string }>(c, "select coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), 'Someone') as name from contacts where id=$1", [d.contactId]);
  await raise(c, { companyId: d.companyId, key: `payments:price:${oppId}`, level: "warning", source: "engine", text: `${who?.name}: ${text}`, detail: { opportunity_id: oppId } });
}

export type Reconciled = { total: number; price: number; cleared: boolean; overpaid: boolean; kinds: { payment: string; was: string | null; now: string }[]; tags: { add: string[]; remove: string[] } };

/**
 * The deal's payments against its price, now. Deposits stay deposits; of the money beyond them, only the last payment can be the
 * one that pays it off (paid in full when it is the only payment, the balance after others), every earlier one is an installment.
 */
export async function reconcileDeal(c: PoolClient, d: Deps & { opportunityId: string; contactId: string }): Promise<Reconciled | null> {
  const opp = await one<{ contract_value: string | null; price_source: string | null }>(c, "select contract_value, price_source from opportunities where id=$1", [d.opportunityId]);
  if (!opp?.contract_value || Number(opp.contract_value) <= 0) return null;
  const price = Number(opp.contract_value);
  const rules = await payRules(c, d.companyId);
  const pays = await many<{ id: string; whop_payment_id: string; amount: string; kind: string | null; status: string }>(c,
    "select id, whop_payment_id, amount, kind, status from payments where opportunity_id=$1 and status in ('succeeded','refunded') order by paid_at, id", [d.opportunityId]);
  const total = money(pays.reduce((s, p) => s + Number(p.amount), 0));
  const beyond = pays.filter((p) => p.status === "succeeded" && p.kind !== "deposit" && p.kind !== "refund" && Number(p.amount) > 0);
  if (!beyond.length) return null;   // only a deposit so far: nothing is paid off or on a plan yet
  const cleared = total >= price - rules.slack - 0.01;
  const overpaid = total > price + rules.slack + 0.01;
  const deposits = pays.some((p) => p.kind === "deposit");
  const kinds: Reconciled["kinds"] = [];
  beyond.forEach((p, i) => {
    const last = i === beyond.length - 1;
    const now = last && cleared ? (beyond.length === 1 && !deposits ? "paid_in_full" : "balance") : "installment";
    if (p.kind !== now) kinds.push({ payment: p.whop_payment_id, was: p.kind, now });
  });
  for (const k of kinds) await c.query("update payments set kind=$2 where opportunity_id=$1 and whop_payment_id=$3", [d.opportunityId, k.now, k.payment]);
  // the GHL Cash records the engine wrote for them: their type and the program price
  const object = paymentObject(d.bindings);
  for (const p of pays) {
    const rec = await one<{ ghl_record_id: string | null; properties: Record<string, unknown> }>(c, "select ghl_record_id, properties from crm_records where company_id=$1 and object_key=$2 and record_key=$3", [d.companyId, object, p.whop_payment_id]);
    if (!rec?.ghl_record_id) continue;
    const kind = kinds.find((k) => k.payment === p.whop_payment_id)?.now ?? p.kind;
    const patch: Record<string, unknown> = {};
    if (kind && rec.properties?.type !== kind && p.status === "succeeded") patch.type = kind;
    if (Number(rec.properties?.program_price) !== price) patch.program_price = price;
    if (!Object.keys(patch).length) continue;
    await d.adapters.write.updateRecord(d.ac, object, rec.ghl_record_id, patch);
    await c.query("update crm_records set properties = properties || $4::jsonb, updated_at=now() where company_id=$1 and object_key=$2 and record_key=$3", [d.companyId, object, p.whop_payment_id, JSON.stringify(patch)]);
  }
  // paid in full or on a plan: the offer's own tags
  const tagPaid = d.bindings["payments.tag_paid_full"], tagPlan = d.bindings["payments.tag_plan_active"];
  const ct = await one<{ ghl_contact_id: string | null; tags: string[] }>(c, "select ghl_contact_id, tags from contacts where id=$1", [d.contactId]);
  const want = { add: [] as string[], remove: [] as string[] };
  if (tagPaid && tagPlan && ct?.ghl_contact_id) {
    const [on, off] = cleared ? [tagPaid, tagPlan] : [tagPlan, tagPaid];
    if (!ct.tags.includes(on)) want.add.push(on);
    if (ct.tags.includes(off)) want.remove.push(off);
    for (const t of want.add) { await d.adapters.write.addTag(d.ac, ct.ghl_contact_id, t); await c.query("update contacts set tags = array(select distinct unnest(tags || $2::text[])) where id=$1", [d.contactId, [t]]); }
    for (const t of want.remove) { await d.adapters.write.removeTag(d.ac, ct.ghl_contact_id, t); await c.query("update contacts set tags = array_remove(tags, $2) where id=$1", [d.contactId, t]); }
    for (const t of want.add) await emitEvent(c, { company_id: d.companyId, contact_id: d.contactId, opportunity_id: d.opportunityId, appointment_id: null, event_type: "tag.added", source: "engine", data: { tag: t, by: "deal_price" } });
    for (const t of want.remove) await emitEvent(c, { company_id: d.companyId, contact_id: d.contactId, opportunity_id: d.opportunityId, appointment_id: null, event_type: "tag.removed", source: "engine", data: { tag: t, by: "deal_price" } });
  }
  // Revenue Generated and the closer card's value
  const revenueField = d.bindings["crm.field_contact_revenue_generated"];
  if (revenueField && ct?.ghl_contact_id) await d.adapters.write.updateContact(d.ac, ct.ghl_contact_id, { customFields: [{ id: revenueField, field_value: String(price) }] });
  const card = await one<{ ghl_opportunity_id: string | null }>(c, "select ghl_opportunity_id from pipeline_cards where opportunity_id=$1 and ghl_pipeline_id=$2 order by updated_at desc limit 1", [d.opportunityId, d.bindings["crm.pipeline_closer"] ?? ""]);
  if (card?.ghl_opportunity_id) await d.adapters.write.updateOpportunity(d.ac, card.ghl_opportunity_id, { monetaryValue: price });
  // paid off now (and never said before): the same event a payment that pays it off makes
  if (cleared && !(await one(c, "select 1 from events where opportunity_id=$1 and event_type='payment.paid_in_full'", [d.opportunityId]))) {
    const ev = await emitEvent(c, { company_id: d.companyId, contact_id: d.contactId, opportunity_id: d.opportunityId, appointment_id: null, event_type: "payment.paid_in_full", source: "engine", data: { total, contract_value: price, by: "deal_price" } });
    if (d.dispatch !== false) await dispatchEvent(c, ev, { contact: { id: d.contactId }, opportunity: { id: d.opportunityId } });
  }
  if (overpaid && rank(opp.price_source) >= rank("eod")) {
    const who = await one<{ name: string }>(c, "select coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), 'Someone') as name from contacts where id=$1", [d.contactId]);
    await raise(c, { companyId: d.companyId, key: `payments:overpaid:${d.opportunityId}`, level: "warning", source: "engine", text: `${who?.name} has paid ${usd(total)} on a ${usd(price)} deal: check the price or the charges.`, detail: { opportunity_id: d.opportunityId, total, price } });
  }
  return { total, price, cleared, overpaid, kinds, tags: want };
}
