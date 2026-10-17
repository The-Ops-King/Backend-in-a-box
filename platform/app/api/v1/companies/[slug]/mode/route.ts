import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok, readJson } from "@/api/http";
import { setCompanyMode } from "@/engine/golive";
import { modeProblem, type Mode } from "@/engine/mode";
export const dynamic = "force-dynamic";
/** Move a company along the ladder ghost → test → quiet → live, or back (D52, D132). The one company-level action the dashboard keeps (D32). Up into quiet or live is refused with the blockers while readiness has any and clears the runs born below (D51). */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const body = await readJson<{ mode?: string }>(req);
  const why = modeProblem(body?.mode); if (why) return fail(400, why);
  const mode = body!.mode as Mode;
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    const r = await setCompanyMode(c, co.id, mode, `/app/c/${slug}`, "dashboard");
    if (!r.ok) return fail(409, `Not ready to go ${mode}: ${r.blockers.map((b) => b.text).join(" ")}`, { blockers: r.blockers });
    return ok({ ok: true, mode, changed: r.changed, ...(r.cleared ? { cleared: r.cleared } : {}) });
  });
}
