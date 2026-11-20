import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { ghl } from "@/adapters/ghl/client";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

type Field = { id?: string; _id?: string; fieldKey: string; name?: string; dataType?: string; options?: { key: string; label?: string; url?: string }[] };

/**
 * D356: POST { company, object: <custom object key>, field: <field key>, key, label, why, dryRun = true }: one option added to a
 * dropdown field on a custom object (a new closer on the Sales Call Closer field, so their Sales Calls name them). Every option already
 * there is sent back as it is (GHL's update replaces the list); one with that key already: nothing changes. Read back. Audited.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; object?: string; field?: string; key?: string; label?: string; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !b.object || !b.field || !b.key?.trim() || !b.label?.trim() || !b.why?.trim()) return NextResponse.json({ error: "company, object, field, key, label and why are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany: ac } = await loadCompany(c, co.id);
    const read = async () => (await ghl<{ fields?: Field[] }>(ac.pit, "GET", `/objects/${encodeURIComponent(b.object!)}?locationId=${ac.locationId}&fetchProperties=true`)).fields ?? [];
    const want = (f: Field) => f.fieldKey === b.field || f.fieldKey.endsWith(`.${b.field}`);
    const f = (await read()).find(want);
    if (!f) return NextResponse.json({ error: `no field ${b.field} on ${b.object}` }, { status: 404 });
    const id = f.id ?? f._id;
    if (!/OPTIONS|RADIO|CHECKBOX/i.test(f.dataType ?? "")) return NextResponse.json({ error: `${f.fieldKey} is ${f.dataType}, not a dropdown` }, { status: 400 });
    const options = f.options ?? [];
    const view = { field: f.fieldKey, name: f.name, id, was: options.map((o) => `${o.key} (${o.label ?? o.key})`) };
    if (options.some((o) => o.key === b.key!.trim())) return NextResponse.json({ ok: true, dryRun: b.dryRun !== false, ...view, note: "an option with that key is already there" });
    if (!id) return NextResponse.json({ error: "GHL gave no id for this field" }, { status: 502 });
    const next = [...options.map((o) => ({ key: o.key, label: o.label ?? o.key, ...(o.url ? { url: o.url } : {}) })), { key: b.key!.trim(), label: b.label!.trim() }];
    if (b.dryRun !== false) return NextResponse.json({ ok: true, dryRun: true, ...view, adding: `${b.key} (${b.label})` });
    await ghl(ac.pit, "PUT", `/custom-fields/${encodeURIComponent(id)}`, { body: { locationId: ac.locationId, options: next } });
    const after = (await read()).find(want);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'ghl.field_option_added','custom_field',$2,$3)", [co.id, id, { object: b.object, field: f.fieldKey, key: b.key, label: b.label, why: b.why }]);
    return NextResponse.json({ ok: true, dryRun: false, ...view, now: (after?.options ?? []).map((o) => `${o.key} (${o.label ?? o.key})`) });
  });
}
