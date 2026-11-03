import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { createEventType, planEventTypeCopy } from "@/adapters/calendly/event-types";
export const dynamic = "force-dynamic";

/**
 * D310: POST { company, from: <event type uuid to copy>, owner: <member email>, name, duration?, why, dryRun = true }: a new one-person
 * Calendly calendar for `owner`, copied from `from` as far as Calendly's API allows; the answer lists what is left to set by hand.
 * It is not watched: watching it is `POST /api/admin/calendars/watch`. Audited. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; from?: string; owner?: string; name?: string; duration?: number; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !b.from || !b.owner || !b.name?.trim() || !b.why?.trim()) return NextResponse.json({ error: "company, from, owner, name and why are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany: ac } = await loadCompany(c, co.id);
    if (ac.booking.source !== "calendly") return NextResponse.json({ error: "this company does not book through Calendly" }, { status: 400 });
    try {
      const p = await planEventTypeCopy(ac.booking.token, ac.booking.organization, { from: b.from!, ownerEmail: b.owner!.trim().toLowerCase(), name: b.name!.trim(), duration: b.duration });
      if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
      if (b.dryRun !== false) return NextResponse.json({ ok: true, dryRun: true, ...p.plan });
      const made = await createEventType(ac.booking.token, p.plan);
      await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'calendly.event_type_created','calendar',$2,$3,$4)", [co.id, made.id, { copied_from: p.plan.from }, { ...p.plan.create, why: b.why, scheduling_url: made.scheduling_url }]);
      return NextResponse.json({ ok: true, dryRun: false, created: made, by_hand: p.plan.by_hand });
    } catch (err) { return NextResponse.json({ error: String((err as Error).message).slice(0, 300) }, { status: 502 }); }
  });
}
