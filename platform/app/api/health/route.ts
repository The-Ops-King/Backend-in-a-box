import { NextResponse } from "next/server";
import { db } from "@/db/client";
export const dynamic = "force-dynamic";
/** Health plus which of OUR env variable NAMES are present (never values) — tells us whether shared vars reached the function. */
export async function GET() {
  const names = Object.keys(process.env).filter((k) => /^(DATABASE_URL|SUPABASE_|GHL_|TICK_URL|CRON_SECRET|BINDINGS_KEY|JEV_)/.test(k)).sort();
  const dbConfigured = !!(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL);
  if (!dbConfigured) return NextResponse.json({ ok: false, db: "not configured", env: names }, { status: 503 });
  try { const r = await db().query("select now() as now, (select count(*) from companies) as companies"); return NextResponse.json({ ok: true, ...r.rows[0], env: names }); }
  catch (e) { return NextResponse.json({ ok: false, db: String((e as Error).message).slice(0, 200), env: names }, { status: 500 }); }
}
