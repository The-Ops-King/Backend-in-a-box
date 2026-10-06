import { NextResponse } from "next/server";
import { operatorAuthorized } from "@/engine/admin-auth";
import { installTickSchedule, removeTickSchedule, tickScheduleStatus } from "@/engine/schedule";
export const dynamic = "force-dynamic";

/** GET: is the in-database minute scheduler installed, and what did its last runs do. Bearer $CRON_SECRET. */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try { return NextResponse.json({ ok: true, ...(await tickScheduleStatus()) }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}

/** POST {url?, everyMinutes?}: install or replace the pg_cron job that calls this deployment's /api/tick. Defaults to the host this request came in on, every minute. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { url?: string; everyMinutes?: number };
  const host = req.headers.get("x-forwarded-host") ?? new URL(req.url).host;
  const url = body.url ?? `https://${host}`;
  try {
    const r = await installTickSchedule(url, process.env.CRON_SECRET!, body.everyMinutes ?? 1);
    return NextResponse.json({ ok: true, url, ...r, ...(await tickScheduleStatus()) });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}

export async function DELETE(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try { return NextResponse.json({ ok: true, removed: await removeTickSchedule() }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
