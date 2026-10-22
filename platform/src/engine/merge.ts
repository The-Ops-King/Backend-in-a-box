import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { contactByGhlId } from "./identity";
import { upsertContact } from "./poll";

/**
 * D222: GHL merged two contacts and dropped one; the engine follows. Tyler: "Yes that needs to happen", and for anything like it,
 * "unless it's not 100% sure." So the person a gone contact became is looked for only by what is unique to a person: GHL asked by
 * each of its emails (a phone already makes one engine person of two records, D60). Exactly one live GHL contact found (or the one
 * the caller already matched by phone or email, `into`: the duplicates check), and the gone one's calls, deals, cards, payments, records, recordings, forms, agreements, messages, emails and
 * phones move to it, the gone row kept as `merged_into` it with its own history (events, runs, sends). None or several: nothing moves.
 * A moved Sales Call that GHL still relates to the dropped contact is the drift check's to relink, in the offer's mode.
 */
export type MergeResult = { folded: true; into: { id: string; name: string; ghl_contact_id: string }; moved: Record<string, number> } | { folded: false; why: string };
const MOVED = ["appointments", "opportunities", "pipeline_cards", "payments", "crm_records", "recordings", "form_submissions", "intake", "agreements", "messages"] as const;

export async function followMerge(c: PoolClient, companyId: string, companyTz: string, ac: Company, adapters: Adapters, goneId: string, into?: string): Promise<MergeResult> {
  const gone = await one<{ id: string; ghl_contact_id: string | null; merged_into: string | null }>(c, "select id, ghl_contact_id, merged_into from contacts where id=$1 and company_id=$2", [goneId, companyId]);
  if (!gone) return { folded: false, why: "no such contact" };
  if (gone.merged_into) return { folded: false, why: "already merged" };
  const ownIds = new Set((await many<{ value: string }>(c, "select value from contact_identifiers where contact_id=$1 and kind='ghl_contact'", [goneId])).map((r) => r.value).concat(gone.ghl_contact_id ?? []));
  const found = new Set<string>();
  if (into) {
    const g = (await one<{ ghl_contact_id: string | null }>(c, "select ghl_contact_id from contacts where id=$1 and company_id=$2 and gone_at is null and merged_into is null", [into, companyId]))?.ghl_contact_id;
    if (g) found.add(g);
  } else {
    // a phone or email is one engine person's only (D60), so another live record with it can only be found by asking GHL
    const emails = await many<{ value: string }>(c, "select value from contact_identifiers where contact_id=$1 and kind='email'", [goneId]);
    if (!emails.length || !adapters.read.contactsByEmail) return { folded: false, why: "it had no email to find it by" };
    for (const e of emails) for (const hit of await adapters.read.contactsByEmail(ac, e.value)) found.add(hit.id);
  }
  for (const id of ownIds) found.delete(id);
  // only a record GHL still has counts: a lookup can name one it has since dropped too
  const live = new Map<string, Awaited<ReturnType<typeof adapters.read.getContact>>>();
  for (const id of found) { const snap = await adapters.read.getContact(ac, id); if (snap) live.set(id, snap); }
  if (live.size !== 1) return { folded: false, why: live.size ? `${live.size} live GHL contacts share its email, so which one it became is not certain` : "no live GHL contact has its email" };
  const [ghlId, snap] = [...live][0];
  let survivor = await contactByGhlId(c, companyId, ghlId);
  if (!survivor) survivor = (await upsertContact(c, companyId, companyTz, snap!)).id;
  if (survivor === goneId) return { folded: false, why: "it is its own survivor" };
  const moved: Record<string, number> = {};
  for (const t of MOVED) { const r = await c.query(`update ${t} set contact_id=$3 where company_id=$1 and contact_id=$2`, [companyId, goneId, survivor]); if (r.rowCount) moved[t] = r.rowCount; }
  const ids = await c.query("update contact_identifiers set contact_id=$3 where company_id=$1 and contact_id=$2 and kind in ('email','phone')", [companyId, goneId, survivor]);
  if (ids.rowCount) moved.identifiers = ids.rowCount;
  await c.query("update contacts set merged_into=$2, gone_at=coalesce(gone_at, now()), updated_at=now() where id=$1", [goneId, survivor]);
  const name = (await one<{ name: string }>(c, "select trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) as name from contacts where id=$1", [survivor]))?.name || ghlId;
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'contact.merged','contact',$2,$3,$4)",
    [companyId, goneId, { ghl_contact_ids: [...ownIds] }, { into: survivor, ghl_contact_id: ghlId, moved, why: into ? "the duplicates check matched them" : "the one live GHL contact with its email" }]);
  return { folded: true, into: { id: survivor, name, ghl_contact_id: ghlId }, moved };
}
