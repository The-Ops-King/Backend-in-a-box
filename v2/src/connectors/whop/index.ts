import { PortError } from "@/engine/ports";
import { attemptOnce, failFor, withPolicy } from "../framework/http";
import type { Hub } from "../framework/hub";
import type { CanonicalFact, Connection, J, Normalized } from "../framework/types";

/**
 * Whop, behind the payments port (facts in, nothing out). Its webhooks are Standard Webhooks (signed with the ws_ /
 * whsec_ secret Whop gives once when the webhook is made), envelope { id, type, data } (v1's whop.ts, verified).
 *
 * | Whop event | Canonical fact |
 * | --- | --- |
 * | payment.succeeded | payment.received (or payment.unlinked when no one contact is the payer) |
 * | payment.failed | payment.failed (or payment.unlinked, status failed) |
 * | refund.created | payment.refunded (negative, its own row, pointing at the payment) |
 *
 * The payer is found by v1's ladder, one hit or nothing: the Whop member already linked on an earlier payment, then
 * email, then phone. An unlinked payment is linked by a person in Slack (payment.linked).
 */

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const amountOf = (v: unknown): number | undefined => {
  if (v && typeof v === "object" && "amount" in (v as J)) { const n = Number((v as J).amount); return Number.isFinite(n) ? n : undefined; }
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? undefined : n;
};
const when = (s: unknown, dflt: Date) => (typeof s === "string" && !Number.isNaN(Date.parse(s)) ? new Date(s) : dflt);

/** The product's and plan's names, from the payment's line items (verified on PMU), a nested object, or flat titles. */
export function whopNames(d: J): { product_name?: string | null; plan_name?: string | null } {
  const out: { product_name?: string | null; plan_name?: string | null } = {};
  const items = Array.isArray(d.line_items) ? (d.line_items as J[]).filter((x) => x && typeof x === "object") : [];
  const li = items.find((x) => (d.product_id && x.product_id === d.product_id) || (d.plan_id && x.plan_id === d.plan_id)) ?? items[0];
  if (li && "product_title" in li) out.product_name = str(li.product_title) ?? null;
  if (li && "plan_title" in li) out.plan_name = str(li.plan_title) ?? null;
  if (out.product_name === undefined && d.product && typeof d.product === "object") out.product_name = str((d.product as J).title) ?? null;
  if (out.plan_name === undefined && d.plan && typeof d.plan === "object") out.plan_name = str((d.plan as J).title) ?? null;
  return out;
}

type Payment = { id: string; status: "succeeded" | "failed" | "refunded"; amount: number; currency: string; paidAt: Date; email?: string; phone?: string; memberId?: string; extra: J };

/** A Whop event's data as a payment, or undefined for an event the ledger does not record. */
export function paymentOf(type: string, d: J, now: Date): Payment | undefined {
  const base = {
    currency: String(d.currency ?? (d.total as J | undefined)?.currency ?? "usd").toUpperCase(), email: str(d.customer_email)?.toLowerCase(), phone: str(d.customer_phone), memberId: str(d.member_id),
    extra: { product_id: str(d.product_id) ?? null, plan_id: str(d.plan_id) ?? null, ...whopNames(d), billing_reason: str(d.billing_reason) ?? null },
  };
  switch (type) {
    case "payment.succeeded": { const amount = amountOf(d.total) ?? amountOf(d.subtotal); return amount === undefined ? undefined : { ...base, id: String(d.id), status: "succeeded", amount, paidAt: when(d.paid_at ?? d.created_at, now) }; }
    case "payment.failed": return { ...base, id: String(d.id), status: "failed", amount: amountOf(d.total) ?? amountOf(d.subtotal) ?? 0, paidAt: when(d.last_payment_attempt_at ?? d.created_at, now), extra: { ...base.extra, failure_message: str(d.failure_message) ?? null } };
    case "refund.created": { const amount = amountOf(d.amount) ?? amountOf(d.total); return amount === undefined ? undefined : { ...base, id: String(d.id), status: "refunded", amount: -Math.abs(amount), paidAt: when(d.created_at, now), extra: { ...base.extra, refund_of: str(d.payment_id) ? `whop:${str(d.payment_id)}` : null } }; }
    default: return undefined;
  }
}

/** A payment as its fact: linked to the one contact it is, or unlinked. */
export async function paymentFact(hub: Hub, conn: Connection, p: Payment, source: string): Promise<CanonicalFact> {
  const memberHit = p.memberId ? await hub.contactOfCustomer(conn.offerId, p.memberId) : undefined;
  const hit = memberHit ? { id: memberHit, by: "member" } : await hub.matchContact(conn.offerId, { email: p.email ?? null, phone: p.phone ?? null });
  const type = !hit ? "payment.unlinked" : p.status === "succeeded" ? "payment.received" : p.status === "failed" ? "payment.failed" : "payment.refunded";
  return {
    offerId: conn.offerId, type, occurredAt: p.paidAt, source, dedupeKey: `whop:payment:${p.id}:${p.status}`, contactId: hit?.id ?? null,
    payload: {
      payment_id: `whop:${p.id}`, provider: "whop", provider_payment_id: p.id, status: p.status, amount: p.amount, currency: p.currency, paid_at: p.paidAt.toISOString(),
      customer_email: p.email ?? null, customer_phone: p.phone ?? null, whop_member_id: p.memberId ?? null, ...p.extra, ...(hit ? { linked_by: hit.by } : {}),
    },
  };
}

export async function normalizeWhop(hub: Hub, conn: Connection, body: J, source = "whop"): Promise<Normalized> {
  const type = String(body.type ?? "");
  const p = paymentOf(type, (body.data ?? {}) as J, hub.now());
  if (!p) return { facts: [], outcome: `ignored ${type || "an event without a type"}` };
  return { facts: [await paymentFact(hub, conn, p, source)], outcome: "facts" };
}

/** The reconcile: Whop's payments made in the window (cursor-paged), as the webhooks would have said them (refunds aside). */
export async function reconcileWhop(hub: Hub, conn: Connection, from: Date, to: Date): Promise<{ facts: CanonicalFact[] }> {
  const key = conn.credentials.api_key;
  if (!key) throw new PortError("auth", "the Whop connection has no API key");
  const facts: CanonicalFact[] = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ created_after: from.toISOString(), created_before: to.toISOString(), first: "50", order: "created_at", direction: "asc", ...(after ? { after } : {}) });
    const out = await withPolicy(hub.http, "Whop", () => attemptOnce(hub.http, `https://api.whop.com/api/v1/payments?${q}`, { method: "GET", headers: { authorization: `Bearer ${key}`, accept: "application/json" } }, 20_000), { write: false });
    if ("confirmed" in out) break;
    if (out.res.status >= 400) throw failFor("Whop", out.res, "GET /payments");
    const j = out.res.body as { data?: J[]; page_info?: { has_next_page?: boolean; end_cursor?: string } };
    for (const pay of j.data ?? []) {
      const status = String(pay.status ?? "");
      const p = status === "paid" ? paymentOf("payment.succeeded", pay, hub.now()) : status === "failed" || pay.substatus === "failed" ? paymentOf("payment.failed", pay, hub.now()) : undefined;
      if (p) facts.push(await paymentFact(hub, conn, p, "reconcile"));
      // refunds are not reconciled: the payments list carries refunded_amount, not the refund's own id, so a refund found
      // here could not be told from its webhook's fact and would count twice
    }
    if (!j.page_info?.has_next_page || !j.page_info.end_cursor) break;
    after = j.page_info.end_cursor;
  }
  return { facts };
}
