import type { PaymentInput } from "@/engine/payments";

/**
 * Whop REST API (docs.whop.com, verified 2026-10-07 on Hair's key): base https://api.whop.com/api/v1, Bearer API key.
 * Payments list is cursor-paginated (`page_info.end_cursor` / `has_next_page`); a payment carries customer_email,
 * customer_phone, member_id, status (paid|open|void|…) with substatus, total.amount as a decimal string, refunded_amount.
 * Webhook create returns `webhook_secret` ONCE; later reads leave it empty, so it is bound at creation (same as Fathom).
 */
const BASE = "https://api.whop.com/api/v1";
const headers = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" });
type Money = { amount: string | number; currency?: string } | null | undefined;
const amt = (m: Money) => (m ? Number(m.amount) : NaN);

export type WhopPayment = { id: string; status: string; substatus?: string; total?: Money; usd_total?: Money; currency?: string; created_at: string; paid_at?: string | null; refunded_at?: string | null; refunded_amount?: Money; billing_reason?: string; customer_email?: string | null; customer_phone?: string | null; member_id?: string | null; plan_id?: string | null; product_id?: string | null; account_id?: string };

export async function whopListPayments(apiKey: string, from: Date, to: Date): Promise<WhopPayment[]> {
  const out: WhopPayment[] = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ created_after: from.toISOString(), created_before: to.toISOString(), first: "50", order: "created_at", direction: "asc" });
    if (after) q.set("after", after);
    const res = await fetch(`${BASE}/payments?${q}`, { headers: headers(apiKey) });
    if (!res.ok) throw new Error(`whop: list payments ${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { data: WhopPayment[]; page_info?: { has_next_page?: boolean; end_cursor?: string } };
    out.push(...(j.data ?? []));
    if (!j.page_info?.has_next_page || !j.page_info.end_cursor) break;
    after = j.page_info.end_cursor;
  }
  return out;
}

/** A Whop payment as the ledger wants it; a refund becomes its own negative row keyed by the payment id + ":refund". Open/void payments are not money and return nothing. */
export function paymentInputs(p: WhopPayment): PaymentInput[] {
  const base = { provider: "whop" as const, currency: (p.currency ?? p.total?.currency ?? "usd").toUpperCase(), email: p.customer_email ?? undefined, phone: p.customer_phone ?? undefined, memberId: p.member_id ?? undefined,
    raw: { billing_reason: p.billing_reason, plan_id: p.plan_id, product_id: p.product_id, substatus: p.substatus, backfill: true } };
  const total = amt(p.total) || amt(p.usd_total);
  const out: PaymentInput[] = [];
  if (p.status === "paid" && Number.isFinite(total)) out.push({ ...base, providerPaymentId: p.id, amount: total, status: "succeeded", paidAt: new Date(p.paid_at ?? p.created_at) });
  else if (p.status === "failed" || p.substatus === "failed") out.push({ ...base, providerPaymentId: p.id, amount: Number.isFinite(total) ? total : 0, status: "failed", paidAt: new Date(p.created_at) });
  const refunded = amt(p.refunded_amount);
  if (Number.isFinite(refunded) && refunded > 0) out.push({ ...base, providerPaymentId: `${p.id}:refund`, amount: -refunded, status: "refunded", paidAt: new Date(p.refunded_at ?? p.created_at), raw: { ...base.raw, payment_id: p.id } });
  return out;
}

export type WhopWebhook = { id: string; url: string; enabled: boolean; events: string[]; api_version: string; webhook_secret: string };
export const WHOP_EVENTS = ["payment.succeeded", "payment.failed", "refund.created"];
export async function whopCreateWebhook(apiKey: string, url: string): Promise<WhopWebhook> {
  // `api_version` is rejected since 2026-10 ("new webhooks always use the v1 events"); payload shape is pinned with api_version_date, left unpinned here
  const res = await fetch(`${BASE}/webhooks`, { method: "POST", headers: headers(apiKey), body: JSON.stringify({ url, enabled: true, events: WHOP_EVENTS }) });
  if (!res.ok) throw new Error(`whop: create webhook ${res.status} ${(await res.text()).slice(0, 200)}`);
  const w = (await res.json()) as WhopWebhook;
  if (!w.webhook_secret) throw new Error("whop: webhook created but no signing secret returned (the key may lack developer:manage_webhook)");
  return w;
}
/** The webhook the engine made, as Whop sees it now (D33 sweep). `found: false` on 404; `ok: false` when the key cannot read webhooks. */
export async function whopGetWebhook(apiKey: string, id: string): Promise<{ ok: true; found: boolean; enabled?: boolean; url?: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${BASE}/webhooks/${encodeURIComponent(id)}`, { headers: headers(apiKey) });
    if (res.status === 404) return { ok: true, found: false };
    if (!res.ok) return { ok: false, error: `${res.status} ${(await res.text()).slice(0, 160)}` };
    const w = (await res.json()) as { enabled?: boolean; url?: string };
    return { ok: true, found: true, enabled: w.enabled, url: w.url };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 160) }; }
}
/** Cheap key check: one payment. */
export async function whopPing(apiKey: string): Promise<boolean> {
  const res = await fetch(`${BASE}/payments?first=1`, { headers: headers(apiKey) });
  return res.ok;
}
