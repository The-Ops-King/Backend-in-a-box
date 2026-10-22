import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D225: GET ?company=<slug>&contact=<engine contact id>: every call the CRM's dialer logged with that person, read live and only read:
 * when, which way, its status, how long, and which CRM user made or took it. Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams, slug = q.get("company"), id = q.get("contact");
  if (!slug || !id || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "company and contact (its id) are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const ct = await one<{ ghl_contact_id: string | null; name: string }>(c, "select ghl_contact_id, trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) as name from contacts where company_id=$1 and id=$2", [co.id, id]);
    if (!ct?.ghl_contact_id) return NextResponse.json({ error: "no such contact, or it has no CRM id" }, { status: 404 });
    if (!liveAdapters.read.contactCalls) return NextResponse.json({ error: "this CRM cannot list a contact's calls" }, { status: 400 });
    const { adapterCompany } = await loadCompany(c, co.id);
    const users = new Map((await many<{ ghl_user_id: string; name: string }>(c, "select ghl_user_id, name from users where company_id=$1 and ghl_user_id is not null", [co.id])).map((u) => [u.ghl_user_id, u.name]));
    try {
      const calls = (await liveAdapters.read.contactCalls(adapterCompany, ct.ghl_contact_id)).map((m) => ({ at: m.dateAdded, direction: m.direction, status: m.call?.status ?? m.status ?? null, seconds: m.call?.durationSec ?? null, user: m.call?.userId ? users.get(m.call.userId) ?? m.call.userId : null }));
      return NextResponse.json({ ok: true, contact: { id, name: ct.name }, calls });
    } catch (e) { return NextResponse.json({ error: String((e as Error).message).slice(0, 300) }, { status: 502 }); }
  });
}
