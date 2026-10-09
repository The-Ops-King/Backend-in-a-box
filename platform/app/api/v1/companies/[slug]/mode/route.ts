import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok, readJson } from "@/api/http";
import { goLive } from "@/engine/golive";
import { isMode } from "@/engine/mode";
export const dynamic = "force-dynamic";
/** Move a company along the ladder shadow → test → live, or back (D52). The one company-level action the dashboard keeps (D32). Live is refused with the blockers while readiness has any and clears every run not born live (D51). */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const body = await readJson<{ mode?: string }>(req);
  if (!isMode(body?.mode)) return fail(400, "mode must be shadow, test or live");
  const mode = body.mode;
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    if (co.mode === mode) return ok({ ok: true, mode, changed: false });
    if (mode === "live") {
      const r = await goLive(c, co.id, `/app/c/${slug}`, "dashboard");
      if (!r.ok) return fail(409, `Not ready to go live: ${r.blockers.map((b) => b.text).join(" ")}`, { blockers: r.blockers });
      return ok({ ok: true, mode, changed: true, cleared: r.cleared });
    }
    await c.query("update companies set mode=$2 where id=$1", [co.id, mode]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'company.mode','company',$4,$2,$3)", [co.id, { mode: co.mode }, { mode, via: "dashboard" }, co.id]);
    return ok({ ok: true, mode, changed: true });
  });
}
