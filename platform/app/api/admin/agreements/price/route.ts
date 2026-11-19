import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { isOut, planAgreementPrice, pricedFromField, readAgreementPrice } from "@/engine/agreement-price";
import type { AgreementRow } from "@/engine/agreements";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D347: POST { company, agreement: <GHL document id or ours>, why, dryRun = true }: read the price one agreement priced from the
 * contact went out at, again, as the poll does the first time (a contract fixed after it went out, or a test). The dry run says what
 * it would read and post, writing nothing; live, it keeps the price, sets the deal's, posts the line and raises any alert. Audited.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; agreement?: string; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !b.agreement || !b.why?.trim()) return NextResponse.json({ error: "company, agreement and why are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const row = await one<AgreementRow>(c, "select * from agreements where company_id=$1 and (external_id=$2 or id::text=$2)", [co.id, b.agreement]);
    if (!row) return NextResponse.json({ error: "no such agreement on this offer" }, { status: 404 });
    const { adapterCompany: ac, bindings } = await loadCompany(c, co.id);
    if (!pricedFromField(row.name, bindings)) return NextResponse.json({ error: `"${row.name}" is not one of this offer's agreements.price_templates` }, { status: 400 });
    if (!isOut(row.status)) return NextResponse.json({ error: `"${row.name}" is ${row.status}, not out yet` }, { status: 400 });
    if (!row.contact_id) return NextResponse.json({ error: "this agreement has no contact" }, { status: 400 });
    const deps = { companyId: co.id, ac, adapters: liveAdapters, bindings };
    const was = { price: row.price ?? null, read_at: row.price_read_at ?? null };
    if (b.dryRun !== false) return NextResponse.json({ ok: true, dryRun: true, agreement: { id: row.id, name: row.name, status: row.status, sent_at: row.sent_at }, was, plan: await planAgreementPrice(c, deps, row) });
    const r = await readAgreementPrice(c, deps, row, { again: true });
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'agreement.price_reread','agreement',$2,$3,$4)", [co.id, row.id, was, { result: r, why: b.why!.trim() }]);
    return NextResponse.json({ ok: true, dryRun: false, agreement: { id: row.id, name: row.name }, was, result: r });
  });
}
