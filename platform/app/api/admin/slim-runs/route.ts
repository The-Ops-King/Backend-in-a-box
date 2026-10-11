import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { slimRunContexts } from "@/engine/retention";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/** POST { dryRun?, company?, batchSize?, after? } with Authorization: Bearer $CRON_SECRET: D84, once. Rewrites every run's saved context to what a run keeps.
 *  A dry run unless `dryRun: false` is sent: it reports the rows and bytes that would change. Idempotent; when `done` is false, call again with `after: next`. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean; company?: string; batchSize?: number; after?: string };
  try {
    const co = body.company ? await asOperator((c) => one<{ id: string }>(c, "select id from companies where slug=$1", [body.company])) : undefined;
    if (body.company && !co) return NextResponse.json({ error: "company not found" }, { status: 404 });
    const r = await slimRunContexts({ dryRun: body.dryRun !== false, companyId: co?.id, batchSize: body.batchSize, after: body.after ?? null, budgetMs: 240_000 });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
