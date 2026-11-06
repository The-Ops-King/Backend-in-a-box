import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { loadCompany } from "@/engine/context";
import { commasFailedInput, verifyCommasSignature, type CommasEnvelope } from "@/adapters/commas/client";
import { COMMAS_SECRET, syncCommas, takeCommasPayment } from "@/engine/commas";
import { respondAndRun } from "@/api/run-soon";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D319: Commas → ledger. The signature is checked on the raw body, the delivery id stored first (a repeat is a no-op). A failed
 * charge is recorded from the webhook (the transaction list holds only payments made); anything else asks for the read now
 * (`syncCommas`), which records what is new by its transaction id, so a payment is the same row whichever way it arrives.
 */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const raw = await req.text();
  return asOperator(async (c) => {
    const co = await loadCompany(c, companyId);
    const secret = co.bindings[COMMAS_SECRET];
    if (!secret) return respondAndRun(companyId, { error: "webhook secret not bound for this company" }, { status: 401 });
    if (!verifyCommasSignature(secret, raw, req.headers.get("x-webhook-signature"))) return respondAndRun(companyId, { error: "bad signature" }, { status: 401 });
    let env: CommasEnvelope;
    try { env = JSON.parse(raw) as CommasEnvelope; } catch { return respondAndRun(companyId, { error: "body is not JSON" }, { status: 400 }); }
    if (!env.id || !env.type) return respondAndRun(companyId, { ok: true, ignored: "no envelope (a test delivery)" });
    const first = await one(c, "insert into webhook_deliveries (company_id, provider, delivery_id) values ($1,'commas',$2) on conflict do nothing returning delivery_id", [companyId, env.id]);
    if (!first) return respondAndRun(companyId, { ok: true, duplicate_delivery: true });
    const loaded = { row: co.row, adapterCompany: co.adapterCompany, bindings: co.bindings };
    const failed = commasFailedInput(env);
    if (failed) {
      const out = { recorded: 0, linked: 0, unlinked: 0, duplicates: 0, skipped: 0, runs: 0 };
      await takeCommasPayment(c, loaded, liveAdapters, failed, out);
      return out.recorded ? respondAndRun(companyId, { ok: true, ...out }) : respondAndRun(companyId, { ok: true, ignored: out.duplicates ? "already recorded" : "dropped" });
    }
    const r = await syncCommas(c, loaded, liveAdapters);
    return r.recorded ? respondAndRun(companyId, { ok: true, event: env.type, ...r }) : respondAndRun(companyId, { ok: true, ignored: r.error ?? `${env.type}: nothing new in the transaction list yet (read again within 10 minutes)` });
  });
}
