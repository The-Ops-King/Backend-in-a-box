import type { PoolClient } from "pg";
import { one } from "@/db/client";
import { whopGetTitle } from "@/adapters/whop/client";
import { decrypt } from "./crypto";
import { raise } from "./alerts";

/**
 * D119 addendum (2026-10-16): a payment is a deposit when its Whop product's name or its plan's name has the word "deposit" in
 * it, whole and in any case ("Deposit", "VIP Deposit", "Deposit - $250"; not "deposited", not "nondeposit"). It is a naming
 * convention on a label the company itself sets at Whop, read exactly like an id, not a reading of what a name means. A company
 * that declares deposit products (`payments.deposit_products`) is told by its list alone: the declaration wins.
 */
export const DEPOSIT_WORD = /(?<![\p{L}\p{N}])deposit(?![\p{L}\p{N}])/iu;
export const saysDeposit = (name: unknown): boolean => typeof name === "string" && DEPOSIT_WORD.test(name);

/** How long a name read from Whop is trusted before it is read again (a product renamed later is seen within the hour). */
export const NAMES_TTL_MS = 60 * 60e3;
const cacheKey = (companyId: string) => `whop_names:${companyId}`;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The alert a payment that could not be checked raises (one per payment; a person resolves it). */
export const uncheckedAlertKey = (paymentId: string) => `payment:deposit-unchecked:${paymentId}`;

export type NamedRow = { id: string; provider: string; status: string; amount: string | number; whop_payment_id: string; customer_email: string | null; raw?: Record<string, unknown> | null };

/** A Whop name, from the company's cache when it is fresh, else from Whop (and cached). Throws when Whop cannot be read. */
async function whopTitle(c: PoolClient, companyId: string, apiKey: string, kind: "product" | "plan", id: string, now: Date): Promise<string | null> {
  const cache = (await one<{ value: Record<string, { name: string | null; at: string }> }>(c, "select value from engine_state where key=$1", [cacheKey(companyId)]))?.value ?? {};
  const hit = cache[`${kind}:${id}`];
  if (hit && now.getTime() - Date.parse(hit.at) < NAMES_TTL_MS) return hit.name;
  const name = await whopGetTitle(apiKey, kind, id);
  await c.query(`insert into engine_state (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = engine_state.value || excluded.value, updated_at = now()`,
    [cacheKey(companyId), { [`${kind}:${id}`]: { name, at: now.toISOString() } }]);
  return name;
}

/**
 * Names a new succeeded payment whose payload did not carry its product's or plan's name, so the naming rule can read it.
 * Whop's webhook and its payment list carry them (`line_items[]`); a Zap may not, and then the ids are read from Whop with
 * the company's key. Returns the raw data to keep (names added), or null when there is nothing to do: a failed payment or a
 * refund (their kinds never are deposits), a company that declares its deposit products, a name that already says deposit,
 * names already carried, or no product or plan at all.
 *
 * When a name cannot be had (no key, Whop down, an unknown id) the payment is not a deposit, it is never held, and it is flagged
 * (`raw.deposit_check`) with an alert to the team: taken wrongly as a deposit, a real payment would send no agreement and never
 * close, silently; taken wrongly as not one, the agreement goes early, and the alert says so the same minute.
 */
export async function nameThePayment(c: PoolClient, companyId: string, p: NamedRow, declared: string[], now = new Date()): Promise<Record<string, unknown> | null> {
  const raw: Record<string, unknown> = { ...(p.raw ?? {}) };
  if (p.status !== "succeeded" || declared.length) return null;
  if (saysDeposit(raw.product_name) || saysDeposit(raw.plan_name)) return null;
  const plan = str(raw.plan);
  const want: Array<{ kind: "product" | "plan"; id: string; key: "product_name" | "plan_name" }> = [];
  const productId = str(raw.product_id), planId = str(raw.plan_id) ?? (plan?.startsWith("plan_") ? plan : undefined);
  if (raw.product_name === undefined && productId) want.push({ kind: "product", id: productId, key: "product_name" });
  if (raw.plan_name === undefined && planId) want.push({ kind: "plan", id: planId, key: "plan_name" });
  if (!want.length) return null;

  const missing: string[] = [];
  let why: string | null = null;
  if (p.provider !== "whop") why = `the payment came without its product's and plan's names, and only Whop's can be looked up (${p.provider})`;
  else {
    const b = await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='secret.whop_api_key'", [companyId]);
    if (!b) why = "the payment came without its product's and plan's names, and no Whop API key is bound to look them up";
    else {
      const apiKey = decrypt(b.value);
      for (const w of want) {
        try {
          raw[w.key] = await whopTitle(c, companyId, apiKey, w.kind, w.id, now);
          if (saysDeposit(raw[w.key])) break;   // one name saying deposit is enough
        } catch (e) { missing.push(`${w.kind} ${w.id}`); why = String((e as Error).message).slice(0, 200); }
      }
      if (saysDeposit(raw.product_name) || saysDeposit(raw.plan_name)) why = null;
      else if (why) why = `Whop could not be read for its ${missing.join(" and ")}: ${why}`;
      raw.names_from = "whop";
    }
  }
  if (why) {
    raw.deposit_check = { failed: why, at: now.toISOString() };
    const co = await one<{ slug: string }>(c, "select slug from companies where id=$1", [companyId]);
    const amount = Number(p.amount);
    await raise(c, { companyId, key: uncheckedAlertKey(p.id), level: "error", source: "engine", href: co ? `/app/c/${co.slug}` : null,
      text: `A $${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} payment (${p.whop_payment_id}${p.customer_email ? `, ${p.customer_email}` : ""}) could not be checked for a deposit: ${why}. It was taken as not a deposit, so if it is the first payment the agreement goes out on it. If it was a deposit, handle that person by hand.`,
      detail: { payment_id: p.id, provider_payment_id: p.whop_payment_id, product_id: productId ?? null, plan_id: planId ?? null, why } }, now);
  }
  return raw;
}
