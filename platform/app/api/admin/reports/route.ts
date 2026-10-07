import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { operatorAuthorized } from "@/engine/admin-auth";
import { companyReports, ensureSchedules, generateReport, periodFor, REPORT_KINDS, type ReportKind } from "@/engine/reports";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/** GET ?company=<slug> lists the wrap-ups; POST { company, kind, period_start?, period_end? } generates one now (the period in progress unless dates are given). Authorization: Bearer $CRON_SECRET. */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("company") ?? "";
  const out = await asOperator(async (c) => { const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); return co ? companyReports(c, co.id) : null; });
  return out ? NextResponse.json({ ok: true, reports: out }) : NextResponse.json({ error: "company not found" }, { status: 404 });
}
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as { company?: string; kind?: string; period_start?: string; period_end?: string };
  if (!body.company || !REPORT_KINDS.includes(body.kind as ReportKind)) return NextResponse.json({ error: `company and kind (${REPORT_KINDS.join("|")}) are required` }, { status: 400 });
  try {
    const r = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]); if (!co) throw new Error("company not found");
      const { row, bindings } = await loadCompany(c, co.id);
      const s = (await ensureSchedules(c, co.id)).find((x) => x.kind === body.kind)!;
      const period = body.period_start ? { start: body.period_start, end: body.period_end ?? body.period_start } : periodFor(s.kind, DateTime.now().setZone(row.timezone), true);
      return generateReport(c, row, bindings, s, period, { onDemand: true, toDate: !body.period_start });
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
