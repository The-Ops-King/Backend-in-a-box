import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { asOperator, one } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { applyPayment } from "@/engine/lifecycle";
import { dispatchEvent } from "@/engine/dispatch";
export const dynamic = "force-dynamic";

/**
 * Whop → payments + payment.* events + opportunity won. Payload field names are UNVERIFIED (engine/01-open.md #13);
 * the mapping is isolated in `parse` so correcting it is one function.
 */
function parse(body: Record<string, unknown>) {
  const d = (body.data ?? body) as Record<string, unknown>;
  const user = (d.user ?? d.customer ?? {}) as Record<string, unknown>;
  return {
    type: String(body.action ?? body.type ?? ""),
    whopPaymentId: String(d.id ?? ""),
    amount: Number(d.final_amount ?? d.amount ?? 0),
    currency: String(d.currency ?? "USD").toUpperCase(),
    installmentNo: typeof d.installment_number === "number" ? d.installment_number : undefined,
    email: typeof user.email === "string" ? user.email.toLowerCase() : undefined,
    paidAt: d.paid_at ? new Date(Number(d.paid_at) * 1000) : new Date(),
  };
}

export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const raw = await req.text();
  return asOperator(async (c) => {
    const { bindings } = await loadCompany(c, companyId);
    const secret = bindings["secret.whop_webhook"];
    if (secret) {
      const sig = req.headers.get("whop-signature") ?? req.headers.get("x-whop-signature") ?? "";
      const expected = createHmac("sha256", secret).update(raw).digest("hex");
      if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return NextResponse.json({ error: "bad signature" }, { status: 401 });
    }
    const p = parse(JSON.parse(raw));
    if (!p.whopPaymentId || !p.email) return NextResponse.json({ ok: true, ignored: "no payment id or email" });
    const ident = await one<{ contact_id: string }>(c, "select contact_id from contact_identifiers where company_id=$1 and kind='email' and value=$2", [companyId, p.email]);
    if (!ident) return NextResponse.json({ ok: true, ignored: `no contact for ${p.email}` });
    const status = /fail/i.test(p.type) ? "failed" : /refund/i.test(p.type) ? "refunded" : "succeeded";
    const ev = await applyPayment(c, companyId, ident.contact_id, { ...p, status, raw: { type: p.type } });
    const started = await dispatchEvent(c, ev, { contact: { id: ident.contact_id } });
    return NextResponse.json({ ok: true, event: ev.id, runs_started: started.length });
  });
}
