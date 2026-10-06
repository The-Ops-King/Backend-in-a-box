import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentInput } from "../payments";

/**
 * Whop webhooks follow Standard Webhooks (verified in whop/01-api-facts.md): headers webhook-id, webhook-timestamp,
 * webhook-signature "v1,<base64>"; the signature is HMAC-SHA256 over "{id}.{timestamp}.{raw body}" with the ws_…
 * secret as the key. Timestamps older than five minutes are rejected (replay).
 */
export function verifyWhopSignature(secret: string, headers: { id: string | null; timestamp: string | null; signature: string | null }, raw: string, now = Date.now()): { ok: true } | { ok: false; why: string } {
  if (!headers.id || !headers.timestamp || !headers.signature) return { ok: false, why: "missing webhook headers" };
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return { ok: false, why: "timestamp outside tolerance" };
  const payload = `${headers.id}.${headers.timestamp}.${raw}`;
  // the secret is used as given (ws_…); Standard Webhooks' whsec_ base64 form is accepted too
  const keys: Buffer[] = [Buffer.from(secret, "utf8")];
  if (secret.startsWith("whsec_")) { try { keys.push(Buffer.from(secret.slice(6), "base64")); } catch { /* not base64 */ } }
  const given = headers.signature.split(/\s+/).map((s) => s.replace(/^v1,/, "")).filter(Boolean);
  for (const key of keys) {
    const expected = createHmac("sha256", key).update(payload).digest("base64");
    for (const g of given) { const a = Buffer.from(g), b = Buffer.from(expected); if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true }; }
  }
  return { ok: false, why: "signature mismatch" };
}

export type WhopEnvelope = { id: string; type: string; api_version?: string; timestamp?: string; account_id?: string; company_id?: string; data: Record<string, unknown> };

const amountOf = (v: unknown): number | undefined => {
  if (v && typeof v === "object" && "amount" in (v as Record<string, unknown>)) { const n = Number((v as { amount: unknown }).amount); return Number.isFinite(n) ? n : undefined; }
  const n = Number(v); return Number.isFinite(n) ? n : undefined;
};

/** v1 envelope → what the ledger needs. Returns null for events the ledger does not record. */
export function parseWhopEvent(env: WhopEnvelope): (PaymentInput & { deliveryId: string; eventType: string }) | null {
  const d = env.data ?? {};
  const base = { deliveryId: env.id, eventType: env.type, provider: "whop" as const, currency: String(d.currency ?? (d.total as { currency?: string } | undefined)?.currency ?? "usd"),
    email: typeof d.customer_email === "string" ? d.customer_email : undefined, phone: typeof d.customer_phone === "string" ? d.customer_phone : undefined,
    memberId: typeof d.member_id === "string" ? d.member_id : undefined, raw: { type: env.type, plan_id: d.plan_id, product_id: d.product_id, membership_id: d.membership_id, billing_reason: d.billing_reason, payment_method_type: d.payment_method_type, metadata: d.metadata } };
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
