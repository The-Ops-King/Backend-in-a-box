import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok, readJson } from "@/api/http";
import { goLive } from "@/engine/golive";
export const dynamic = "force-dynamic";
/** Go live, or back to shadow. The one company-level action the dashboard keeps (D32). Live is refused with the blockers while readiness has any; it clears every shadow-born run (D51). */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const body = await readJson<{ mode?: string }>(req);
  if (body?.mode !== "live" && body?.mode !== "shadow") return fail(400, "mode must be live or shadow");
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    if (co.mode === body.mode) return ok({ ok: true, mode: body.mode, changed: false });
    if (body.mode === "live") {
      const r = await goLive(c, co.id, `/app/c/${slug}`, "dashboard");
      if (!r.ok) return fail(409, `Not ready to go live: ${r.blockers.map((b) => b.text).join(" ")}`, { blockers: r.blockers });
      return ok({ ok: true, mode: "live", changed: true, cleared: r.cleared });
    }
    await c.query("update companies set mode='shadow' where id=$1", [co.id]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'company.mode','company',$4,$2,$3)", [co.id, { mode: co.mode }, { mode: "shadow", via: "dashboard" }, co.id]);
    return ok({ ok: true, mode: "shadow", changed: true });
  });
}
