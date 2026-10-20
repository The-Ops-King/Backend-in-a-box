import { asOperator } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { parseZapierRecording } from "@/engine/webhooks/zapier";
import { ingestRecording, zapierAuthorized } from "@/engine/inbound";
import { respondAndRun } from "@/api/run-soon";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/** Fathom (or any recorder) → Zapier → here. Same secret as the payment door; body fields in parseZapierRecording. */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return respondAndRun(companyId, { error: "body is not JSON" }, { status: 400 }); }
  return asOperator(async (c) => {
    const { row: company, bindings } = await loadCompany(c, companyId);
    if (!zapierAuthorized(req, bindings)) return respondAndRun(companyId, { error: "unauthorized" }, { status: 401 });
    const parsed = parseZapierRecording(body);
    if (!parsed.ok) return respondAndRun(companyId, { error: parsed.why }, { status: 400 });
    return respondAndRun(companyId, await ingestRecording(c, company, bindings, parsed.input));
  });
}
