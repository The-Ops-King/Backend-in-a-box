import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * D232: read only. GET ?company=<slug>&object=<binding or object key>&q=<text>: the object's records as GHL has them now (a record's
 * id, when it was made, its fields), only those with `q` in any field when given, and whether the engine knows each one (its key).
 * Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url), company = u.searchParams.get("company"), obj = u.searchParams.get("object"), q = (u.searchParams.get("q") ?? "").trim().toLowerCase();
  if (!company || !obj) return NextResponse.json({ error: "company and object are required" }, { status: 400 });
  try {
    const out = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [company]); if (!co) throw new Error("company not found");
      const { adapterCompany, bindings } = await loadCompany(c, co.id);
      const object = bindings[obj] || obj;
      const recs = (await liveAdapters.read.objectRecords(adapterCompany, object)).filter((r) => !q || JSON.stringify(r.properties).toLowerCase().includes(q));
      const ours = new Map((await c.query<{ ghl_record_id: string; record_key: string }>("select ghl_record_id, record_key from crm_records where company_id=$1 and object_key=$2", [co.id, object])).rows.map((r) => [r.ghl_record_id, r.record_key]));
      return { object, count: recs.length, records: recs.map((r) => ({ id: r.id, createdAt: r.createdAt, engine_key: ours.get(r.id) ?? null, properties: r.properties })) };
    });
    return NextResponse.json({ ok: true, ...out });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
