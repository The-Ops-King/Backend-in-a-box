import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { checkRecordings } from "@/engine/recording-relink";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/**
 * D226: POST { company, from?, to? | days? }: read only. Every recording in the window held to the matching rules as they are now;
 * the answer lists each one whose link the rules would not make, with what the rules say and why. Nothing changes: each is fixed by
 * name with /api/admin/recordings/relink. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; days?: number; from?: string; to?: string } | null;
  if (!b?.company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  const to = b.to ? new Date(b.to) : new Date();
  const from = b.from ? new Date(b.from) : new Date(to.getTime() - Math.min(90, Math.max(1, b.days ?? 14)) * 864e5);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return NextResponse.json({ error: "from and to must be times, from before to" }, { status: 400 });
  try {
    const r = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) throw new Error("company not found");
      return checkRecordings(c, liveAdapters, co.id, from, to);
    });
    return NextResponse.json({ ok: true, from: from.toISOString(), to: to.toISOString(), ...r });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
