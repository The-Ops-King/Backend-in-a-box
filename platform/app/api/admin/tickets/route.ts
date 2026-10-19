import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { listTickets } from "@/engine/tickets";
export const dynamic = "force-dynamic";

/** D152: GET ?company=<slug>&status=open|closed → that offer's /issue and /request tickets, newest first. Bearer $CRON_SECRET. */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url), slug = u.searchParams.get("company"), status = u.searchParams.get("status") ?? undefined;
  if (!slug) return NextResponse.json({ error: "company is required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
    if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    return NextResponse.json({ ok: true, tickets: await listTickets(c, co.id, status) });
  });
}
