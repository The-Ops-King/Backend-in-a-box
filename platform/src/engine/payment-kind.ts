/**
 * D317: what one payment is, put right by the operator (Tyler, 2026-11-06: Carmen Thomas's $1,000 was a deposit on a $10,000 deal,
 * recorded as paid in full under D315). The engine's own record of it and what it wrote from it are set to what that kind would
 * have written: the ledger's kind; the deal's price and, when no money beyond a deposit is left on it, its status back to open; the
 * GHL Cash record's type and program price; the closer card's stage (Deposit, or Purchase for money beyond one) and value. Tags,
 * contact fields and the Sales Call are the contact routes' (they say each). A dry run (the default) says what would change.
 */
import type { PoolClient } from "pg";
import { one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { paymentObject } from "./ghl-metrics";

export const PAYMENT_KINDS = ["deposit", "installment", "balance", "paid_in_full"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

type Change = { what: string; was: unknown; now: unknown };
export async function setPaymentKind(c: PoolClient, a: { companyId: string; ac: Company; adapters: Adapters; bindings: Record<string, string>; payment: string; kind: PaymentKind; price?: number; why: string; dryRun?: boolean }):
  Promise<{ ok: true; dryRun: boolean; payment: string; changes: Change[] } | { ok: false; status: number; error: string }> {
  if (!PAYMENT_KINDS.includes(a.kind)) return { ok: false, status: 400, error: `kind: one of ${PAYMENT_KINDS.join(", ")}` };
  if (a.price !== undefined && !(Number.isFinite(a.price) && a.price > 0)) return { ok: false, status: 400, error: "price: the deal's full price, a positive number" };
  if (!a.why?.trim()) return { ok: false, status: 400, error: "why is required" };
  const p = await one<{ id: string; whop_payment_id: string; amount: string; kind: string | null; status: string; opportunity_id: string | null; contact_id: string | null }>(c,
    "select id, whop_payment_id, amount, kind, status, opportunity_id, contact_id from payments where company_id=$1 and (id::text=$2 or whop_payment_id=$2)", [a.companyId, a.payment]);
  if (!p) return { ok: false, status: 404, error: "no such payment on this offer" };
  if (p.status !== "succeeded") return { ok: false, status: 409, error: `a ${p.status} payment has no kind to set` };
  if (!p.opportunity_id) return { ok: false, status: 409, error: "the payment is not linked to anyone yet" };
  const opp = (await one<{ status: string; contract_value: string | null }>(c, "select status, contract_value from opportunities where id=$1", [p.opportunity_id]))!;
  const price = a.price ?? (opp.contract_value === null ? null : Number(opp.contract_value));
  const others = Number((await one<{ n: string }>(c, "select count(*) n from payments where opportunity_id=$1 and id<>$2 and status='succeeded' and coalesce(kind,'')<>'deposit'", [p.opportunity_id, p.id]))!.n);
  const status = a.kind === "deposit" && others === 0 && opp.status === "won" ? "open" : opp.status;
  const changes: Change[] = [];
  if (p.kind !== a.kind) changes.push({ what: "payment kind", was: p.kind, now: a.kind });
  if (price !== null && Number(opp.contract_value) !== price) changes.push({ what: "deal price", was: opp.contract_value === null ? null : Number(opp.contract_value), now: price });
  if (status !== opp.status) changes.push({ what: "deal status", was: opp.status, now: status });
  // the GHL Cash record the engine wrote for it
  const object = paymentObject(a.bindings);
  const cash = await one<{ ghl_record_id: string | null; properties: Record<string, unknown> }>(c, "select ghl_record_id, properties from crm_records where company_id=$1 and object_key=$2 and record_key=$3", [a.companyId, object, p.whop_payment_id]);
  const cashPatch: Record<string, unknown> = {};
  if (cash?.ghl_record_id) {
    if (cash.properties?.type !== a.kind) cashPatch.type = a.kind;
    if (price !== null && Number(cash.properties?.program_price) !== price) cashPatch.program_price = price;
    for (const [k, v] of Object.entries(cashPatch)) changes.push({ what: `Cash record ${k}`, was: cash.properties?.[k] ?? null, now: v });
  }
  // the closer card: Deposit for a deposit, Purchase for money beyond one
  const stage = a.bindings[a.kind === "deposit" ? "crm.stage_closer_deposit" : "crm.stage_closer_purchase"];
  const card = await one<{ id: string; ghl_opportunity_id: string | null; ghl_stage_id: string }>(c,
    "select id, ghl_opportunity_id, ghl_stage_id from pipeline_cards where opportunity_id=$1 and ghl_pipeline_id=$2 and status='open' order by updated_at desc limit 1", [p.opportunity_id, a.bindings["crm.pipeline_closer"] ?? ""]);
  const moveCard = !!card?.ghl_opportunity_id && !!stage && card.ghl_stage_id !== stage;
  if (moveCard) changes.push({ what: "closer card stage", was: card!.ghl_stage_id, now: stage });
  if (card?.ghl_opportunity_id && price !== null) changes.push({ what: "closer card value", was: "(as GHL has it)", now: price });
  if (a.dryRun !== false || !changes.length) return { ok: true, dryRun: a.dryRun !== false, payment: p.whop_payment_id, changes };

  await c.query("update payments set kind=$2 where id=$1", [p.id, a.kind]);
  await c.query("update opportunities set contract_value=$2, status=$3, price_source=case when $4 then 'operator' else price_source end where id=$1", [p.opportunity_id, price, status, a.price !== undefined]);
  if (Object.keys(cashPatch).length) {
    await a.adapters.write.updateRecord(a.ac, object, cash!.ghl_record_id!, cashPatch);
    await c.query("update crm_records set properties = properties || $4::jsonb, updated_at=now() where company_id=$1 and object_key=$2 and record_key=$3", [a.companyId, object, p.whop_payment_id, JSON.stringify(cashPatch)]);
  }
  if (card?.ghl_opportunity_id && (moveCard || price !== null)) {
    await a.adapters.write.updateOpportunity(a.ac, card.ghl_opportunity_id, { ...(moveCard ? { stageId: stage } : {}), ...(price !== null ? { monetaryValue: price } : {}) });
    if (moveCard) await c.query("update pipeline_cards set ghl_stage_id=$2, updated_at=now() where id=$1", [card.id, stage]);
  }
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'payment.kind_set','payment',$2,$3,$4)",
    [a.companyId, p.id, { kind: p.kind, deal_price: opp.contract_value, deal_status: opp.status }, { kind: a.kind, deal_price: price, deal_status: status, why: a.why.trim(), changes }]);
  return { ok: true, dryRun: false, payment: p.whop_payment_id, changes };
}
