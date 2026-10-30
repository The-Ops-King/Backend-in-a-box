import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { loadCompany } from "@/engine/context";
import { dropUnmatchedFailure, recordPayment } from "@/engine/payments";
import { dispatchEvent } from "@/engine/dispatch";
import { fillWhopBuyer, parseWhopEvent, verifyWhopSignature, type WhopEnvelope } from "@/engine/webhooks/whop";
import { respondAndRun } from "@/api/run-soon";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * Whop → ledger. Signature verified (Standard Webhooks), delivery id stored first so a retry is a no-op, then the payment
 * is recorded and linked by the identity ladder. An unlinked payment is `payment.unlinked`, which starts the Unlinked payment workflow (D88).
 */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const raw = await req.text();
  return asOperator(async (c) => {
    const { bindings, row, adapterCompany } = await loadCompany(c, companyId);
    const secret = bindings["secret.whop_webhook"];
    if (!secret) return respondAndRun(companyId, { error: "webhook secret not bound for this company" }, { status: 401 });
    const v = verifyWhopSignature(secret, { id: req.headers.get("webhook-id"), timestamp: req.headers.get("webhook-timestamp"), signature: req.headers.get("webhook-signature") }, raw);
    if (!v.ok) return respondAndRun(companyId, { error: v.why }, { status: 401 });
    let env: WhopEnvelope;
    try { env = JSON.parse(raw) as WhopEnvelope; } catch { return respondAndRun(companyId, { error: "body is not JSON" }, { status: 400 }); }
    const first = await one(c, "insert into webhook_deliveries (company_id, provider, delivery_id) values ($1,'whop',$2) on conflict do nothing returning delivery_id", [companyId, env.id]);
    if (!first) return respondAndRun(companyId, { ok: true, duplicate_delivery: true });
    const parsed = parseWhopEvent(env);
    if (!parsed) return respondAndRun(companyId, { ok: true, ignored: env.type });
    const p = await fillWhopBuyer(parsed, bindings["secret.whop_api_key"]);   // D229: a webhook with no buyer is read back from Whop's API
    const dropped = await dropUnmatchedFailure(c, companyId, p);   // D229
    if (dropped) return respondAndRun(companyId, { ok: true, ignored: dropped });
    const r = await recordPayment(c, companyId, p, undefined, { ghl: { ac: adapterCompany, adapters: liveAdapters, bindings, tz: row.timezone } });   // D270: GHL decides the buyer and what they paid
    if (r.outcome === "duplicate") return respondAndRun(companyId, { ok: true, duplicate: true, payment: r.payment.id });
    if (r.outcome === "skipped") return respondAndRun(companyId, { ok: true, ignored: r.why });   // D270
    if (r.outcome === "unlinked") {
      await dispatchEvent(c, r.event, {});   // D88: the Unlinked payment workflow tells the team
      return respondAndRun(companyId, { ok: true, unlinked: true, payment: r.payment.id });
    }
    const started = await dispatchEvent(c, r.event, { contact: { id: r.contactId } });
    return respondAndRun(companyId, { ok: true, event: r.event.id, kind: r.payment.kind, healed: r.healed, runs_started: started.length });
  });
}
