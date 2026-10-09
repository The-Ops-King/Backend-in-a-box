import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok, readJson } from "@/api/http";
export const dynamic = "force-dynamic";
/** Go live, or back to shadow. The one company-level action the dashboard keeps (D32). */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const body = await readJson<{ mode?: string }>(req);
  if (body?.mode !== "live" && body?.mode !== "shadow") return fail(400, "mode must be live or shadow");
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    if (co.mode !== body.mode) {
      await c.query("update companies set mode=$2 where id=$1", [co.id, body.mode]);
      await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'company.mode','company',$1,$2,$3)", [co.id, { mode: co.mode }, { mode: body.mode, via: "dashboard" }]);
    }
    return ok({ ok: true, mode: body.mode });
  });
}
