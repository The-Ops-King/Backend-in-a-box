import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { operatorAuthorized } from "@/engine/admin-auth";
import { applySalesCallPlan, backfillSalesCalls, type SalesCallDecision, type SalesCallExclusion } from "@/engine/sales-call-backfill";
import { liveAdapters } from "@/adapters";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/**
 * D115. POST { company, from?, to? | days?, closer?, dryRun = true, eodObject? } with Authorization: Bearer $CRON_SECRET: each of
 * the closer's Sales Calls in the window with the evidence for every field and "most likely … because …" for the rest. A dry run
 * writes nothing and answers a `plan_id`; POST { company, plan: <id or ids> , dryRun: false } writes exactly that plan. A pass
 * that runs out of time says `complete: false` and `resume_from`: call again with that as `from`. A dry run also takes
 * `decide: [{ slot, fields, why }]` (a person's call on what the evidence leaves open) and `exclude: [{ email, why }]`;
 * both land in the plan with their why, and a decision that names no call of the window or no option of its field is a 400.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as { company?: string; days?: number; from?: string; to?: string; closer?: string; dryRun?: boolean; plan?: string | string[]; eodObject?: string; decide?: SalesCallDecision[]; exclude?: SalesCallExclusion[] };
  if (!body.company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  const dryRun = body.dryRun !== false;
  const plans = body.plan === undefined ? [] : (Array.isArray(body.plan) ? body.plan : [body.plan]).map(String);
  if (plans.length && dryRun) return NextResponse.json({ error: "a plan is written with dryRun: false" }, { status: 400 });
  const to = body.to ? new Date(body.to) : new Date();
  const from = body.from ? new Date(body.from) : DateTime.fromJSDate(to).minus({ days: Math.min(366, Math.max(1, body.days ?? 30)) }).toJSDate();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return NextResponse.json({ error: "from and to must be times, from before to" }, { status: 400 });
  try {
    const r = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]); if (!co) throw new Error("company not found");
      const loaded = await loadCompany(c, co.id);
      if (plans.length) return applySalesCallPlan(c, loaded, liveAdapters, plans);
      // a write that also reads has less of the request left for the writes
      return backfillSalesCalls(c, loaded, liveAdapters, { from, to, closer: body.closer, dryRun, eodObject: body.eodObject, decide: body.decide, exclude: body.exclude, budgetMs: dryRun ? 240_000 : 150_000 });
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) { const m = String((e as Error).message); return NextResponse.json({ ok: false, error: m }, { status: m.startsWith("decisions:") ? 400 : 500 }); }
}
