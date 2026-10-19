import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { pauseAlert } from "@/engine/alerts";
export const dynamic = "force-dynamic";

/** D150: POST { company, id | key, by, pause? } with Authorization: Bearer $CRON_SECRET: an open alert stops reminding (pause:
 *  false lets it remind again). It stays open and checked, and still closes with its ✅ once the cause is gone. Audited. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { company?: string; id?: string; key?: string; by?: string; pause?: boolean };
  if (!body.company || !(body.id || body.key) || !body.by?.trim()) return NextResponse.json({ error: "company, id or key, and by are required" }, { status: 400 });
  return NextResponse.json(await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]);
    if (!co) return { ok: false, error: "company not found" };
    const a = await one<{ id: string; key: string; text: string }>(c, "select id, key, text from alerts where company_id=$1 and resolved_at is null and (id::text=$2 or key=$3)", [co.id, body.id ?? "", body.key ?? ""]);
    if (!a) return { ok: false, error: "no open alert with that id or key" };
    const changed = await pauseAlert(c, co.id, a, body.by!.trim(), body.pause !== false);
    return { ok: true, key: a.key, paused: body.pause !== false, changed };
  }));
}
