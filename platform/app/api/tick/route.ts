import { NextResponse } from "next/server";
import { liveAdapters } from "@/adapters";
import { tickAuthorized } from "@/engine/admin-auth";
import { tickCompany, tickEngine, tickEveryone } from "@/engine/ticks";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The minute tick, Authorization: Bearer $CRON_SECRET (or, while the key is being changed, $CRON_SECRET_PREVIOUS). D98:
 * `?company=<id>` is one company's minute under its own lease (poll it, start what its clock says is due, run its due runs,
 * its alerts); `?scope=engine` is the engine's own minute (heartbeat, its alerts, which companies have stopped ticking,
 * retention). The database scheduler fires one of each per company plus the engine every minute, all at once. No
 * parameters (the daily sweep `?mode=sweep`, a hand call, a scheduler installed before D98): every company in turn, then the engine.
 */
export async function GET(req: Request) {
  if (!tickAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  const q = new URL(req.url).searchParams;
  const mode = q.get("mode") ?? "tick";   // "sweep" = Vercel daily cron; "tick" = the minute scheduler
  const company = q.get("company"), scope = q.get("scope");
  try {
    if (company) {
      if (!UUID.test(company)) return NextResponse.json({ ok: false, error: "company must be a company id (uuid)" }, { status: 400 });
      return NextResponse.json({ ok: true, mode, scope: "company", ...(await tickCompany(liveAdapters, company)) });
    }
    if (scope === "engine") return NextResponse.json({ ok: true, mode, scope: "engine", ...(await tickEngine(liveAdapters)) });
    if (scope) return NextResponse.json({ ok: false, error: `unknown scope: ${scope}` }, { status: 400 });
    const all = await tickEveryone(liveAdapters);
    return NextResponse.json({ ok: true, mode, scope: "all", ms: Date.now() - started, ...all });
  } catch (e) { return NextResponse.json({ ok: false, mode, error: String((e as Error).message).slice(0, 300), ms: Date.now() - started }, { status: 500 }); }
}
