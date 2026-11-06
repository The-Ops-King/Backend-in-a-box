import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { setPaymentKind, type PaymentKind } from "@/engine/payment-kind";
export const dynamic = "force-dynamic";

/**
 * D317: POST { company, payment: <our id or Whop's pay_…>, kind: deposit | installment | balance | paid_in_full, price?: the deal's full
 * price, why, dryRun = true }: what one payment is, put right in the ledger, the deal, the GHL Cash record and the closer card (see
 * `setPaymentKind`). Audited. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; payment?: string; kind?: PaymentKind; price?: number; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !b.payment || !b.kind) return NextResponse.json({ error: "company, payment, kind and why are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany: ac, bindings } = await loadCompany(c, co.id);
    const r = await setPaymentKind(c, { companyId: co.id, ac, adapters: liveAdapters, bindings, payment: b.payment!, kind: b.kind!, price: b.price, why: b.why ?? "", dryRun: b.dryRun });
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
  });
}
