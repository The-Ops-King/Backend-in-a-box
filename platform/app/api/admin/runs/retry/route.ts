import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { retryStep } from "@/engine/hand";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * POST { company, runs?: [ids], paused_like?: "<text in the pause reason>", dryRun = true } with Authorization: Bearer $CRON_SECRET:
 * the operator retries the step paused runs stopped at (D66's retry, the dashboard's button), e.g. every run paused because the
 * AI's credit ran out once it is topped up. Only paused runs of that company; each retry is audited by `retryStep`.
 * D215: `node` with one run: re-run that one step of it, the Retry an alert's button does for a step that could not run (the run may
 * have gone on and finished).
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; runs?: string[]; paused_like?: string; node?: string; dryRun?: boolean } | null;
  if (!b?.company || (!b.runs?.length && !b.paused_like?.trim())) return NextResponse.json({ error: "company, and runs or paused_like" }, { status: 400 });
  if (b.node && b.runs?.length !== 1) return NextResponse.json({ error: "node retries one run's step: name exactly one run" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    if (b.node) {
      const r = await one<{ id: string; status: string }>(c, "select id, status from runs where company_id=$1 and id=$2", [co.id, b.runs![0]]);
      if (!r) return NextResponse.json({ error: "no such run in this company" }, { status: 404 });
      if (b.dryRun !== false) return NextResponse.json({ ok: true, dryRun: true, run: r.id, status: r.status, node: b.node });
      return NextResponse.json({ ok: true, dryRun: false, run: r.id, ...(await retryStep(c, r.id, "operator", { node: b.node, adapters: liveAdapters })) });
    }
    const runs = await many<{ id: string; exit_reason: string | null }>(c, `select id, exit_reason from runs where company_id=$1 and status='paused' and (id = any($2::uuid[]) or ($3::text <> '' and exit_reason ilike '%' || $3 || '%'))`, [co.id, b.runs ?? [], b.paused_like?.trim() ?? ""]);
    if (b.dryRun !== false) return NextResponse.json({ ok: true, dryRun: true, runs });
    const out = [];
    for (const r of runs) out.push({ id: r.id, ...(await retryStep(c, r.id, "operator", { adapters: liveAdapters })) });
    return NextResponse.json({ ok: true, dryRun: false, runs: out });
  });
}
