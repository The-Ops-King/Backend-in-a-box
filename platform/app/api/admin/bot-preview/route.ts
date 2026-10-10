import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { preview } from "@/engine/bot";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/** POST { company, command?: "/mtd", text?: "last month", question?: "…" } → { kind, text }: the bot's answer as Slack would get it, nothing posted. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string; command?: string; text?: string; question?: string } | null;
  if (!body?.company || (!body.command && !body.question)) return NextResponse.json({ error: "company and a command or question are required" }, { status: 400 });
  const co = await asOperator((c) => one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]));
  if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
  try { return NextResponse.json({ ok: true, ...(await preview({ adapters: liveAdapters }, co.id, body)) }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
