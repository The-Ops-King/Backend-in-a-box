import { asOperator } from "@/db/client";
import { retryStep } from "@/engine/hand";
import { fail, ok, readJson } from "@/api/http";
export const dynamic = "force-dynamic";
/** D66: a person retries the step a paused run stopped at: the attempt counter resets and the run is due now. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const body = await readJson<{ by?: string }>(req);
  return asOperator(async (c) => { const r = await retryStep(c, id, body?.by || "dashboard"); return r.ok ? ok(r) : fail(r.status, r.error); });
}
