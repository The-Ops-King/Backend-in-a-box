import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { DocumentSnapshot } from "@/adapters/types";
import { emitEvent, type EventRow } from "./dispatch";

/**
 * Agreements (D30): the CRM's Documents & Contracts, mirrored. The poll reads every document the location has sent and
 * keeps one row per document; a new row is `agreement.sent`, and the first time the signer has completed it the row gets
 * `signed_at` and that is `agreement.signed` — exactly once, whatever order the poll sees things in. A `send_document`
 * step writes the row first (sent_by 'engine') so the poll recognises its own document instead of announcing it again.
 */
export type AgreementRow = { id: string; company_id: string; contact_id: string | null; external_id: string; name: string | null; status: string; sent_at: Date; signed_at: Date | null; sent_by: string | null; raw: Record<string, unknown>; updated_at: Date };
export const isSigned = (status: string) => status === "completed" || status === "signed";

export async function applyDocument(c: PoolClient, companyId: string, d: DocumentSnapshot, contactId: string | null, opts: { silent?: boolean } = {}): Promise<{ row: AgreementRow; events: EventRow[] }> {
  const existing = await one<AgreementRow>(c, "select * from agreements where company_id=$1 and external_id=$2", [companyId, d.id]);
  const signedAt = isSigned(d.status) ? new Date(d.signedAt ?? d.updatedAt ?? d.createdAt) : null;
  const events: EventRow[] = [];
  let row: AgreementRow;
  if (!existing) {
    row = (await one<AgreementRow>(c, `insert into agreements (company_id, contact_id, external_id, name, status, sent_at, signed_at, raw) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [companyId, contactId, d.id, d.name ?? null, d.status, new Date(d.createdAt), signedAt, d.raw ?? {}]))!;
    if (!opts.silent && contactId) events.push(await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "agreement.sent", source: "ghl_poll", occurred_at: row.sent_at, data: facts(row) }));
  } else {
    row = (await one<AgreementRow>(c, `update agreements set status=$2, signed_at=coalesce(signed_at,$3), contact_id=coalesce(contact_id,$4), name=coalesce($5,name), raw=$6, updated_at=now() where id=$1 returning *`,
      [existing.id, d.status, signedAt, contactId, d.name ?? null, d.raw ?? existing.raw]))!;
  }
  // the one transition that matters: not signed → signed
  if (!existing?.signed_at && row.signed_at && !opts.silent && row.contact_id)
    events.push(await emitEvent(c, { company_id: companyId, contact_id: row.contact_id, opportunity_id: null, appointment_id: null, event_type: "agreement.signed", source: "ghl_poll", occurred_at: row.signed_at, data: facts(row) }));
  return { row, events };
}

/** A send_document step records what it just sent, so the poll's first sight of the document is not a second "sent". */
export async function recordSentByEngine(c: PoolClient, companyId: string, contactId: string, externalId: string, name: string | null): Promise<AgreementRow> {
  return (await one<AgreementRow>(c, `insert into agreements (company_id, contact_id, external_id, name, status, sent_at, sent_by) values ($1,$2,$3,$4,'sent',now(),'engine')
    on conflict (company_id, external_id) do update set contact_id=coalesce(agreements.contact_id, excluded.contact_id), sent_by='engine' returning *`, [companyId, contactId, externalId, name]))!;
}

export const facts = (r: AgreementRow) => ({ agreement_id: r.id, external_id: r.external_id, name: r.name, status: r.status, sent_at: r.sent_at.toISOString(), signed_at: r.signed_at?.toISOString() ?? null, signed: !!r.signed_at, sent_by: r.sent_by });
export const latestAgreement = (c: PoolClient, companyId: string, contactId: string) => one<AgreementRow>(c, "select * from agreements where company_id=$1 and contact_id=$2 order by (signed_at is not null) desc, sent_at desc limit 1", [companyId, contactId]);
export const companyAgreements = (c: PoolClient, companyId: string, limit = 50) => many<AgreementRow & { contact: string | null }>(c, "select a.*, nullif(trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')),'') as contact from agreements a left join contacts ct on ct.id=a.contact_id where a.company_id=$1 order by a.sent_at desc limit $2", [companyId, limit]);
