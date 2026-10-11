import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { resolve } from "@/engine/alerts";
export const dynamic = "force-dynamic";

/** POST { company, id | key, why } with Authorization: Bearer $CRON_SECRET: close an alert whose cause was fixed. Health check posts
 *  the ✅ in its thread like any resolve; `why` is kept in the audit log so the dashboard shows what fixed it. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { company?: string; id?: string; key?: string; why?: string };
  if (!body.company || !(body.id || body.key) || !body.why?.trim()) return NextResponse.json({ error: "company, id or key, and why are required" }, { status: 400 });
  return NextResponse.json(await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]);
    if (!co) return { ok: false, error: "company not found" };
    const a = await one<{ id: string; key: string; text: string }>(c, "select id, key, text from alerts where company_id=$1 and resolved_at is null and (id::text=$2 or key=$3)", [co.id, body.id ?? "", body.key ?? ""]);
    if (!a) return { ok: false, error: "no open alert with that id or key" };
    await resolve(c, co.id, a.key);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'alert.resolved_by_operator','alert',$2,$3,$4)", [co.id, a.id, JSON.stringify({ text: a.text }), JSON.stringify({ why: body.why!.trim() })]);
    return { ok: true, resolved: a.key };
  }));
}
