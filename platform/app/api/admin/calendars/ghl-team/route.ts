import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { ghl } from "@/adapters/ghl/client";
import { mirrorMap } from "@/engine/ghl-mirror";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

type Member = { userId: string; priority?: number; isPrimary?: boolean; [k: string]: unknown };
type Cal = { id: string; name: string; teamMembers?: Member[]; slotDuration?: number; slotDurationUnit?: string; slotInterval?: number; slotIntervalUnit?: string; openHours?: unknown[] };

/**
 * D350: POST { company, calendar: <GHL calendar id>, add: [GHL user ids], why, dryRun = true }: people added to the team of a GHL
 * calendar the mirror writes to (booking.ghl_mirror's), so their bookings are put on it in their name. Everyone already on it stays as
 * they are; the calendar's schedule is sent back unchanged (GHL's PUT resets what it is not sent). Only a calendar the mirror maps.
 * Audited. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; calendar?: string; add?: string[]; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !b.calendar || !b.add?.length || !b.why?.trim()) return NextResponse.json({ error: "company, calendar, add and why are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany: ac, bindings } = await loadCompany(c, co.id);
    if (!Object.values(mirrorMap(bindings)).includes(b.calendar!)) return NextResponse.json({ error: "not a GHL calendar this offer's mirror writes to" }, { status: 400 });
    const users = await ghl<{ users: { id: string; name?: string }[] }>(ac.pit, "GET", `/users/?locationId=${ac.locationId}`);
    const unknown = b.add!.filter((id) => !users.users.some((u) => u.id === id));
    if (unknown.length) return NextResponse.json({ error: `not users in this location: ${unknown.join(", ")}` }, { status: 400 });
    const ex = (await ghl<{ calendar?: Cal }>(ac.pit, "GET", `/calendars/${encodeURIComponent(b.calendar!)}`, { version: "2021-04-15" })).calendar;
    if (!ex) return NextResponse.json({ error: "no such GHL calendar" }, { status: 404 });
    const have = ex.teamMembers ?? [];
    const adding = b.add!.filter((id) => !have.some((m) => m.userId === id));
    const team = [...have, ...adding.map((id) => ({ userId: id, priority: 0.5, isPrimary: false }))];
    const keep = { slotDuration: ex.slotDuration, slotDurationUnit: ex.slotDurationUnit ?? "mins", slotInterval: ex.slotInterval ?? ex.slotDuration, slotIntervalUnit: ex.slotIntervalUnit ?? ex.slotDurationUnit ?? "mins", openHours: Array.isArray(ex.openHours) ? ex.openHours : [] };
    const view = { calendar: ex.name, was: have.map((m) => m.userId), adding, now: team.map((m) => m.userId) };
    if (b.dryRun !== false || !adding.length) return NextResponse.json({ ok: true, dryRun: b.dryRun !== false, ...view, ...(adding.length ? {} : { note: "already on the team" }) });
    await ghl(ac.pit, "PUT", `/calendars/${encodeURIComponent(b.calendar!)}`, { version: "2021-04-15", body: { teamMembers: team, ...keep } });
    const after = (await ghl<{ calendar?: Cal }>(ac.pit, "GET", `/calendars/${encodeURIComponent(b.calendar!)}`, { version: "2021-04-15" })).calendar;
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'ghl.calendar_team','calendar',$2,$3)", [co.id, b.calendar, { ...view, why: b.why }]);
    return NextResponse.json({ ok: true, dryRun: false, ...view, readBack: (after?.teamMembers ?? []).map((m) => m.userId) });
  });
}
