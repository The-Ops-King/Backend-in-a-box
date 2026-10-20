import { asOperator, one } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { verifyStandardWebhook, webhookHeaders } from "@/engine/webhooks/standard";
import { parseFathomMeeting, type FathomMeeting } from "@/engine/webhooks/fathom";
import { ingestRecording } from "@/engine/inbound";
import { respondAndRun } from "@/api/run-soon";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/** Fathom → recordings ledger. Standard Webhooks signature (secret.fathom_webhook), delivery id stored first so a retry is a no-op. */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const raw = await req.text();
  return asOperator(async (c) => {
    const { row: company, bindings } = await loadCompany(c, companyId);
    const secret = bindings["secret.fathom_webhook"];
    if (!secret) return respondAndRun(companyId, { error: "fathom webhook secret not bound for this company" }, { status: 401 });
    const v = verifyStandardWebhook(secret, webhookHeaders(req), raw);
    if (!v.ok) return respondAndRun(companyId, { error: v.why }, { status: 401 });
    let body: FathomMeeting;
    try { body = JSON.parse(raw) as FathomMeeting; } catch { return respondAndRun(companyId, { error: "body is not JSON" }, { status: 400 }); }
    const first = await one(c, "insert into webhook_deliveries (company_id, provider, delivery_id) values ($1,'fathom',$2) on conflict do nothing returning delivery_id", [companyId, req.headers.get("webhook-id")]);
    if (!first) return respondAndRun(companyId, { ok: true, duplicate_delivery: true });
    const parsed = parseFathomMeeting(body);
    if (!parsed.ok) return respondAndRun(companyId, { error: parsed.why }, { status: 400 });
    return respondAndRun(companyId, await ingestRecording(c, company, bindings, parsed.input));
  });
}
