import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { ghl } from "@/adapters/ghl/client";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D350: POST { company, name, team: [GHL user ids], minutes = 60, why, dryRun = true }: a GHL calendar that holds the appointments the
 * mirror puts there (booking.ghl_mirror), for an offer whose bookings are made elsewhere. Round robin, no open hours (nobody books on
 * it directly; the mirror writes past its availability), active. A calendar with that name already: refused. Audited.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; name?: string; team?: string[]; minutes?: number; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !b.name?.trim() || !b.team?.length || !b.why?.trim()) return NextResponse.json({ error: "company, name, team and why are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany: ac } = await loadCompany(c, co.id);
    const users = await ghl<{ users: { id: string; name?: string }[] }>(ac.pit, "GET", `/users/?locationId=${ac.locationId}`);
    const unknown = b.team!.filter((id) => !users.users.some((u) => u.id === id));
    if (unknown.length) return NextResponse.json({ error: `not users in this location: ${unknown.join(", ")}` }, { status: 400 });
    const have = await ghl<{ calendars: { id: string; name: string }[] }>(ac.pit, "GET", `/calendars/?locationId=${ac.locationId}`);
    const same = have.calendars.find((k) => k.name.trim().toLowerCase() === b.name!.trim().toLowerCase());
    if (same) return NextResponse.json({ error: `a calendar named "${same.name}" already exists (${same.id})` }, { status: 409 });
    const minutes = Number(b.minutes) > 0 ? Number(b.minutes) : 60;
    const body = { locationId: ac.locationId, name: b.name!.trim(), calendarType: "round_robin", eventType: "RoundRobin_OptimizeForAvailability",
      teamMembers: b.team!.map((id, i) => ({ userId: id, priority: 0.5, isPrimary: i === 0 })), slotDuration: minutes, slotDurationUnit: "mins",
      slotInterval: minutes, slotIntervalUnit: "mins", openHours: [], isActive: true };
    if (b.dryRun !== false) return NextResponse.json({ ok: true, dryRun: true, body });
    const r = await ghl<{ calendar?: { id: string; name: string } }>(ac.pit, "POST", "/calendars/", { version: "2021-04-15", body });
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'ghl.calendar_created','calendar',$2,$3)", [co.id, r.calendar?.id ?? "?", { name: body.name, team: b.team, why: b.why }]);
    return NextResponse.json({ ok: true, dryRun: false, calendar: r.calendar ?? null });
  });
}
