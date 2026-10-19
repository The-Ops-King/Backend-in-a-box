import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { readGhl, setupGhl } from "@/engine/ghl-setup";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * D149: one offer's GHL, with the token the engine holds.
 * GET  ?company=<slug> → { location, pipelines (stages in order), objects (custom objects, their fields and options), settings (crm.*, sales_call.*) }
 * POST { company, setup, apply? } → the additive setup's plan; with apply: true it makes what is missing (never deletes; a PUT
 *      only to the pipeline or field the setup names). `setup` names only what it is about: `pipelines` and `objects` as in
 *      installs/dating/ghl-setup.json, everything else optional. Dry run first, always; apply only on Tyler's word.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("company");
  if (!slug) return NextResponse.json({ error: "company is required" }, { status: 400 });
  try { const r = await asOperator((c) => readGhl(c, slug)); return r ? NextResponse.json({ ok: true, ...r }) : NextResponse.json({ error: "no such company" }, { status: 404 }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 502 }); }
}
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string; setup?: Record<string, unknown>; apply?: boolean } | null;
  if (!body?.company || !body.setup || typeof body.setup !== "object") return NextResponse.json({ error: "company and setup are required" }, { status: 400 });
  try {
    const r = await asOperator(async (c) => {
      const out = await setupGhl(c, body.company!, body.setup!, body.apply === true);
      if (out && out.writes.length) await c.query("insert into audit_log (company_id, action, target_type, target_id, after) select id, 'ghl.setup_applied', 'company', id::text, $2 from companies where slug=$1", [body.company, { writes: out.writes, summary: out.after }]);
      return out;
    });
    return r ? NextResponse.json({ ok: true, ...r }) : NextResponse.json({ error: "no such company" }, { status: 404 });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 502 }); }
}
