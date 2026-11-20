import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { mirrorMap, mirrorToGhl } from "@/engine/ghl-mirror";
import { ghl } from "@/adapters/ghl/client";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D350: GET ?company=<slug>[&from=<ISO>]: the offer's GHL calendars (id, name, team), its booking.ghl_mirror map, and what the
 * next pass would do (a dry run: the appointments it would create, adopt, cancel or move). `from` previews a booking.ghl_mirror_from
 * not yet set. `contact=<GHL contact id>`: that person's GHL appointments with the calendar each is on (how a calendar GHL's list
 * leaves out, such as a Calendly integration's, is found); `calendar=<GHL calendar id>`: that calendar read by its id. Read only.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url); const slug = u.searchParams.get("company"); const from = u.searchParams.get("from");
  const contact = u.searchParams.get("contact"), calendar = u.searchParams.get("calendar");
  if (!slug) return NextResponse.json({ error: "company is required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany: ac, bindings } = await loadCompany(c, co.id);
    const b = from ? { ...bindings, "booking.ghl_mirror_from": from } : bindings;
    if (contact || calendar) {
      const out: Record<string, unknown> = { ok: true };
      if (contact) out.appointments = await ghl<{ events?: Record<string, unknown>[] }>(ac.pit, "GET", `/contacts/${encodeURIComponent(contact)}/appointments`)
        .then((r) => (r.events ?? []).map((e) => ({ id: e.id, calendarId: e.calendarId, title: e.title, startTime: e.startTime, status: e.appointmentStatus ?? e.status, assignedUserId: e.assignedUserId })))
        .catch((e) => ({ error: String((e as Error).message).slice(0, 300) }));
      if (calendar) out.calendar = await ghl<{ calendar?: Record<string, unknown> }>(ac.pit, "GET", `/calendars/${encodeURIComponent(calendar)}`, { version: "2021-04-15" })
        .then((r) => { const k = r.calendar ?? {}; return { id: k.id, name: k.name, calendarType: k.calendarType, isActive: k.isActive, team: ((k.teamMembers as { userId: string }[] | undefined) ?? []).map((t) => t.userId) }; })
        .catch((e) => ({ error: String((e as Error).message).slice(0, 300) }));
      return NextResponse.json(out);
    }
    const ghlCalendars = (await liveAdapters.booking.ghl.listCalendars(ac)).map((k) => ({ id: k.id, name: k.name, team: k.teamMemberIds }));
    const plan = await mirrorToGhl(c, { companyId: co.id, ac, adapters: liveAdapters, bindings: b }, { dryRun: true, limit: 100 });
    return NextResponse.json({ ok: true, map: mirrorMap(b), from: b["booking.ghl_mirror_from"] ?? null, ghlCalendars, plan });
  });
}
