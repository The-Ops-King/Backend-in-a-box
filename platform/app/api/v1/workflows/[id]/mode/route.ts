import { asOperator } from "@/db/client";
import { fail, ok, readJson } from "@/api/http";
import { setWorkflowMode } from "@/engine/golive";
import { modeProblem } from "@/engine/mode";
export const dynamic = "force-dynamic";
/** D92: a workflow's own mode, or null to follow the company again. Live is refused with the blockers this workflow has, and clears its runs not born live (D51). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const body = await readJson<{ mode?: string | null; by?: string }>(req);
  if (!body || !("mode" in body)) return fail(400, "mode is required: a rung, or null to follow the company");
  const why = body.mode === null ? null : modeProblem(body.mode); if (why) return fail(400, `${why}, or null to follow the company`);
  const mode = body.mode as import("@/engine/mode").Mode | null;
  return asOperator(async (c) => {
    const r = await setWorkflowMode(c, id, mode, body.by || "dashboard", "dashboard");
    return r.ok ? ok(r) : fail(r.status, r.error, r.blockers ? { blockers: r.blockers } : undefined);
  });
}
