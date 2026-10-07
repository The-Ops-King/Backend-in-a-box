import { NextResponse } from "next/server";
import { operatorAuthorized } from "@/engine/admin-auth";
import { installTickSchedule, removeTickSchedule, tickScheduleStatus, installWatchdog, removeWatchdog } from "@/engine/schedule";
export const dynamic = "force-dynamic";

/** GET: is the in-database minute scheduler installed, and what did its last runs do. Bearer $CRON_SECRET. */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try { return NextResponse.json({ ok: true, ...(await tickScheduleStatus()) }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}

/** POST {url?, everyMinutes?, alertUrl?}: install or replace the pg_cron job that calls this deployment's /api/tick (host of this request, every minute), and the in-database watchdog when an alert URL is given (body or OPERATOR_WEBHOOK_URL). */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { url?: string; everyMinutes?: number; alertUrl?: string };
  const host = req.headers.get("x-forwarded-host") ?? new URL(req.url).host;
  const url = body.url ?? `https://${host}`;
  try {
    const r = await installTickSchedule(url, process.env.CRON_SECRET!, body.everyMinutes ?? 1);
    const alertUrl = body.alertUrl ?? process.env.OPERATOR_WEBHOOK_URL;
    const watchdog = alertUrl ? await installWatchdog(alertUrl) : null;
    return NextResponse.json({ ok: true, url, ...r, watchdogInstalled: !!watchdog, ...(alertUrl ? {} : { note: "no alert URL: watchdog not installed (set OPERATOR_WEBHOOK_URL or pass alertUrl)" }), ...(await tickScheduleStatus()) });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}

export async function DELETE(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try { return NextResponse.json({ ok: true, removed: await removeTickSchedule(), watchdogRemoved: await removeWatchdog() }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
