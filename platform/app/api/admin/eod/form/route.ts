import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadEodForm, saveEodForm } from "@/engine/eod";
export const dynamic = "force-dynamic";

/**
 * D309: one offer's end-of-day form. GET ?company=<slug>: its fields (key, label, required, the answers each follows). POST
 * { company, key, required, why, dryRun = true }: whether one field must be answered, on that offer only (Tyler: "make the 'next follow
 * up' not mandatory"). The dry run says what it is now and what it becomes. Audited. Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("company");
  if (!slug) return NextResponse.json({ error: "company is required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const fields = await loadEodForm(c, co.id);
    return NextResponse.json({ ok: true, fields: fields.map((f) => ({ key: f.key, label: f.label, scope: f.scope, required: !!f.required, when: f.when ?? null })) });
  });
}

export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; key?: string; required?: boolean; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !b.key || typeof b.required !== "boolean" || !b.why?.trim()) return NextResponse.json({ error: "company, key, required (true or false) and why are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const fields = await loadEodForm(c, co.id);
    const f = fields.find((x) => x.key === b.key);
    if (!f) return NextResponse.json({ error: `no field ${b.key}; the form has ${fields.map((x) => x.key).join(", ")}` }, { status: 404 });
    if (f.key === "outcome" && !b.required) return NextResponse.json({ error: "what happened on the call is always asked" }, { status: 400 });
    const change = { key: f.key, label: f.label, was: !!f.required, now: b.required };
    if (b.dryRun !== false || change.was === change.now) return NextResponse.json({ ok: true, dryRun: b.dryRun !== false, change, unchanged: change.was === change.now });
    await saveEodForm(c, co.id, fields.map((x) => (x.key === f.key ? { ...x, required: b.required! } : x)));
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'eod.form_field','company',$2,$3,$4)", [co.id, co.id, { key: f.key, required: change.was }, { key: f.key, required: change.now, why: b.why!.trim() }]);
    return NextResponse.json({ ok: true, dryRun: false, change });
  });
}
