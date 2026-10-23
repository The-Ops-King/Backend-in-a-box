import type { PaymentInput } from "../payments";
import { verifyStandardWebhook } from "./standard";
import { whopBuyer, whopGetPayment, whopNames } from "@/adapters/whop/client";

/** Whop signs with Standard Webhooks (whop/01-api-facts.md); the ws_ secret is used as given. */
export const verifyWhopSignature = verifyStandardWebhook;

export type WhopEnvelope = { id: string; type: string; api_version?: string; timestamp?: string; account_id?: string; company_id?: string; data: Record<string, unknown> };

const amountOf = (v: unknown): number | undefined => {
  if (v && typeof v === "object" && "amount" in (v as Record<string, unknown>)) { const n = Number((v as { amount: unknown }).amount); return Number.isFinite(n) ? n : undefined; }
  const n = Number(v); return Number.isFinite(n) ? n : undefined;
};

/** v1 envelope → what the ledger needs. Returns null for events the ledger does not record. D119 addendum: the product's and plan's names ride along in raw (`product_name`, `plan_name`). */
export function parseWhopEvent(env: WhopEnvelope): (PaymentInput & { deliveryId: string; eventType: string }) | null {
  const d = env.data ?? {};
  const b = whopBuyer(d);
  const base = { deliveryId: env.id, eventType: env.type, provider: "whop" as const, currency: String(d.currency ?? (d.total as { currency?: string } | undefined)?.currency ?? "usd"),
    email: b.email, phone: b.phone, memberId: b.memberId,
    raw: { type: env.type, plan_id: b.plan_id, product_id: b.product_id, ...whopNames(d), membership_id: b.membership_id, billing_reason: d.billing_reason, payment_method_type: d.payment_method_type, metadata: d.metadata } };
  const when = (s: unknown) => (typeof s === "string" && !Number.isNaN(Date.parse(s)) ? new Date(s) : new Date());
  switch (env.type) {
    case "payment.succeeded": {
      const amount = amountOf(d.total) ?? amountOf(d.subtotal); if (amount === undefined) return null;
      return { ...base, providerPaymentId: String(d.id), amount, status: "succeeded", paidAt: when(d.paid_at ?? d.created_at) };
    }
    case "payment.failed": {
      const amount = amountOf(d.total) ?? amountOf(d.subtotal) ?? 0;
      return { ...base, providerPaymentId: String(d.id), amount, status: "failed", paidAt: when(d.last_payment_attempt_at ?? d.created_at), raw: { ...base.raw, failure_message: d.failure_message, decline_code: d.decline_code, payments_failed: d.payments_failed } };
    }
    case "refund.created": {
      // a refund is its own row, negative, keyed by the refund id; it points at the original payment in raw
      const amount = amountOf(d.amount) ?? amountOf(d.total); if (amount === undefined) return null;
      return { ...base, providerPaymentId: String(d.id), amount: -Math.abs(amount), status: "refunded", paidAt: when(d.created_at), raw: { ...base.raw, payment_id: d.payment_id } };
    }
    default: return null;
  }
}

/**
 * D229: a payment that came with no buyer (no email, phone or member id in the webhook) is read back from Whop's API by its id,
 * the same record the backfill reads and links by, before the ledger tries to link it. What Whop's copy adds is kept: the
 * buyer, and the product and plan ids and names the webhook left out (so the deposit check needs no second lookup). A refund
 * is left alone (it links through the payment it reverses). When Whop cannot be read the payment goes in as it came, and
 * unlinked it is the team's, as before; `raw.buyer_lookup` says why.
 */
export async function fillWhopBuyer<T extends PaymentInput>(p: T, apiKey: string | undefined, get: typeof whopGetPayment = whopGetPayment): Promise<T> {
  if (p.status === "refunded" || p.email || p.phone || p.memberId) return p;
  if (!apiKey) return { ...p, raw: { ...p.raw, buyer_lookup: "no buyer in the webhook and no Whop API key bound" } };
  try {
    const d = await get(apiKey, p.providerPaymentId);
    const b = whopBuyer(d), names = whopNames(d), raw = { ...p.raw };
    for (const [k, v] of Object.entries({ product_id: b.product_id, plan_id: b.plan_id, membership_id: b.membership_id, ...names })) if (raw[k] == null && v !== undefined) raw[k] = v;
    raw.buyer_from = "whop_api";
    return { ...p, email: b.email, phone: b.phone, memberId: b.memberId, raw };
  } catch (e) { return { ...p, raw: { ...p.raw, buyer_lookup: String((e as Error).message).slice(0, 200) } }; }
}
