/**
 * D347: an agreement whose price the closer puts on the contact (Tyler, 2026-11-17: custom-priced enrollments, $7,000 instead of
 * $12,000, sent from GHL with the contact's Contract Value merged in; "we just cannot risk it going out with no price").
 *
 * The offer names the agreements that take their price from a contact field (`agreements.price_templates`, document names) and the
 * field (`agreements.price_field`, a field binding such as crm.field_contact_revenue_generated, or a GHL field id). Once such a
 * document is out (sent, viewed or completed; a draft is not out), the field is read once, live from the CRM, and kept on the
 * agreement: that is the price the client was sent. It is the deal's price from then on (agreement sent, then agreement once
 * signed, D322), and one line goes to `slack.channel.agreements`: sent at $X, or, with no price or one outside
 * `agreements.price_range` ("3000-15000"), a warning to check it before they sign, raised as an alert too. An offer without
 * `agreements.price_templates` is untouched.
 */
import type { PoolClient } from "pg";
import { one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { listSetting } from "./payments";
import { setDealPrice } from "./deal-price";
import { raise } from "./alerts";
import { slackBot } from "./slack-conn";
import type { AgreementRow } from "./agreements";

/** A document is out once the client has it; GHL keeps one the sender is still editing as a draft. */
export const isOut = (status: string) => ["sent", "viewed", "completed", "signed"].includes(status);

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Whether this offer prices the named document from the contact's field. */
export function pricedFromField(name: string | null | undefined, bindings: Record<string, string>): boolean {
  const n = norm(name);
  return !!n && listSetting(bindings["agreements.price_templates"]).some((t) => norm(t) === n);
}

/** "$7,000", "7000", 7000.5 → a positive number; anything else → null. */
export function priceValue(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/** "3000-15000" → [3000, 15000]; unset or unreadable → null (no range check). */
export function priceRange(v: string | undefined): [number, number] | null {
  const m = /^\s*\$?([\d,]+)\s*-\s*\$?([\d,]+)\s*$/.exec(v ?? "");
  if (!m) return null;
  const lo = Number(m[1].replace(/,/g, "")), hi = Number(m[2].replace(/,/g, ""));
  return lo > 0 && hi > lo ? [lo, hi] : null;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export type PriceRead = { price: number | null; problem: "none" | "missing" | "out_of_range"; posted: boolean };

type Deps = { companyId: string; ac: Company; adapters: Adapters; bindings: Record<string, string> };

/**
 * The price of a document priced from the contact: read once when it is out, then the deal's price. Called by the agreements poll
 * for every document of the offer; does nothing for one it does not price, one still a draft, or one already read.
 */
export async function readAgreementPrice(c: PoolClient, d: Deps, row: AgreementRow): Promise<PriceRead | null> {
  if (!row.contact_id || !pricedFromField(row.name, d.bindings) || !isOut(row.status) || row.price_read_at) return null;
  const binding = d.bindings["agreements.price_field"] ?? "";
  const fieldId = binding.startsWith("crm.") ? d.bindings[binding] : binding;
  const contact = await one<{ ghl_contact_id: string | null; name: string; assigned_ghl_user_id: string | null }>(c,
    "select ghl_contact_id, coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), 'them') as name, assigned_ghl_user_id from contacts where id=$1", [row.contact_id]);
  if (!fieldId || !contact?.ghl_contact_id) {
    await raise(c, { companyId: d.companyId, key: `agreements:price-setup:${d.companyId}`, level: "warning", source: "engine",
      text: `"${row.name}" takes its price from the contact, but ${fieldId ? "the contact isn't in GHL" : `agreements.price_field (${binding || "unset"}) doesn't name a field`}: its price can't be read.` });
    return null;
  }
  const live = await d.adapters.read.getContact(d.ac, contact.ghl_contact_id);
  const price = priceValue(live?.customFields?.[fieldId]);
  const range = priceRange(d.bindings["agreements.price_range"]);
  const problem: PriceRead["problem"] = price === null ? "missing" : range && (price < range[0] || price > range[1]) ? "out_of_range" : "none";
  // kept on the agreement, so a later change to the field never re-prices a contract already sent
  await c.query("update agreements set price=$2, price_read_at=now() where id=$1", [row.id, price]);
  if (price !== null)
    await setDealPrice(c, { ...d, contactId: row.contact_id, price, source: row.signed_at ? "agreement" : "agreement_sent", what: `"${row.name}"` });

  const owner = contact.assigned_ghl_user_id
    ? await one<{ slack_user_id: string | null }>(c, "select slack_user_id from users where company_id=$1 and ghl_user_id=$2 and active", [d.companyId, contact.assigned_ghl_user_id]) : null;
  const tag = owner?.slack_user_id ? ` <@${owner.slack_user_id}>` : "";
  const text = problem === "missing"
    ? `:rotating_light:${tag} "${row.name}" went to ${contact.name} with *no price*: their Contract Value is empty. Void it in GHL before they sign, set Contract Value, then send it again.`
    : problem === "out_of_range"
      ? `:warning:${tag} "${row.name}" went to ${contact.name} at *${usd(price!)}*, outside the usual ${usd(range![0])} to ${usd(range![1])}. If that's a typo, void it in GHL before they sign, fix Contract Value and send it again.`
      : `Agreement sent to ${contact.name} at ${usd(price!)} ("${row.name}").`;
  if (problem !== "none")
    await raise(c, { companyId: d.companyId, key: `agreements:price:${row.id}`, level: problem === "missing" ? "error" : "warning", source: "engine",
      text: text.replace(/^:\w+:\s*(<@\w+>\s*)?/, ""), detail: { agreement_id: row.id, price, problem } });

  const channel = d.bindings["slack.channel.agreements"];
  const bot = channel ? await slackBot(c, d.companyId) : null;
  let posted = false;
  if (bot && channel) {
    try { await d.adapters.notifier.post(bot.token, channel, text); posted = true; }
    catch (e) {
      await raise(c, { companyId: d.companyId, key: `agreements:price-post:${d.companyId}`, level: "warning", source: "engine",
        text: `Couldn't post the agreement price line to ${channel}: ${String((e as Error).message).slice(0, 160)}` });
    }
  }
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'agreement.price_read','agreement',$2,$3)",
    [d.companyId, row.id, { name: row.name, price, problem, field: fieldId, posted }]);
  return { price, problem, posted };
}
