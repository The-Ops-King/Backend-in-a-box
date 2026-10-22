import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { calendly } from "@/adapters/calendly/client";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

type Membership = { user: string; user_email?: string; user_name?: string };
/**
 * D224: GET ?company=<slug>&event=<Calendly scheduled event uuid>: what Calendly holds about one booking, read live and only read:
 * its status, hosts, location, and `calendar_event` (the event Calendly wrote to the host's connected calendar: its kind and id, or
 * null when Calendly wrote none), plus each host's busy times over the event's day, by type (`calendly` = Calendly's own bookings,
 * `external` = events from a connected calendar; none of the second is a calendar that may not be connected).
 * Or `user=<a Calendly member's email>` in place of `event`: that person's busy times over the next 7 days, by type (whether any
 * calendar is connected for them; Calendly's API does not say which calendar it writes new bookings to).
 * Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams, slug = q.get("company"), id = q.get("event"), userEmail = q.get("user")?.trim().toLowerCase();
  if (slug && userEmail) return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany: ac } = await loadCompany(c, co.id);
    if (ac.booking.source !== "calendly") return NextResponse.json({ error: "this company does not book through Calendly" }, { status: 400 });
    const token = ac.booking.token, org = ac.booking.organization;
    try {
      const m = await calendly<{ collection: { user: { uri: string; email: string; name?: string; timezone?: string } }[] }>(token, `/organization_memberships?organization=${encodeURIComponent(org)}&email=${encodeURIComponent(userEmail)}`);
      const u = m.collection?.[0]?.user; if (!u) return NextResponse.json({ error: `no member of the Calendly organization has ${userEmail}` }, { status: 404 });
      const from = new Date(), to = new Date(Date.now() + 7 * 864e5);
      const r = await calendly<{ collection?: { type: string; start_time: string; end_time: string }[] }>(token, `/user_busy_times?user=${encodeURIComponent(u.uri)}&start_time=${encodeURIComponent(from.toISOString())}&end_time=${encodeURIComponent(to.toISOString())}`);
      const busy = (r.collection ?? []).map((b) => ({ type: b.type, start: b.start_time, end: b.end_time }));
      return NextResponse.json({ ok: true, user: { email: u.email, name: u.name ?? null, timezone: u.timezone ?? null }, days: 7, external_count: busy.filter((b) => b.type === "external").length, calendly_count: busy.filter((b) => b.type === "calendly").length, busy });
    } catch (err) { return NextResponse.json({ error: String((err as Error).message).slice(0, 300) }, { status: 502 }); }
  });
  if (!slug || !id || !/^[A-Za-z0-9-]{8,}$/.test(id)) return NextResponse.json({ error: "company and event (a Calendly scheduled event uuid) are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany: ac } = await loadCompany(c, co.id);
    if (ac.booking.source !== "calendly") return NextResponse.json({ error: "this company does not book through Calendly" }, { status: 400 });
    const token = ac.booking.token;
    try {
      const { resource: e } = await calendly<{ resource: { name: string; status: string; start_time: string; end_time: string; created_at: string; updated_at: string; location?: unknown; calendar_event?: { kind?: string; external_id?: string } | null; event_memberships?: Membership[]; event_guests?: unknown[] } }>(token, `/scheduled_events/${id}`);
      const day = { from: new Date(new Date(e.start_time).getTime() - 12 * 36e5), to: new Date(new Date(e.end_time).getTime() + 12 * 36e5) };
      const hosts = [];
      for (const m of e.event_memberships ?? []) {
        let busy: { type: string; start: string; end: string }[] | string = [];
        try {
          const r = await calendly<{ collection?: { type: string; start_time: string; end_time: string }[] }>(token, `/user_busy_times?user=${encodeURIComponent(m.user)}&start_time=${encodeURIComponent(day.from.toISOString())}&end_time=${encodeURIComponent(day.to.toISOString())}`);
          busy = (r.collection ?? []).map((b) => ({ type: b.type, start: b.start_time, end: b.end_time }));
        } catch (err) { busy = `busy times unreadable: ${String((err as Error).message).slice(0, 160)}`; }
        hosts.push({ email: m.user_email ?? null, name: m.user_name ?? null, busy, external_count: Array.isArray(busy) ? busy.filter((b) => b.type === "external").length : null, calendly_count: Array.isArray(busy) ? busy.filter((b) => b.type === "calendly").length : null });
      }
      return NextResponse.json({ ok: true, event: { name: e.name, status: e.status, start: e.start_time, end: e.end_time, created: e.created_at, updated: e.updated_at, location: e.location ?? null, calendar_event: e.calendar_event ?? null, guests: e.event_guests ?? [] }, hosts });
    } catch (err) { return NextResponse.json({ error: String((err as Error).message).slice(0, 300) }, { status: 502 }); }
  });
}
