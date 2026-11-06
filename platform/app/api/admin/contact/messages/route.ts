import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { ghlWorkflows } from "@/adapters/ghl/catalog";
export const dynamic = "force-dynamic";

/**
 * D318: read only. GET ?company=<slug>&contact=<GHL id or ours>&limit=<n, default 40>: the contact's latest messages as GHL has them
 * (when, channel, direction, source, the workflow that sent it when GHL says, subject, the first words), with the names of the offer's
 * GHL workflows put on the ids. Answers "what did they get, and from what". Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url), slug = u.searchParams.get("company"), contact = u.searchParams.get("contact");
  const limit = Math.min(100, Math.max(1, Number(u.searchParams.get("limit") ?? 40)));
  if (!slug || !contact) return NextResponse.json({ error: "company and contact are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const ct = await one<{ ghl_contact_id: string | null }>(c, "select ghl_contact_id from contacts where company_id=$1 and (ghl_contact_id=$2 or id::text=$2)", [co.id, contact]);
    const ghlId = ct?.ghl_contact_id ?? contact;
    const { adapterCompany: ac } = await loadCompany(c, co.id);
    if (!liveAdapters.read.contactMessages) return NextResponse.json({ error: "this CRM cannot list a contact's messages" }, { status: 501 });
    try {
      const msgs = await liveAdapters.read.contactMessages(ac, ghlId, limit);
      const names = new Map<string, string>();
      try { if (msgs.some((m) => m.workflow)) for (const w of await ghlWorkflows(ac.pit, ac.locationId)) names.set(w.id, w.name); } catch { /* names are a convenience */ }
      return NextResponse.json({ ok: true, contact: ghlId, messages: msgs.map((m) => ({ ...m, workflow_name: m.workflow ? names.get(m.workflow) ?? null : null })) });
    } catch (e) { return NextResponse.json({ error: String((e as Error).message).slice(0, 300) }, { status: 502 }); }
  });
}
