import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { checkQuery, runQuery } from "@/engine/query";
export const dynamic = "force-dynamic"; export const maxDuration = 30;

/** POST { company, sql, limit? } → { columns, rows, row_count, ms, truncated }. One SELECT, the company's rows only, read-only, 5 s. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string; sql?: string; limit?: number } | null;
  if (!body?.company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  const q = checkQuery(body.sql, body.limit);
  if (!q.ok) return NextResponse.json({ error: q.error }, { status: 400 });
  const co = await asOperator((c) => one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]));
  if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
  try { return NextResponse.json({ ok: true, ...(await runQuery(co.id, q)) }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 400 }); }
}
