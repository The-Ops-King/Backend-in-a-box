import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { whopBuyer, whopGetPayment, whopNames } from "@/adapters/whop/client";
import { linkFoundBuyer, linkPicked, resolvePayer } from "./payments";
import { normEmail } from "./identity";

/**
 * D229: the payments that went in unlinked because their webhook carried no buyer, read back from Whop's API by id and linked
 * by the ledger's own ladder. Only rows with no email, phone or member id are read (one that has them and still matched nobody
 * is a person's to link). Dry run says who each would link to and changes nothing. Applied: oldest first, the buyer is kept on the
 * row and the row is linked. No workflow starts.
 * `pick` is a person's answer for a buyer the ladder cannot find (Whop's email is not the one GHL has): { pay_…: contact id }. Only the
 * payments named there or in `ids` are touched then, and the picked person keeps Whop's email so their next payment links on its own.
 */
export type RelinkRow = { payment: string; whop_payment_id: string; amount: number; status: string; paid_at: string; email: string | null; phone: string | null; member_id: string | null;
  product_name: string | null; links_to: { contact: string; name: string; by: string } | null; linked?: boolean; error?: string };

export async function relinkWhopBuyers(c: PoolClient, companyId: string, apiKey: string, opts: { dryRun: boolean; ids?: string[]; pick?: Record<string, string>; get?: typeof whopGetPayment }): Promise<RelinkRow[]> {
  const get = opts.get ?? ((k: string, id: string) => whopGetPayment(k, id, 10_000));
  const pick = opts.pick ?? {};
  const only = [...(opts.ids ?? []), ...Object.keys(pick)];
  const rows = await many<{ id: string; whop_payment_id: string; amount: string; status: string; paid_at: Date; raw: Record<string, unknown> | null }>(c,
    `select id, whop_payment_id, amount, status, paid_at, raw from payments where company_id=$1 and provider='whop' and link_status='unlinked' and status<>'refunded'
       and customer_email is null and customer_phone is null and whop_member_id is null and ($2::text[] is null or id::text = any($2) or whop_payment_id = any($2)) order by paid_at, whop_payment_id`, [companyId, only.length ? only : null]);
  const out: RelinkRow[] = [];
  for (const r of rows) {
    const row: RelinkRow = { payment: r.id, whop_payment_id: r.whop_payment_id, amount: Number(r.amount), status: r.status, paid_at: r.paid_at.toISOString(), email: null, phone: null, member_id: null, product_name: (r.raw?.product_name as string | undefined) ?? null, links_to: null };
    out.push(row);
    let d: Record<string, unknown>;
    try { d = await get(apiKey, r.whop_payment_id); } catch (e) { row.error = String((e as Error).message).slice(0, 200); continue; }
    const b = whopBuyer(d), names = whopNames(d);
    Object.assign(row, { email: normEmail(b.email) ?? null, phone: b.phone ?? null, member_id: b.memberId ?? null, product_name: row.product_name ?? names.product_name ?? null });
    if (!row.email && !row.phone && !row.member_id) { row.error = "Whop's copy names no buyer either"; continue; }
    const picked = pick[r.whop_payment_id] ?? pick[r.id];
    if (picked && !(await one(c, "select 1 from contacts where company_id=$1 and id=$2 and merged_into is null", [companyId, picked]))) { row.error = `no such contact ${picked}`; continue; }
    const m = picked ? { contactId: picked, by: "manual" } : await resolvePayer(c, companyId, { email: row.email ?? undefined, phone: row.phone ?? undefined, memberId: row.member_id ?? undefined });
    if (m) row.links_to = { contact: m.contactId, by: m.by, name: (await one<{ n: string }>(c, "select trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) as n from contacts where id=$1", [m.contactId]))?.n ?? "" };
    if (opts.dryRun) continue;
    const raw = { ...(r.raw ?? {}) };
    for (const [k, v] of Object.entries({ product_id: b.product_id, plan_id: b.plan_id, membership_id: b.membership_id, ...names })) if (raw[k] == null && v !== undefined) raw[k] = v;
    raw.buyer_from = "whop_api";
    await c.query("update payments set customer_email=$2, customer_phone=$3, whop_member_id=$4, raw=$5 where id=$1", [r.id, row.email, row.phone, row.member_id, raw]);
    // linked as each buyer is learned, oldest first, so each one's totals count only what came before it (a later row given its buyer
    // first would be healed in ahead of this one with the wrong running total)
    if (picked) await linkPicked(c, companyId, r.id, picked);
    else if (row.links_to) await linkFoundBuyer(c, companyId, r.id, { dispatch: false });
  }
  if (opts.dryRun) return out;
  for (const row of out) row.linked = !!(await one(c, "select 1 from payments where id=$1 and link_status='linked'", [row.payment]));
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'payments.relinked','company',$2,$3)", [companyId, companyId, { rows: out }]);
  return out;
}
