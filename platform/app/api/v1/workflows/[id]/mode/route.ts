import { asOperator } from "@/db/client";
import { fail, ok, readJson } from "@/api/http";
import { setWorkflowMode } from "@/engine/golive";
import { isMode } from "@/engine/mode";
export const dynamic = "force-dynamic";
/** D92: a workflow's own mode, or null to follow the company again. Live is refused with the blockers this workflow has, and clears its runs not born live (D51). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const body = await readJson<{ mode?: string | null; by?: string }>(req);
  if (!body || !("mode" in body) || (body.mode !== null && !isMode(body.mode))) return fail(400, "mode must be shadow, test, live, or null to follow the company");
  const mode = body.mode;
  return asOperator(async (c) => {
    const r = await setWorkflowMode(c, id, mode, body.by || "dashboard", "dashboard");
    return r.ok ? ok(r) : fail(r.status, r.error, r.blockers ? { blockers: r.blockers } : undefined);
  });
}
