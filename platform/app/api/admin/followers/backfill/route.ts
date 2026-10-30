import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { testDomains } from "@/engine/mode";
import { setsToFollow } from "@/engine/followers";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/**
 * D268: the setters of one offer's closing calls booked in the last `days` (default 30) follow those contacts in GHL. POST { company,
 * days?, skip?: [contact ids], dryRun = true }: the dry run lists each contact and who would follow it and why; dryRun false adds them
 * (GHL keeps followers it already has) and audits each. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; days?: number; skip?: string[]; dryRun?: boolean } | null;
  if (!b?.company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  const days = Number(b.days ?? 30); if (!(days > 0 && days <= 365)) return NextResponse.json({ error: "days must be 1-365" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany, bindings } = await loadCompany(c, co.id);
    const skip = new Set(b.skip ?? []);
    const sets = (await setsToFollow(c, co.id, { since: new Date(Date.now() - days * 864e5), domains: testDomains(bindings) })).filter((s) => !skip.has(s.contact_id));
    // one write per contact: everyone who set any of their calls
    const byContact = new Map<string, { contact_id: string; ghl_contact_id: string; contact: string; followers: Map<string, { name: string; why: string[] }> }>();
    for (const s of sets) {
      const e = byContact.get(s.contact_id) ?? { contact_id: s.contact_id, ghl_contact_id: s.ghl_contact_id, contact: s.contact, followers: new Map() };
      for (const u of s.setters) { const f = e.followers.get(u.ghl_user_id) ?? { name: u.name, why: [] }; f.why.push(`${u.why === "set_link" ? "booked" : "triaged"} the call booked ${s.booked_at.toISOString().slice(0, 10)}${s.status === "cancelled" ? " (cancelled)" : ""}`); e.followers.set(u.ghl_user_id, f); }
      byContact.set(s.contact_id, e);
    }
    const list = [...byContact.values()].map((e) => ({ contact_id: e.contact_id, contact: e.contact, followers: [...e.followers].map(([ghl, f]) => ({ ghl_user_id: ghl, name: f.name, why: f.why })) }));
    if (b.dryRun !== false) return NextResponse.json({ ok: true, dryRun: true, days, contacts: list.length, would_follow: list });
    if (!liveAdapters.write.addFollowers) return NextResponse.json({ error: "this CRM cannot add followers" }, { status: 400 });
    const done: string[] = [], failed: { contact: string; error: string }[] = [], owners: { contact: string; owner: string }[] = [];
    for (const e of byContact.values()) {
      // GHL refuses the contact's owner as a follower (and then adds nobody): the owner already sees the contact, so is left out
      let ids = [...e.followers.keys()];
      try {
        const owner = (await liveAdapters.read.getContact(adapterCompany, e.ghl_contact_id))?.assignedTo;
        if (owner && ids.includes(owner)) { owners.push({ contact: e.contact, owner: e.followers.get(owner)!.name }); ids = ids.filter((x) => x !== owner); }
        if (!ids.length) continue;
        await liveAdapters.write.addFollowers(adapterCompany, "contact", e.ghl_contact_id, ids);
        await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'contact.followers_added','contact',$2,$3)", [co.id, e.contact_id, { followers: ids, by: "followers backfill (D268)" }]);
        done.push(e.contact);
      } catch (err) { failed.push({ contact: e.contact, error: String((err as Error).message).slice(0, 200) }); }
    }
    return NextResponse.json({ ok: failed.length === 0, dryRun: false, added: done.length, failed, already_owner: owners });
  });
}
