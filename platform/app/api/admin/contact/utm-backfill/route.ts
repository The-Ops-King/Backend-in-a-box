import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { utmBackfill } from "@/engine/utm-backfill";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/** D281: POST { company, forms: [Typeform form ids], why, sourceNames?: { <utm_source>: <lead source> }, skip?: [GHL ids], dryRun = true }: each person's first UTMs from the forms' history into the offer's empty UTM and lead-source fields (see `utmBackfill`). Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; forms?: string[]; why?: string; dryRun?: boolean; sourceNames?: Record<string, string>; answers?: Record<string, string>; skip?: string[] } | null;
  if (!b?.company || !Array.isArray(b.forms)) return NextResponse.json({ error: "company, forms and why are required" }, { status: 400 });
  try {
    const r = await asOperator((c) => utmBackfill(c, liveAdapters, { company: b.company!, forms: b.forms!, why: b.why ?? "", dryRun: b.dryRun, sourceNames: b.sourceNames && typeof b.sourceNames === "object" ? b.sourceNames : undefined, answers: b.answers && typeof b.answers === "object" ? b.answers : undefined, skip: Array.isArray(b.skip) ? b.skip : undefined }));
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
