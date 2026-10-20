import { NextResponse, after } from "next/server";
import { liveAdapters } from "@/adapters";
import { nudgeAuthorized } from "@/engine/inbound";
import { pollDocumentsNow } from "@/engine/poll";
import { runCompanyNow } from "@/api/run-soon";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D202: GHL → here, from a workflow in the offer's GHL (trigger: Documents & Contracts, sent or signed; action: Webhook to
 * this URL, as the Setup page gives it, key included). A nudge, not a fact: what GHL posts is not read. The offer's documents
 * are read from GHL at once and what they announce (agreement.sent, agreement.signed) runs at once; the minute poll stays the backup.
 */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  if (!nudgeAuthorized(req, companyId)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  after(() => pollDocumentsNow(liveAdapters, companyId).catch((e) => console.error("ghl documents nudge:", e)).then(() => runCompanyNow(companyId)));
  return NextResponse.json({ ok: true, accepted: true });
}
