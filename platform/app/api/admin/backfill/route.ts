import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { operatorAuthorized } from "@/engine/admin-auth";
import { backfillCompany } from "@/engine/backfill";
import { liveAdapters } from "@/adapters";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/** POST { company, days? | from?, to? } with Authorization: Bearer $CRON_SECRET: pulls history into the ledger (rows only, no events) and rolls the days up. Safe to re-run. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as { company?: string; days?: number; from?: string; to?: string };
  if (!body.company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  const to = body.to ? new Date(body.to) : new Date();
  const from = body.from ? new Date(body.from) : DateTime.fromJSDate(to).minus({ days: Math.min(366, Math.max(1, body.days ?? 30)) }).toJSDate();
  try {
    const r = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]); if (!co) throw new Error("company not found");
      const { row, adapterCompany, bindings } = await loadCompany(c, co.id);
      return backfillCompany(c, row, adapterCompany, liveAdapters, bindings, { from, to });
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
