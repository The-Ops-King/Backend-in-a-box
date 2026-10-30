import { asOperator } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { dropUnmatchedFailure, recordPayment } from "@/engine/payments";
import { dispatchEvent } from "@/engine/dispatch";
import { parseZapierPayment } from "@/engine/webhooks/zapier";
import { zapierAuthorized } from "@/engine/inbound";
import { respondAndRun } from "@/api/run-soon";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * Whop → Zapier → here. Authenticated with the company's inbound secret (install returns it) as `Authorization: Bearer`
 * or `x-engine-secret`. Body: the Zap's mapped fields; see parseZapierPayment for accepted names.
 */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return respondAndRun(companyId, { error: "body is not JSON" }, { status: 400 }); }
  return asOperator(async (c) => {
    const { bindings } = await loadCompany(c, companyId);
    if (!zapierAuthorized(req, bindings)) return respondAndRun(companyId, { error: "unauthorized" }, { status: 401 });
    const parsed = parseZapierPayment(body);
    if (!parsed.ok) return respondAndRun(companyId, { error: parsed.why }, { status: 400 });
    const dropped = await dropUnmatchedFailure(c, companyId, parsed.input);   // D229
    if (dropped) return respondAndRun(companyId, { ok: true, ignored: dropped });
    const r = await recordPayment(c, companyId, parsed.input);
    if (r.outcome === "duplicate") return respondAndRun(companyId, { ok: true, duplicate: true, payment: r.payment.id });
    if (r.outcome === "skipped") return respondAndRun(companyId, { ok: true, ignored: r.why });   // D270
    if (r.outcome === "unlinked") {
      await dispatchEvent(c, r.event, {});   // D88: the Unlinked payment workflow tells the team
      return respondAndRun(companyId, { ok: true, unlinked: true, payment: r.payment.id });
    }
    const started = await dispatchEvent(c, r.event, { contact: { id: r.contactId } });
    return respondAndRun(companyId, { ok: true, event: r.event.id, kind: r.payment.kind, running_total: r.event.data.running_total, cleared: r.event.data.cleared, healed: r.healed, runs_started: started.length });
  });
}
