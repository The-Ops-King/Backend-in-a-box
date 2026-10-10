import type { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import type { CompanyRow } from "./context";
import { boundFieldIds, upsertContact } from "./poll";
import { raise } from "./alerts";

/**
 * D68: GHL is the source of truth about a person; the `contacts` replica is a cache. Before a run acts, the contact is
 * read live (one GET per claimed run per wake, the price cards already pay under D41) and folded into the replica by the
 * same path the poll uses, so the name, address, custom fields, zone, owner and primary id a step sees are the CRM's as of
 * now. A refresh never emits an event: `lead.created` and the tag deltas stay the poll's job, so the replica's `tags`
 * are left as the poll last saw them (a refresh that wrote the CRM's tags first would swallow the poll's diff).
 */
export type ContactTruth =
  | { ok: true; fresh: true; fetched_at: string; ghl_contact_id: string; moved: boolean }   // moved: the primary id answered 404 and another current id answered
  | { ok: true; fresh: false; why: string }                                                 // the CRM did not answer: the run acts on the engine's copy
  | { ok: false; why: "contact gone" };                                                     // every id the person has answers 404

export async function refreshContact(c: PoolClient, company: CompanyRow, adapterCompany: Company, adapters: Adapters, bindings: Record<string, string>, contactId: string, now: DateTime): Promise<ContactTruth> {
  const row = await one<{ ghl_contact_id: string | null; tags: string[]; ghl_updated_at: Date | null; first_name: string | null; last_name: string | null }>(c, "select ghl_contact_id, tags, ghl_updated_at, first_name, last_name from contacts where id=$1 and merged_into is null", [contactId]);
  if (!row) return { ok: false, why: "contact gone" };
  // a person held locally until the CRM poll sees them (a Calendly invitee, G16) has nothing to read yet
  if (!row.ghl_contact_id) return { ok: true, fresh: false, why: "the contact has no CRM id yet" };
  const primary = row.ghl_contact_id;
  // the primary first; then any other current id the person carries (a duplicate the poll folded, D60/D63), newest first
  const others = await many<{ value: string }>(c, "select value from contact_identifiers where contact_id=$1 and kind='ghl_contact' and retired_at is null and value<>$2 order by created_at desc, value", [contactId, primary]);
  for (const id of [primary, ...others.map((o) => o.value)]) {
    let snap: Awaited<ReturnType<typeof adapters.read.getContact>>;
    try { snap = await adapters.read.getContact(adapterCompany, id); }
    catch (e) { return { ok: true, fresh: false, why: String((e as Error).message).slice(0, 300) }; }
    if (!snap) continue;   // 404: this id is gone from the CRM; the person may live on under another
    const moved = id !== primary;
    if (moved) {
      // the record the CRM still has is the one writes go to (D65); the dead id is retired, as the duplicates sweep does (D63)
      await c.query("update contacts set ghl_contact_id=$2, updated_at=now() where id=$1", [contactId, id]);
      await c.query("update contact_identifiers set retired_at=now() where contact_id=$1 and kind='ghl_contact' and value=$2 and retired_at is null", [contactId, primary]);
    }
    // the same record with a stamp older than the one the poll already folded is the past, not the truth (the D41 rule); a moved primary is folded regardless
    const liveAt = Date.parse(snap.dateUpdated);
    const older = !moved && Number.isFinite(liveAt) && !!row.ghl_updated_at && liveAt < row.ghl_updated_at.getTime();
    if (!older) await upsertContact(c, company.id, company.timezone, { ...snap, tags: row.tags }, boundFieldIds(bindings));
    return { ok: true, fresh: true, fetched_at: now.toISO()!, ghl_contact_id: id, moved };
  }
  // G21's mark, learned before a send instead of from its refusal; the premise `contact_exists` exits every run about them
  const r = await c.query("update contacts set gone_at=now(), updated_at=now() where id=$1 and gone_at is null", [contactId]);
  if (r.rowCount) {
    const who = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || primary;
    await raise(c, { companyId: company.id, key: `contact:gone:${contactId}`, level: "warning", source: "engine", href: `/app/c/${company.slug}`,
      text: `${who} is gone from the CRM (deleted or merged there); the runs about them exit instead of sending.`,
      detail: { contact_id: contactId, ghl_contact_id: primary, tried: [primary, ...others.map((o) => o.value)] } }, now.toJSDate());
  }
  return { ok: false, why: "contact gone" };
}
