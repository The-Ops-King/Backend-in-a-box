import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { parseZapierRecording } from "@/engine/webhooks/zapier";
import { ingestRecording, zapierAuthorized } from "@/engine/inbound";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/** Fathom (or any recorder) → Zapier → here. Same secret as the payment door; body fields in parseZapierRecording. */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ error: "body is not JSON" }, { status: 400 }); }
  return asOperator(async (c) => {
    const { row: company, bindings } = await loadCompany(c, companyId);
    if (!zapierAuthorized(req, bindings)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const parsed = parseZapierRecording(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.why }, { status: 400 });
    return NextResponse.json(await ingestRecording(c, company, bindings, parsed.input));
  });
}
