import { asOperator } from "@/db/client";
import { skipStep } from "@/engine/hand";
import { fail, ok, readJson } from "@/api/http";
export const dynamic = "force-dynamic";
/** D66: a person skips the step a paused run stopped at: the step row says who, and the run goes on along its plain edge. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const body = await readJson<{ by?: string }>(req);
  return asOperator(async (c) => { const r = await skipStep(c, id, body?.by || "dashboard"); return r.ok ? ok(r) : fail(r.status, r.error); });
}
