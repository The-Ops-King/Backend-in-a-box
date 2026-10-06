import type { PaymentInput } from "../payments";

/**
 * Payments forwarded by a Zap (Whop → Zapier → Webhooks by Zapier → us) when the processor's own webhooks are out of
 * reach. The Zap maps fields; names are accepted in snake_case or camelCase. Idempotency is the transaction id, same
 * as the direct webhook, so a Zap replay is a no-op.
 */
export function parseZapierPayment(body: Record<string, unknown>): { ok: true; input: PaymentInput } | { ok: false; why: string } {
  const pick = (...keys: string[]) => { for (const k of keys) { const v = body[k]; if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim(); } return undefined; };
  const id = pick("transaction_id", "transactionId", "payment_id", "paymentId", "id");
  if (!id) return { ok: false, why: "transaction_id is required (it is what makes a replayed Zap harmless)" };
  const rawAmount = pick("amount", "final_amount", "total");
  const cleaned = rawAmount?.replace(/[^0-9.-]/g, "") ?? "";
  const amountNum = cleaned === "" ? NaN : Number(cleaned);
  if (!Number.isFinite(amountNum)) return { ok: false, why: `amount is not numeric: ${rawAmount ?? "(missing)"}` };
  const statusRaw = (pick("status", "event", "type") ?? "succeeded").toLowerCase();
  const status: PaymentInput["status"] = /fail|declin/.test(statusRaw) ? "failed" : /refund|charge ?back|dispute/.test(statusRaw) ? "refunded" : "succeeded";
  const paidRaw = pick("paid_at", "paidAt", "created_at", "createdAt", "date");
  const paidAt = paidRaw && !Number.isNaN(Date.parse(paidRaw)) ? new Date(paidRaw) : paidRaw && /^\d{10,13}$/.test(paidRaw) ? new Date(Number(paidRaw) * (paidRaw.length === 10 ? 1000 : 1)) : new Date();
  return { ok: true, input: {
    providerPaymentId: id, provider: (pick("provider", "processor") ?? "whop").toLowerCase(),
    amount: status === "refunded" ? -Math.abs(amountNum) : amountNum, currency: pick("currency") ?? "USD", status, paidAt,
    email: pick("email", "customer_email", "customerEmail", "user_email"), phone: pick("phone", "customer_phone", "customerPhone"), memberId: pick("member_id", "memberId", "whop_user_id", "whopUserId", "user_id"),
    raw: { via: "zapier", plan: pick("plan", "plan_id", "product"), metadata: body.metadata ?? undefined },
  } };
}
