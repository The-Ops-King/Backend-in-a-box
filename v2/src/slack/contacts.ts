import { sql } from "drizzle-orm";
import type { Db } from "./data";

/**
 * Finding a contact for a person in Slack (the Link modal's search, /agreement): a read of the contacts projection
 * (contacts_index) of one offer, by a name, an email, a phone or the CRM id. Never across offers.
 */
export type Found = { id: string; name: string; email: string | null; phone: string | null };

const nameOf = (attrs: Record<string, unknown>, emails: string[], phones: string[], id: string) => {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return s(attrs.name) || [s(attrs.first_name), s(attrs.last_name)].filter(Boolean).join(" ") || emails[0] || phones[0] || id;
};

type Row = { id: string; attrs: Record<string, unknown>; emails: string[]; phones: string[] };
const found = (r: Row): Found => ({ id: r.id, name: nameOf(r.attrs ?? {}, r.emails ?? [], r.phones ?? [], r.id), email: r.emails?.[0] ?? null, phone: r.phones?.[0] ?? null });

export async function searchContacts(db: Db, offerId: string, query: string, limit = 20): Promise<Found[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const digits = q.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = (await db.execute(sql`
    select id, attrs, emails, phones from contacts_index
    where offer_id = ${offerId} and merged_into is null and (
      lower(id) = ${q} or lower(coalesce(crm_id, '')) = ${q}
      or lower(coalesce(attrs->>'name', '')) like ${like}
      or lower(coalesce(attrs->>'first_name', '') || ' ' || coalesce(attrs->>'last_name', '')) like ${like}
      or exists (select 1 from unnest(emails) e where e like ${like})
      or (${digits.length >= 4} and exists (select 1 from unnest(phones) p where p like ${`%${digits}%`}))
    )
    order by lower(coalesce(attrs->>'name', attrs->>'first_name', id)) limit ${limit}`)).rows as Row[];
  return rows.map(found);
}

/** One contact of the offer by id (a modal's choice), or by an exact email or phone (/agreement <email>). */
export async function contactOf(db: Db, offerId: string, key: string): Promise<Found | undefined> {
  const k = key.trim().replace(/^<mailto:([^|>]+)(\|[^>]*)?>$/, "$1").toLowerCase();
  const digits = k.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const rows = (await db.execute(sql`
    select id, attrs, emails, phones from contacts_index
    where offer_id = ${offerId} and merged_into is null and (id = ${key.trim()} or ${k} = any(emails) or (${digits.length >= 7} and ${digits} = any(phones)))
    order by id limit 2`)).rows as Row[];
  return rows.length === 1 ? found(rows[0]!) : undefined;
}
