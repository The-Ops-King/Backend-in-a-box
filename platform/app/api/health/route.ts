import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { companyTicks, STALE_AFTER_MIN } from "@/engine/ticks";
export const dynamic = "force-dynamic";
/** Health plus which of OUR env variable NAMES are present (never values) — tells us whether shared vars reached the function. */
/**
 * `?assert=fresh` answers 503 when the engine's last tick is older than five minutes, or (D98) when any active company's own
 * last tick is, so an outside uptime monitor can page the operator when the scheduler, or one client's ticks, have stopped.
 * `ticks`: each company's last own tick, how long it took and where the time went (each poll read, schedules, runs, alerts).
 */
export async function GET(req: Request) {
  const assertFresh = new URL(req.url).searchParams.get("assert") === "fresh";
  const names = Object.keys(process.env).filter((k) => /^(DATABASE_URL|SUPABASE_|GHL_|TICK_URL|CRON_SECRET|BINDINGS_KEY|JEV_)/.test(k)).sort();
  const dbConfigured = !!(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL);
  if (!dbConfigured) return NextResponse.json({ ok: false, db: "not configured", env: names }, { status: 503 });
  try {
    const r = await db().query("select now() as now, (select count(*) from companies) as companies, (select value->>'last_tick' from engine_state where key='scheduler') as last_tick, (select value from engine_state where key='problems') as problems");
    const row = r.rows[0] as { now: Date; companies: string; last_tick: string | null; problems: { at: string; problems: unknown[] } | null };
    const ageMin = row.last_tick ? (Date.now() - new Date(row.last_tick).getTime()) / 60e3 : Infinity;
    const stale = ageMin > STALE_AFTER_MIN;
    const client = await db().connect();
    const per = await companyTicks(client).finally(() => client.release());
    const companies_stale = per.filter((t) => t.stale).map((t) => ({ slug: t.slug, minutes_since_tick: Math.round(t.minutes) }));
    const ticks = per.map((t) => ({ slug: t.slug, last_tick: t.last_tick, minutes_since_tick: t.minutes, ms: t.ms, ...t.timings, errors: t.errors.length }));
    if (assertFresh && (stale || companies_stale.length)) return NextResponse.json({ ok: false, stale, last_tick: row.last_tick, minutes_since_tick: Number.isFinite(ageMin) ? Math.round(ageMin) : null, companies_stale, env: names }, { status: 503 });
    return NextResponse.json({ ok: true, now: row.now, companies: row.companies, last_tick: row.last_tick, minutes_since_tick: Number.isFinite(ageMin) ? Math.round(ageMin * 10) / 10 : null, stale, companies_stale, ticks, problems: row.problems?.problems?.length ?? 0, env: names });
  }
  catch (e) { return NextResponse.json({ ok: false, db: String((e as Error).message).slice(0, 200), env: names }, { status: 500 }); }
}
