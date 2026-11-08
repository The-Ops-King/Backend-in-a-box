import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { ghlCustomField, ghlRenameCustomField } from "@/adapters/ghl/catalog";
export const dynamic = "force-dynamic";

/**
 * D323: POST { company, field: <a field setting such as crm.field_contact_revenue_generated, or a GHL field id>, name, why, dryRun = true }:
 * one of the offer's GHL custom fields renamed. Only its name changes: its id and key stay, so every step that writes it goes on
 * working. The dry run reads the field as GHL has it. Audited. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; field?: string; name?: string; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !b.field || !b.name?.trim() || !b.why?.trim()) return NextResponse.json({ error: "company, field, name and why are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany: ac, bindings } = await loadCompany(c, co.id);
    const id = b.field!.startsWith("crm.") ? bindings[b.field!] : b.field!;
    if (!id) return NextResponse.json({ error: `${b.field} is not set on this offer` }, { status: 400 });
    try {
      const f = await ghlCustomField(ac.pit, ac.locationId, id);
      if (!f) return NextResponse.json({ error: `GHL has no field ${id}` }, { status: 404 });
      const change = { id: f.id, key: f.fieldKey ?? null, was: f.name, now: b.name!.trim() };
      if (b.dryRun !== false || f.name === change.now) return NextResponse.json({ ok: true, dryRun: b.dryRun !== false, change, unchanged: f.name === change.now });
      await ghlRenameCustomField(ac.pit, ac.locationId, f.id, change.now);
      await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'ghl.field_renamed','field',$2,$3,$4)", [co.id, f.id, { name: f.name }, { name: change.now, why: b.why!.trim() }]);
      return NextResponse.json({ ok: true, dryRun: false, change });
    } catch (e) { return NextResponse.json({ error: String((e as Error).message).slice(0, 300) }, { status: 502 }); }
  });
}
