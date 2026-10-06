import { NextResponse } from "next/server";
import { db } from "@/db/client";
export const dynamic = "force-dynamic";
export async function GET() {
  try { const r = await db().query("select now() as now, (select count(*) from companies) as companies"); return NextResponse.json({ ok: true, ...r.rows[0] }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
