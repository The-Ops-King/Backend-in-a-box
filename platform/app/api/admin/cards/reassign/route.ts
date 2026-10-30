import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * D260: POST { company, from: <GHL user id or email>, to: <email of someone on the roster>, why, dryRun = true }: every open card the
 * replica has on `from` is assigned to `to` in GHL (a person whose GHL user was replaced: Jassie's AOL user, removed, for her
 * nellysudri one). Each card is read live first and moved only if GHL still has it on `from`; the rest are said. Audited.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; from?: string; to?: string; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !b.from || !b.to || !b.why?.trim()) return NextResponse.json({ error: "company, from, to and why are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const from = await one<{ id: string; ghl_user_id: string | null; name: string }>(c, "select id, ghl_user_id, name from users where company_id=$1 and (ghl_user_id=$2 or lower(email)=lower($2)) order by active desc limit 1", [co.id, b.from]);
    const to = await one<{ id: string; ghl_user_id: string | null; name: string }>(c, "select id, ghl_user_id, name from users where company_id=$1 and lower(email)=lower($2) and active and ghl_user_id is not null", [co.id, b.to]);
    if (!from?.ghl_user_id) return NextResponse.json({ error: "from: no one on the roster with that GHL user or email" }, { status: 404 });
    if (!to?.ghl_user_id) return NextResponse.json({ error: "to: no active roster member with that email and a GHL user" }, { status: 404 });
    if (from.ghl_user_id === to.ghl_user_id) return NextResponse.json({ error: "from and to are the same GHL user" }, { status: 400 });
    const cards = await many<{ id: string; ghl_opportunity_id: string; name: string; contact_id: string; ghl_contact_id: string | null }>(c, `select p.id, p.ghl_opportunity_id, p.name, p.contact_id, ct.ghl_contact_id from pipeline_cards p join contacts ct on ct.id=p.contact_id
      where p.company_id=$1 and p.status='open' and p.assigned_user_id=$2 and p.ghl_opportunity_id is not null order by p.name`, [co.id, from.id]);
    const { adapterCompany: ac } = await loadCompany(c, co.id);
    const out: { card: string; name: string; now?: string; done?: boolean; skipped?: string; error?: string }[] = [];
    for (const k of cards) {
      // live: the card as GHL has it now (a person may have moved or closed it since)
      const live = k.ghl_contact_id ? (await liveAdapters.read.openCards(ac, k.ghl_contact_id).catch(() => [])).find((x) => x.id === k.ghl_opportunity_id) : undefined;
      if (!live) { out.push({ card: k.ghl_opportunity_id, name: k.name, skipped: "not open in GHL any more" }); continue; }
      if (live.assignedUserId && live.assignedUserId !== from.ghl_user_id) { out.push({ card: k.ghl_opportunity_id, name: k.name, skipped: "GHL has it on someone else now" }); continue; }
      if (b.dryRun !== false) { out.push({ card: k.ghl_opportunity_id, name: k.name, now: from.name }); continue; }
      try {
        await liveAdapters.write.updateOpportunity(ac, k.ghl_opportunity_id, { assignedUserId: to.ghl_user_id });
        await c.query("update pipeline_cards set assigned_user_id=$2, updated_at=clock_timestamp() where id=$1", [k.id, to.id]);
        out.push({ card: k.ghl_opportunity_id, name: k.name, done: true });
      } catch (e) { out.push({ card: k.ghl_opportunity_id, name: k.name, error: String((e as Error).message).slice(0, 200) }); }
    }
    if (b.dryRun === false) await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'cards.reassigned','user',$2,$3)", [co.id, to.id, { from: from.ghl_user_id, to: to.ghl_user_id, why: b.why, cards: out }]);
    return NextResponse.json({ ok: true, dryRun: b.dryRun !== false, from: from.name, to: to.name, cards: out });
  });
}
