import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { clearReplyTexts } from "@/engine/retention";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/** POST { dryRun?, company? } with Authorization: Bearer $CRON_SECRET: D89, once. Takes the words of people's replies out of what the engine kept
 *  (inbound messages, runs' saved replies, events, step results), leaving "it came in" and Jev's read. A dry run unless `dryRun: false` is sent:
 *  it reports the rows each part would change. Safe to re-run; a second real run changes nothing. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean; company?: string };
  try {
    const co = body.company ? await asOperator((c) => one<{ id: string }>(c, "select id from companies where slug=$1", [body.company])) : undefined;
    if (body.company && !co) return NextResponse.json({ error: "company not found" }, { status: 404 });
    const r = await clearReplyTexts({ dryRun: body.dryRun !== false, companyId: co?.id });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
