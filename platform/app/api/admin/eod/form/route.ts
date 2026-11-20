import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadEodForm, saveEodForm } from "@/engine/eod";
import type { CallOutcome, EodField, FieldType } from "@/engine/eod-form";
export const dynamic = "force-dynamic";

/**
 * D309: one offer's end-of-day form. GET ?company=<slug>: its fields (key, label, required, the answers each follows). POST
 * { company, key, required, why, dryRun = true }: whether one field must be answered, on that offer only (Tyler: "make the 'next follow
 * up' not mandatory"). The dry run says what it is now and what it becomes. Audited. Authorization: Bearer $CRON_SECRET.
 * D358: POST { company, add: { key, label, type, options?, required, follows?: [meanings] }, why, dryRun = true }: one question of the
 * offer's own added to its form (TRC's "Which package?"). `follows` names what an answer means (closed, deposit, pending, follow_up,
 * lost, unqualified): it is asked after each of the offer's answers that means one of them; absent, after any answer. A key the form
 * already has is refused.
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

type Add = { key?: string; label?: string; type?: FieldType; options?: string[]; required?: boolean; follows?: string[] };
const TYPES: FieldType[] = ["select", "text", "textarea", "money", "number", "date"];

export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; key?: string; required?: boolean; why?: string; dryRun?: boolean; add?: Add } | null;
  if (b?.add) return addField(b as { company?: string; why?: string; dryRun?: boolean; add: Add });
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

async function addField(b: { company?: string; why?: string; dryRun?: boolean; add: Add }) {
  const a = b.add, key = (a.key ?? "").trim();
  if (!b.company || !b.why?.trim() || !/^[a-z][a-z0-9_]*$/.test(key) || !a.label?.trim() || !a.type || !TYPES.includes(a.type) || typeof a.required !== "boolean")
    return NextResponse.json({ error: "company, why and add { key (a_z), label, type, required } are required" }, { status: 400 });
  if (a.type === "select" && !(a.options ?? []).filter((o) => o.trim()).length) return NextResponse.json({ error: "a select needs its options" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const fields = await loadEodForm(c, co.id);
    if (fields.some((f) => f.key === key)) return NextResponse.json({ error: `the form already has ${key}` }, { status: 400 });
    const choices = fields.find((f) => f.key === "outcome")?.choices ?? [];
    const when = a.follows?.length ? choices.filter((o) => (o.call_outcome && a.follows!.includes(o.call_outcome)) || a.follows!.includes(o.attendance)).map((o) => o.value as CallOutcome) : undefined;
    if (a.follows?.length && !when?.length) return NextResponse.json({ error: `none of the offer's answers means ${a.follows.join(", ")}` }, { status: 400 });
    const field: EodField = { key, label: a.label!.trim(), type: a.type!, scope: "call", required: a.required!, ...(when ? { when } : {}), ...(a.type === "select" ? { options: a.options!.map((o) => o.trim()).filter(Boolean) } : {}) };
    if (b.dryRun !== false) return NextResponse.json({ ok: true, dryRun: true, add: field });
    await saveEodForm(c, co.id, [...fields, field]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'eod.form_field','company',$2,null,$3)", [co.id, co.id, { add: field, why: b.why!.trim() }]);
    return NextResponse.json({ ok: true, dryRun: false, add: field });
  });
}
