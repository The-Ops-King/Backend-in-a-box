import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { recordPayment } from "@/engine/payments";
import { dispatchEvent } from "@/engine/dispatch";
import { parseWhopEvent, verifyWhopSignature, type WhopEnvelope } from "@/engine/webhooks/whop";
import { notifyTeam } from "@/engine/notify";
export const dynamic = "force-dynamic";

/**
 * Whop → ledger. Signature verified (Standard Webhooks), delivery id stored first so a retry is a no-op, then the payment
 * is recorded and linked by the identity ladder. An unlinked payment raises a team alert instead of starting workflows.
 */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const raw = await req.text();
  return asOperator(async (c) => {
    const { row: company, bindings } = await loadCompany(c, companyId);
    const secret = bindings["secret.whop_webhook"];
    if (!secret) return NextResponse.json({ error: "webhook secret not bound for this company" }, { status: 401 });
    const v = verifyWhopSignature(secret, { id: req.headers.get("webhook-id"), timestamp: req.headers.get("webhook-timestamp"), signature: req.headers.get("webhook-signature") }, raw);
    if (!v.ok) return NextResponse.json({ error: v.why }, { status: 401 });
    let env: WhopEnvelope;
    try { env = JSON.parse(raw) as WhopEnvelope; } catch { return NextResponse.json({ error: "body is not JSON" }, { status: 400 }); }
    const first = await one(c, "insert into webhook_deliveries (company_id, provider, delivery_id) values ($1,'whop',$2) on conflict do nothing returning delivery_id", [companyId, env.id]);
    if (!first) return NextResponse.json({ ok: true, duplicate_delivery: true });
    const p = parseWhopEvent(env);
    if (!p) return NextResponse.json({ ok: true, ignored: env.type });
    const r = await recordPayment(c, companyId, p);
    if (r.outcome === "duplicate") return NextResponse.json({ ok: true, duplicate: true, payment: r.payment.id });
    if (r.outcome === "unlinked") {
      await notifyTeam(c, company, bindings, "alerts", `*Unlinked payment* · $${Math.abs(p.amount).toFixed(2)} ${p.status}\nNobody in the CRM matched this buyer.\n*Email:* ${p.email ?? "—"} · *Phone:* ${p.phone ?? "—"} · *Whop member:* ${p.memberId ?? "—"}\nLink it: ${process.env.TICK_URL ?? ""}/c/${company.slug}/payments`);
      return NextResponse.json({ ok: true, unlinked: true, payment: r.payment.id });
    }
    const started = await dispatchEvent(c, r.event, { contact: { id: r.contactId } });
    return NextResponse.json({ ok: true, event: r.event.id, kind: r.payment.kind, healed: r.healed, runs_started: started.length });
  });
}
