import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { liveAdapters } from "@/adapters";
import { sweepCompany } from "@/engine/health";
import { announceDue, openAlerts } from "@/engine/alerts";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * GET  ?company=<slug>  → the company's open alerts
 * POST { company }      → sweep now (every enabled check), announce what is new, return the findings
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
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]);
    if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const s = await sweepCompany(c, co.id, liveAdapters);
    const a = await announceDue(c, liveAdapters);
    return NextResponse.json({ ok: true, company: body.company, raised: s.raised, resolved: s.resolved, posted: a.posted, closed: a.resolved, findings: s.findings });
  });
}
