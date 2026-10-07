import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { simulate, SIM_ACTIONS, type SimAction } from "@/engine/simulate";
export const dynamic = "force-dynamic";

/**
 * Stage a synthetic step for a real contact, behind the scenes (D23). Nothing reaches the CRM, Calendly or any Zap.
 * POST { company: <slug>, contact: <email | our id | GHL id>, action: create|book|book-self|reschedule|cancel|pay|record|reset, force?: boolean, daysOut?: number }
 * Authorization: Bearer $CRON_SECRET. Refused for a live company unless force=true.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string; contact?: string; action?: string; force?: boolean; daysOut?: number } | null;
  if (!body?.company || !body.contact || !body.action) return NextResponse.json({ error: "company, contact and action are required" }, { status: 400 });
  const who = body.contact.trim(), slug = body.company;
  if (!(SIM_ACTIONS as readonly string[]).includes(body.action)) return NextResponse.json({ error: `action must be one of ${SIM_ACTIONS.join(", ")}` }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
    if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { row: company } = await loadCompany(c, co.id);
    const ct = await one<{ id: string }>(c, `select ct.id from contacts ct where ct.company_id=$1 and ct.merged_into is null and (ct.id::text=$2 or ct.ghl_contact_id=$2 or exists (select 1 from contact_identifiers i where i.contact_id=ct.id and i.kind='email' and i.value=lower($2))) limit 1`, [co.id, who]);
    if (!ct) return NextResponse.json({ error: `no contact matches ${who} (the poll must have seen them first)` }, { status: 404 });
    const r = await simulate({ c, company, contactId: ct.id, force: body.force, daysOut: body.daysOut }, body.action as SimAction);
    if (!r.ok) return NextResponse.json({ error: r.why }, { status: 409 });
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,$2,'contact',$3,$4)", [co.id, `simulate.${r.action}`, ct.id, { ...r.detail, runs_started: r.runsStarted, via: "api" }]);
    return NextResponse.json({ ok: true, contact: ct.id, action: r.action, detail: r.detail, runs_started: r.runsStarted, dashboard: `/c/${slug}/contacts/${ct.id}` });
  });
}
