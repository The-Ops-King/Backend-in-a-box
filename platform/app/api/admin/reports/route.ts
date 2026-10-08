import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { tick } from "@/engine/runner";
import { fireNow, workflowWithStep } from "@/engine/clock";
import { operatorAuthorized } from "@/engine/admin-auth";
import { companyReports, REPORT_KINDS, type ReportKind } from "@/engine/reports";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/** GET ?company=<slug> lists the wrap-ups; POST { company, kind } starts the wrap-ups workflow now for that kind (the trigger node named t_<kind>): the period in progress, posted where the workflow posts. Authorization: Bearer $CRON_SECRET. */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("company") ?? "";
  const out = await asOperator(async (c) => { const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); return co ? companyReports(c, co.id) : null; });
  return out ? NextResponse.json({ ok: true, reports: out }) : NextResponse.json({ error: "company not found" }, { status: 404 });
}
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as { company?: string; kind?: string };
  if (!body.company || !REPORT_KINDS.includes(body.kind as ReportKind)) return NextResponse.json({ error: `company and kind (${REPORT_KINDS.join("|")}) are required` }, { status: 400 });
  try {
    const fired = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]); if (!co) throw new Error("company not found");
      const wf = await workflowWithStep(c, co.id, "report"); if (!wf) throw new Error("this company has no workflow with a report step");
      if (!wf.enabled) throw new Error(`"${wf.name}" is turned off`);
      const r = await fireNow(c, co.id, wf.id, `t_${body.kind}`); if (r.why) throw new Error(r.why);
      return { companyId: co.id, workflow: wf.name, ...r };
    });
    const runs = await tick(liveAdapters, undefined, fired.companyId);
    return NextResponse.json({ ok: true, workflow: fired.workflow, runs: fired.started, ticked: runs });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
