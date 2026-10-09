import { asOperator, one } from "@/db/client";
import { companyReadiness } from "@/engine/readiness";
import { fail, ok, readJson } from "@/api/http";
export const dynamic = "force-dynamic";
/** The switch. Turning ON a workflow with a missing required binding is refused, as the admin endpoint refuses it. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const body = await readJson<{ enabled?: boolean }>(req);
  if (typeof body?.enabled !== "boolean") return fail(400, "enabled must be true or false");
  return asOperator(async (c) => {
    const w = await one<{ enabled: boolean; company_id: string; name: string; slug: string }>(c, "select w.enabled, w.company_id, w.name, co.slug from workflows w join companies co on co.id=w.company_id where w.id=$1", [id]);
    if (!w) return fail(404, "no such workflow");
    if (body.enabled) { const r = await companyReadiness(c, w.company_id, `/app/c/${w.slug}`); const mine = r.workflows.find((x) => x.id === id); if (mine?.missing.length) return fail(409, `Cannot turn on: missing ${mine.missing.join(", ")}`, { missing: mine.missing }); if (mine?.parseError) return fail(409, `Cannot turn on: ${mine.parseError}`); }
    if (w.enabled !== body.enabled) {
      await c.query("update workflows set enabled=$2 where id=$1", [id, body.enabled]);
      await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,$2,'workflow',$3,$4,$5)", [w.company_id, body.enabled ? "workflow.enabled" : "workflow.disabled", id, { enabled: w.enabled }, { enabled: body.enabled, via: "dashboard" }]);
    }
    return ok({ ok: true, enabled: body.enabled });
  });
}
