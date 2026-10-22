import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { bookingFor } from "@/adapters/types";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D206: GET ?company=<slug>: every calendar (event type) the offer's booking tool has, read live, with whether the engine watches it,
 * its call type and owner. Read only. Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("company"); if (!slug) return NextResponse.json({ error: "company is required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany: ac } = await loadCompany(c, co.id);
    const watched = await many<{ external_id: string; active: boolean; term: string | null; owner: string | null; booking: string | null; alerts: string | null }>(c, `select k.external_id, k.active, t.name as term, u.name as owner, k.config->>'booking' as booking, k.config->>'alerts' as alerts
      from calendars k left join company_terms t on t.id=k.appointment_term left join users u on u.id::text = k.config->>'owner' where k.company_id=$1`, [co.id]);
    const listed = await bookingFor(liveAdapters, ac).listCalendars(ac);
    return NextResponse.json({ ok: true, calendars: listed.map((k) => { const w = watched.find((x) => x.external_id === k.id); return { id: k.id, name: k.name, url: k.bookingUrl ?? null, active: k.active ?? null, pooling: k.pooling ?? null, hosts: (k.hosts ?? []).map((h) => h.email), watched: !!w?.active, call_type: w?.term ?? null, owner: w?.owner ?? null, booking: w?.booking ?? null, alerts: w ? w.alerts !== "false" : null }; }) });
  });
}
