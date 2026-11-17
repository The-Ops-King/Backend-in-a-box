import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { ghl } from "@/adapters/ghl/client";
import { cloneCalendar } from "@/engine/ghl-calendar-clone";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D344: POST { company, from: <GHL calendar id>, name, team: [emails], apply = false } with Authorization: Bearer $CRON_SECRET:
 * a copy of one of the offer's GHL calendars (its meeting location, form, notifications and hours) with only `team` on it.
 * Without apply it says what would be made; one with that name already is never made twice. Audited when made. The engine
 * does not watch the new calendar until it is mapped to a call type (a separate step).
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; from?: string; name?: string; team?: string[]; apply?: boolean } | null;
  if (!b?.company || !b.from || !b.name?.trim() || !Array.isArray(b.team) || !b.team.length) return NextResponse.json({ error: "company, from, name and team (emails) are required" }, { status: 400 });
  try {
    return await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]);
      if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
      const users = await many<{ email: string; ghl_user_id: string | null }>(c, "select lower(email) as email, ghl_user_id from users where company_id=$1 and lower(email) = any($2::text[])", [co.id, b.team!.map((e) => e.toLowerCase())]);
      const missing = b.team!.filter((e) => !users.find((u) => u.email === e.toLowerCase() && u.ghl_user_id));
      if (missing.length) return NextResponse.json({ error: `not a GHL user of this offer: ${missing.join(", ")}` }, { status: 400 });
      const { adapterCompany } = await loadCompany(c, co.id);
      const r = await cloneCalendar((m, p, o) => ghl(adapterCompany.pit, m, p, o), adapterCompany.locationId, { from: b.from!, name: b.name!.trim(), userIds: b.team!.map((e) => users.find((u) => u.email === e.toLowerCase())!.ghl_user_id!), apply: b.apply === true });
      if (r.created && b.apply && r.would === "create") await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'ghl.calendar_cloned','calendar',$2,$3)", [co.id, r.created.id, { from: r.from, name: r.name, team: b.team, left_out: r.left_out }]);
      return NextResponse.json({ ok: true, applied: b.apply === true, ...r });
    });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message).slice(0, 500) }, { status: 502 }); }
}
