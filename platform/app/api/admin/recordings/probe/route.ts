import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { ghlCallMediaProbe } from "@/adapters/ghl/health";
export const dynamic = "force-dynamic"; export const maxDuration = 180;

/**
 * D276: GET ?company=<slug>&limit=5: the offer's latest connected dialer calls (60 seconds or more), each with what GHL answers for its
 * recording and its transcript. Read only. Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams, slug = q.get("company"), limit = Math.min(Math.max(Number(q.get("limit") ?? 3) || 3, 1), 5);
  if (!slug) return NextResponse.json({ error: "company is required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany: ac } = await loadCompany(c, co.id);
    const calls = await many<{ external_id: string; started_at: Date; sec: number; who: string | null; caller: string | null }>(c, `select r.external_id, r.started_at, (r.raw->>'duration_sec')::numeric::int as sec, nullif(trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')),'') as who, r.recorded_by_name as caller
      from recordings r left join contacts ct on ct.id=r.contact_id where r.company_id=$1 and r.provider='ghl' and r.raw->>'call_status'='connected' and (r.raw->>'duration_sec')::numeric >= 60 order by r.started_at desc limit $2`, [co.id, limit]);
    const out = [];
    for (const k of calls) out.push({ at: k.started_at, who: k.who, caller: k.caller, seconds: k.sec, message: k.external_id, ...(await ghlCallMediaProbe(ac.pit, ac.locationId, k.external_id).catch((e) => ({ error: String((e as Error).message).slice(0, 200) }))) });
    return NextResponse.json({ ok: true, calls: out });
  });
}
