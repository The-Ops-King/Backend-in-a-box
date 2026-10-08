import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { liveAdapters } from "@/adapters";
import { tick } from "@/engine/runner";
import { fireNow, workflowWithStep } from "@/engine/clock";
import { announceDue, openAlerts } from "@/engine/alerts";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * GET  ?company=<slug>  → the company's open alerts
 * POST { company }      → start the company's health workflow now (the one with a health_check step), run it, announce what is new
 * Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("company");
  return asOperator(async (c) => {
    const co = slug ? await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]) : null;
    if (slug && !co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    return NextResponse.json({ ok: true, open: await openAlerts(c, co?.id) });
  });
}
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string } | null;
  if (!body?.company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  const fired = await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]); if (!co) return { error: "no such company" };
    const wf = await workflowWithStep(c, co.id, "health_check"); if (!wf) return { error: "this company has no workflow with a health_check step" };
    if (!wf.enabled) return { error: `"${wf.name}" is turned off` };
    return { companyId: co.id, workflow: wf.name, ...(await fireNow(c, co.id, wf.id)) };
  });
  if ("error" in fired) return NextResponse.json(fired, { status: 404 });
  const runs = await tick(liveAdapters, undefined, fired.companyId);
  const a = await asOperator((c) => announceDue(c, liveAdapters));
  const findings = await asOperator((c) => one<{ last_result: unknown }>(c, "select last_result from health_checks where company_id=$1", [fired.companyId]));
  return NextResponse.json({ ok: true, company: body.company, workflow: fired.workflow, runs: fired.started, ticked: runs, posted: a.posted, closed: a.resolved, findings: findings?.last_result ?? [] });
}
