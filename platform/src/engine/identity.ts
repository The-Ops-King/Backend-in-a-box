import type { PoolClient } from "pg";
import { one } from "@/db/client";

/**
 * D200 (audit §3): one way to write an email and a phone for matching; there were three, and the phone ones disagreed on numbers
 * written without a "+". The phone rule is the poll's, which wrote every stored contact identifier: a US/CA number any way it is
 * written becomes +1 and ten digits; anything else keeps its digits (and its "+", when it had one).
 */
export const normEmail = (e?: string | null): string | undefined => e?.trim().toLowerCase() || undefined;
export const normPhone = (p?: string | null): string | undefined => (p ? p.replace(/[^\d+]/g, "").replace(/^\+?1?(\d{10})$/, "+1$1") || undefined : undefined);

/**
 * D200 (audit §3): a contact this company keeps, by a GHL contact id (its primary one or one folded into it) or by an email. The
 * copies of these lookups disagreed on merged records; a contact folded into another is never the answer.
 */
export async function contactByGhlId(c: PoolClient, companyId: string, ghlId: string): Promise<string | null> {
  return (await one<{ id: string }>(c, `select ct.id from contacts ct where ct.company_id=$1 and ct.merged_into is null and (ct.ghl_contact_id=$2
    or exists (select 1 from contact_identifiers i where i.contact_id=ct.id and i.kind='ghl_contact' and i.value=$2 and i.retired_at is null)) limit 1`, [companyId, ghlId]))?.id ?? null;
}
export async function contactByEmail(c: PoolClient, companyId: string, email: string): Promise<string | null> {
  const e = normEmail(email); if (!e) return null;
  return (await one<{ id: string }>(c, "select i.contact_id as id from contact_identifiers i join contacts ct on ct.id=i.contact_id where i.company_id=$1 and i.kind='email' and i.value=$2 and i.retired_at is null and ct.merged_into is null limit 1", [companyId, e]))?.id ?? null;
}
