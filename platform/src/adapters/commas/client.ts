import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentInput } from "@/engine/payments";

/**
 * D319: Commas (commasdocs.com, read 2026-11-06). The API is Fanbasis's: every route under https://www.fanbasis.com/public-api/
 * (never the apex domain, which 301s and drops POST bodies), the key in `x-api-key`, answers `{ status, message, data }`.
 * - `GET /checkout-sessions/transactions?page&per_page` (max 100): every payment made, `{ transactions, pagination: { has_more } }`.
 *   A transaction: numeric `id`, `transaction_date`, `amount` (dollars), `fan` { id, name, email, phone, country_code },
 *   `service`/`product` { id, title, price }, `servicePayment` { id, payment_type }, `refunds` [].
 * - Webhooks: `POST /webhook-subscriptions { webhook_url, event_types }` answers `secret_key` (once). Deliveries are enveloped
 *   `{ id (uuid), type, data, created_at }`, signed HMAC-SHA256 of the raw body, hex, in `x-webhook-signature`, and delivered
 *   at most once: no retries. A webhook names a payment by its order id (ORD-...), the list by its numeric id, so the list is
 *   the one source of successful payments (keyed by its id); a webhook only asks the engine to read it now.
 */
export const COMMAS_BASE = "https://www.fanbasis.com/public-api";
const headers = (apiKey: string) => ({ "x-api-key": apiKey, Accept: "application/json", "Content-Type": "application/json" });
type Envelope<T> = { status?: string; message?: string; data?: T };

async function call<T>(apiKey: string, method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(`${COMMAS_BASE}${path}`, { method, headers: headers(apiKey), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`commas ${res.status} on ${path.split("?")[0]}: ${text.slice(0, 200)}`);
  const j = (text ? JSON.parse(text) : {}) as Envelope<T>;
  if (j.status && j.status !== "success") throw new Error(`commas on ${path.split("?")[0]}: ${j.message ?? j.status}`);
  return j.data as T;
}

export type CommasRefund = { id?: string | number; refund_id?: string; amount?: number | string; created_at?: string; status?: string };
export type CommasTransaction = {
  id: number | string; transaction_date: string; amount: number | string; fee_amount?: number; net_amount?: number;
  fan?: { id?: string; name?: string; email?: string | null; phone?: string | null; country_code?: string | null } | null;
  service?: { id?: string; title?: string | null; price?: string | null } | null; product?: { id?: string; title?: string | null; price?: string | null } | null;
  servicePayment?: { id?: string; payment_type?: string | null } | null; refunds?: CommasRefund[] | null;
};

/**
 * Every transaction since `since` (newest pages first when Commas sorts so; a full page wholly older than `since` ends the read,
 * and a list in the other order is read to its end, so nothing in the window is missed either way). At most `maxPages` pages.
 */
export async function commasListTransactions(apiKey: string, since: Date, maxPages = 100): Promise<CommasTransaction[]> {
  const out: CommasTransaction[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const d = await call<{ transactions?: CommasTransaction[]; pagination?: { has_more?: boolean } }>(apiKey, "GET", `/checkout-sessions/transactions?page=${page}&per_page=100`);
    const rows = d?.transactions ?? [];
    out.push(...rows.filter((t) => Date.parse(t.transaction_date) >= since.getTime()));
    if (!d?.pagination?.has_more || !rows.length) break;
    if (rows.every((t) => Date.parse(t.transaction_date) < since.getTime())) break;
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
/** The buyer's phone as one number: its country code and the rest ("1" + "3055550100" → "+13055550100"). */
export const commasPhone = (phone?: string | null, cc?: string | null) => { const p = (phone ?? "").replace(/\D/g, ""); if (!p) return undefined; const c = (cc ?? "").replace(/\D/g, ""); return c && !p.startsWith(c) ? `+${c}${p}` : `+${p}`; };

/** A Commas transaction as the ledger wants it: the payment, and each refund on it as its own negative row (keyed by the payment and the refund). */
export function commasPaymentInputs(t: CommasTransaction): PaymentInput[] {
  const item = t.service ?? t.product ?? null;
  const base = { provider: "commas" as const, currency: "USD", email: str(t.fan?.email), phone: commasPhone(t.fan?.phone, t.fan?.country_code), memberId: str(t.fan?.id),
    raw: { product_id: str(item?.id) ?? null, product_name: str(item?.title) ?? null, product_price: str(item?.price) ?? null, payment_type: str(t.servicePayment?.payment_type) ?? null, service_payment_id: str(t.servicePayment?.id) ?? null, buyer_name: str(t.fan?.name) ?? null, fee: t.fee_amount ?? null, net: t.net_amount ?? null } };
  const out: PaymentInput[] = [];
  const amount = num(t.amount);
  if (amount !== undefined) out.push({ ...base, providerPaymentId: String(t.id), amount, status: "succeeded", paidAt: new Date(t.transaction_date) });
  for (const r of t.refunds ?? []) {
    const ra = num(r.amount), rid = str(String(r.id ?? r.refund_id ?? ""));
    if (ra === undefined || !rid || (r.status && !/succe/i.test(r.status))) continue;
    out.push({ ...base, providerPaymentId: `${t.id}:refund:${rid}`, amount: -Math.abs(ra), status: "refunded", paidAt: new Date(r.created_at ?? t.transaction_date), raw: { ...base.raw, payment_id: String(t.id) } });
  }
  return out;
}

export const COMMAS_EVENTS = ["payment.succeeded", "payment.failed", "refund.created", "subscription.created", "subscription.renewed"];
export type CommasSubscription = { id: string; webhook_url: string; event_types: string[]; is_active: boolean; secret_key?: string; last_used_at?: string | null };
export const commasListWebhooks = (apiKey: string) => call<CommasSubscription[]>(apiKey, "GET", "/webhook-subscriptions");
export async function commasCreateWebhook(apiKey: string, url: string): Promise<CommasSubscription & { secret_key: string }> {
  const w = await call<CommasSubscription>(apiKey, "POST", "/webhook-subscriptions", { webhook_url: url, event_types: COMMAS_EVENTS });
  if (!w?.secret_key) throw new Error("commas: webhook made but no signing secret came back (the key may lack the webhooks scope)");
  return w as CommasSubscription & { secret_key: string };
}
/** Cheap key check: one page of one transaction. */
export async function commasPing(apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try { await call(apiKey, "GET", "/checkout-sessions/transactions?page=1&per_page=1", undefined, 8000); return { ok: true }; } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 200) }; }
}

/** HMAC-SHA256 of the raw body with the subscription's secret, hex, compared in constant time; a missing or malformed header fails. */
export function verifyCommasSignature(secret: string, raw: string, signature: string | null): boolean {
  if (!signature) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"), "hex"), got = Buffer.from(signature.trim(), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export type CommasEnvelope = { id: string; type: string; data: Record<string, unknown>; created_at?: string };
/** A failed payment attempt, from its webhook (the list holds only payments made): keyed by its order id, the buyer by their id. */
export function commasFailedInput(env: CommasEnvelope): PaymentInput | null {
  if (env.type !== "payment.failed") return null;
  const d = env.data ?? {}, id = str(d.payment_id); if (!id) return null;
  return { provider: "commas", providerPaymentId: id, amount: num(d.amount) ?? 0, status: "failed", paidAt: new Date(str(d.timestamp) ?? env.created_at ?? Date.now()), memberId: str(d.customer_id),
    raw: { type: env.type, failure_reason: str(d.failure_reason) ?? null, status_code: str(d.status_code) ?? null, subscription_id: str(d.subscription_id) ?? null, product_id: str(d.service_id) ?? null, product_name: null } };
}
