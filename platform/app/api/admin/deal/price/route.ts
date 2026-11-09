import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { setDealPrice } from "@/engine/deal-price";
import { SALE_ORDER } from "@/engine/payments";
export const dynamic = "force-dynamic";

/**
 * D322: POST { company, contact: <GHL id or ours>, price, why, dryRun = true }: a person sets what the deal is worth (stronger than an
 * agreement or an end of day), and its payments are checked again against it (see `setDealPrice`). The dry run says the deal as it
 * is. Audited. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; contact?: string; price?: number; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !b.contact || !(Number(b.price) > 0) || !b.why?.trim()) return NextResponse.json({ error: "company, contact, price (> 0) and why are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const ct = await one<{ id: string; name: string }>(c, "select id, coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), ghl_contact_id) as name from contacts where company_id=$1 and (ghl_contact_id=$2 or id::text=$2)", [co.id, b.contact]);
    if (!ct) return NextResponse.json({ error: "no such contact on this offer" }, { status: 404 });
    const deal = await one<{ id: string; contract_value: string | null; price_source: string | null; status: string; collected: string }>(c,
      `select o.id, o.contract_value, o.price_source, o.status, coalesce((select sum(amount) from payments p where p.opportunity_id=o.id and p.status in ('succeeded','refunded')),0)::text as collected
       from opportunities o where o.company_id=$1 and o.contact_id=$2 and o.status in ('open','won') ${SALE_ORDER} limit 1`, [co.id, ct.id]);
    if (!deal) return NextResponse.json({ error: `${ct.name} has no open or won deal` }, { status: 404 });
    if (b.dryRun !== false) return NextResponse.json({ ok: true, dryRun: true, who: ct.name, deal: { status: deal.status, price: deal.contract_value === null ? null : Number(deal.contract_value), from: deal.price_source, collected: Number(deal.collected) }, now: { price: Number(b.price), from: "operator" } });
    const { adapterCompany: ac, bindings } = await loadCompany(c, co.id);
    const r = await setDealPrice(c, { companyId: co.id, ac, adapters: liveAdapters, bindings, contactId: ct.id, price: Number(b.price), source: "operator" });
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'deal.price_set','opportunity',$2,$3,$4)", [co.id, deal.id, { price: deal.contract_value, from: deal.price_source }, { price: Number(b.price), why: b.why!.trim(), reconciled: r.reconciled ?? null }]);
    return NextResponse.json({ ok: true, dryRun: false, who: ct.name, ...r });
  });
}
