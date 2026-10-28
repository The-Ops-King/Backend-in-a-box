import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { applicationTags } from "@/engine/application-tags";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/** D250: POST { company, forms: [Typeform form ids], why, dryRun = true }: the application and booking tags over the forms' history, in GHL and the replica (see `applicationTags`). Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; forms?: string[]; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !Array.isArray(b.forms)) return NextResponse.json({ error: "company, forms and why are required" }, { status: 400 });
  try {
    const r = await asOperator((c) => applicationTags(c, liveAdapters, { company: b.company!, forms: b.forms!, why: b.why ?? "", dryRun: b.dryRun }));
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
