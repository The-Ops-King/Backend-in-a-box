import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { decrypt } from "@/engine/crypto";
import { changeTeam, teamOf } from "@/engine/team";
import { liveAdapters } from "@/adapters";
export const dynamic = "force-dynamic";

/**
 * D197: an offer's team.
 * GET  ?company=<slug> → everyone on its roster with their role and whether their Slack is linked
 * POST { company, email, role: "setter" | "closer", slack?: <their Slack email or id>, by? } → adds them (re-reading the GHL roster
 *      when they are new there); POST { company, email, remove: true } → takes the role off. Audited.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("company"); if (!slug) return NextResponse.json({ error: "company is required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    return NextResponse.json({ ok: true, team: await teamOf(c, co.id) });
  });
}
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; email?: string; role?: "setter" | "closer"; remove?: boolean; slack?: string; by?: string } | null;
  if (!b?.company || !b.email) return NextResponse.json({ error: "company and email are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany } = await loadCompany(c, co.id);
    const conn = await one<{ bot_token: Buffer }>(c, "select bot_token from slack_connections where company_id=$1", [co.id]);
    const r = await changeTeam(c, { companyId: co.id, ac: adapterCompany, adapters: liveAdapters, slackToken: conn ? decrypt(conn.bot_token) : null, change: { email: b.email!, role: b.role, remove: b.remove === true, slack: b.slack, by: b.by } });
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.why }, { status: r.status });
  });
}
