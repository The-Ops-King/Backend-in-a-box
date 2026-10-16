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

export type WhopPayment = { id: string; status: string; substatus?: string; total?: Money; usd_total?: Money; currency?: string; created_at: string; paid_at?: string | null; refunded_at?: string | null; refunded_amount?: Money; billing_reason?: string; customer_email?: string | null; customer_phone?: string | null; member_id?: string | null; plan_id?: string | null; product_id?: string | null; account_id?: string; line_items?: Array<{ product_id?: string | null; product_title?: string | null; plan_id?: string | null; plan_title?: string | null }> | null };

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

const title = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
/**
 * D119 addendum: the product's and the plan's names a Whop Payment carries, kept on the payment's raw data. Whop puts them on
 * `line_items[]` (`product_title`, `plan_title`; verified 2026-10-16 on PMU's payments: "Beauty Moguls Method", plan_title null
 * as its plan has no title), the item for the payment's own product or plan first. A key left out was not carried (the engine
 * asks Whop); null was carried and is no name.
 */
export function whopNames(d: Record<string, unknown>): { product_name?: string | null; plan_name?: string | null } {
  const out: { product_name?: string | null; plan_name?: string | null } = {};
  const items = Array.isArray(d.line_items) ? (d.line_items as Array<Record<string, unknown> | null>).filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
  const li = items.find((x) => (d.product_id && x.product_id === d.product_id) || (d.plan_id && x.plan_id === d.plan_id)) ?? items[0];
  if (li && "product_title" in li) out.product_name = title(li.product_title);
  if (li && "plan_title" in li) out.plan_name = title(li.plan_title);
  // other shapes: a nested product / plan, or flat titles
  for (const [k, nested, flat] of [["product_name", d.product, d.product_title], ["plan_name", d.plan, d.plan_title]] as const) {
    if (out[k] !== undefined) continue;
    if (nested && typeof nested === "object" && "title" in (nested as Record<string, unknown>)) out[k] = title((nested as Record<string, unknown>).title);
    else if (flat !== undefined) out[k] = title(flat);
  }
  return out;
}

/** A Whop payment as the ledger wants it; a refund becomes its own negative row keyed by the payment id + ":refund". Open/void payments are not money and return nothing. */
export function paymentInputs(p: WhopPayment): PaymentInput[] {
  const base = { provider: "whop" as const, currency: (p.currency ?? p.total?.currency ?? "usd").toUpperCase(), email: p.customer_email ?? undefined, phone: p.customer_phone ?? undefined, memberId: p.member_id ?? undefined,
    raw: { billing_reason: p.billing_reason, plan_id: p.plan_id, product_id: p.product_id, ...whopNames(p as unknown as Record<string, unknown>), substatus: p.substatus, backfill: true } };
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
/**
 * D119 addendum: a product's or a plan's own name (`title`; a plan with none has `title: null`), for a payment whose payload did
 * not carry it. Verified 2026-10-16 on PMU's key: GET /products/{id} → { id, title, … }, GET /plans/{id} → { id, title, product: { id, title }, … }.
 * Short timeout: it runs while a Whop webhook waits for its answer (5 s).
 */
export async function whopGetTitle(apiKey: string, kind: "product" | "plan", id: string, timeoutMs = 3000): Promise<string | null> {
  const res = await fetch(`${BASE}/${kind}s/${encodeURIComponent(id)}`, { headers: headers(apiKey), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`whop: read ${kind} ${id} ${res.status} ${(await res.text()).slice(0, 160)}`);
  const j = (await res.json()) as { title?: unknown };
  return typeof j.title === "string" && j.title.trim() ? j.title.trim() : null;
}
/** Cheap key check: one payment. */
export async function whopPing(apiKey: string): Promise<boolean> {
  const res = await fetch(`${BASE}/payments?first=1`, { headers: headers(apiKey) });
  return res.ok;
}
