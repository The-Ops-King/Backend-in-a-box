import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { receiveTypeform } from "@/engine/typeform";
import { respondAndRun } from "@/api/run-soon";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/** Typeform → GHL and the ledger (D122). `Typeform-Signature` checked against secret.typeform_webhook; a response already seen is a no-op (Typeform retries). */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const raw = await req.text();
  const r = await asOperator((c) => receiveTypeform(c, companyId, req.headers.get("typeform-signature"), raw, liveAdapters));
  return respondAndRun(companyId, r.body, { status: r.status });   // D202
}
