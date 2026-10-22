import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { rematchRecordings } from "@/engine/recordings";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/**
 * D215. POST { company, from?, to? | days?, dryRun = true } with Authorization: Bearer $CRON_SECRET: the company's unlinked recordings in
 * the window run through the match ladder again. A dry run answers what would link and what stays; the write links them silently (no
 * event, no run, as the history backfill does) and keeps each one still unlinked with its reason now. Audited.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as { company?: string; days?: number; from?: string; to?: string; dryRun?: boolean };
  if (!body.company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  const to = body.to ? new Date(body.to) : new Date();
  const from = body.from ? new Date(body.from) : DateTime.fromJSDate(to).minus({ days: Math.min(366, Math.max(1, body.days ?? 30)) }).toJSDate();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return NextResponse.json({ error: "from and to must be times, from before to" }, { status: 400 });
  const dryRun = body.dryRun !== false;
  try {
    const r = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]); if (!co) throw new Error("company not found");
      return rematchRecordings(c, co.id, { from, to, dryRun });
    });
    return NextResponse.json({ ok: true, dryRun, from: from.toISOString(), to: to.toISOString(), ...r });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
