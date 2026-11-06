import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { slackBot } from "@/engine/slack-conn";
import { formatMemberCheck, memberCheck } from "@/engine/member-check";
import { liveMemberLookups } from "@/engine/member-lookups";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * D316: read only. GET ?company=<slug>&email=<their email>[&expect=in|out]: is this person fully in (a setter or closer) or fully
 * out of the offer, read live across the engine, GHL, Calendly, Slack and Fathom (see `memberCheck`). Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url), slug = u.searchParams.get("company"), email = u.searchParams.get("email"), expect = u.searchParams.get("expect");
  if (!slug || !email?.includes("@")) return NextResponse.json({ error: "company and email are required" }, { status: 400 });
  if (expect && expect !== "in" && expect !== "out") return NextResponse.json({ error: "expect: in or out" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany: ac, bindings } = await loadCompany(c, co.id);
    const bot = await slackBot(c, co.id);
    const r = await memberCheck(c, { companyId: co.id, email, bindings, expect: (expect as "in" | "out" | null) ?? undefined, lookups: liveMemberLookups({ ac, adapters: liveAdapters, bindings, slackToken: bot?.token ?? null }) });
    return NextResponse.json({ ...r, text: formatMemberCheck(r) });
  });
}
