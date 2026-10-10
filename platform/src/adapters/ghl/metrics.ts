import { ghl } from "./client";
import { ghlRead, mapContact, type RawContact } from "./read";
import type { Company, ContactSnapshot } from "../types";

/**
 * Live reads behind the bot's people and deal numbers (D73). The CRM is the truth for who arrived and who bought, so these
 * are read at answer time, never from the replica. Both walk every page and refuse to answer past their cap rather than
 * return a short count.
 */
const CONTACT_PAGE = 500;      // the advanced search's largest page
const CONTACT_PAGES = 40;
const OPP_PAGE = 100;          // the opportunities search's largest page
const OPP_PAGES = 50;
const OBJ_PAGE = 100;
const OBJ_PAGES = 100;

/**
 * `POST /contacts/search` (Version 2021-07-28): `filters:[{field:"dateAdded",operator:"range",value:{gte,lte}}]`, sorted by
 * dateAdded. Each contact in the answer carries `searchAfter` (its sort values); passing the last one back continues after
 * it, which unlike `page` is not capped at 10,000 results. `page` is the fallback when a record carries none.
 */
export async function ghlContactsAdded(c: Company, from: Date, to: Date): Promise<ContactSnapshot[]> {
  const out = new Map<string, ContactSnapshot>();
  let after: unknown[] | undefined, page = 1;
  for (let i = 0; i < CONTACT_PAGES; i++) {
    const body = { locationId: c.locationId, pageLimit: CONTACT_PAGE, filters: [{ field: "dateAdded", operator: "range", value: { gte: from.toISOString(), lte: to.toISOString() } }], sort: [{ field: "dateAdded", direction: "asc" }], ...(after ? { searchAfter: after } : { page }) };
    const r = await ghl<{ contacts?: (RawContact & { searchAfter?: unknown[] })[] }>(c.pit, "POST", "/contacts/search", { body });
    const got = r.contacts ?? [];
    for (const x of got) out.set(x.id, mapContact(x));
    if (got.length < CONTACT_PAGE) return [...out.values()];
    const last = got[got.length - 1].searchAfter;
    after = Array.isArray(last) && last.length ? last : undefined;
    page++;
  }
  throw new Error(`more than ${CONTACT_PAGE * CONTACT_PAGES} contacts in the window; not counted rather than cut short`);
}

/** A won card as the opportunities search returns it, with the contact it embeds (id, name, email, tags). */
export type GhlWonCard = { id: string; pipelineId: string; status: string; monetaryValue?: number; assignedTo?: string; wonAt: string; contactId: string; contactName?: string; contactEmail?: string; contactTags: string[] };
type RawOpp = { id: string; pipelineId: string; status: string; monetaryValue?: number; assignedTo?: string | null; lastStatusChangeAt?: string; lastStageChangeAt?: string; updatedAt: string; contactId?: string; contact?: { id?: string; name?: string; email?: string; tags?: string[] } };

/**
 * `GET /opportunities/search?location_id&pipeline_id&status=won` (snake_case params; 100 a page). The won time is
 * `lastStatusChangeAt` (when the status last moved, here to won); the stage stamp, then updatedAt, only when the CRM gives
 * none (the same order as the backfill's read).
 */
export async function ghlWonCards(c: Company, pipelineId: string): Promise<GhlWonCard[]> {
  const out = new Map<string, GhlWonCard>();
  for (let page = 1; page <= OPP_PAGES; page++) {
    const r = await ghl<{ opportunities?: RawOpp[] }>(c.pit, "GET", `/opportunities/search?location_id=${c.locationId}&pipeline_id=${encodeURIComponent(pipelineId)}&status=won&limit=${OPP_PAGE}&page=${page}`);
    const opps = r.opportunities ?? [];
    for (const o of opps) out.set(o.id, { id: o.id, pipelineId: o.pipelineId, status: o.status, monetaryValue: typeof o.monetaryValue === "number" ? o.monetaryValue : undefined, assignedTo: o.assignedTo ?? undefined,
      wonAt: o.lastStatusChangeAt ?? o.lastStageChangeAt ?? o.updatedAt, contactId: o.contact?.id ?? o.contactId ?? "", contactName: o.contact?.name, contactEmail: o.contact?.email, contactTags: o.contact?.tags ?? [] });
    if (opps.length < OPP_PAGE) return [...out.values()];
  }
  throw new Error(`more than ${OPP_PAGE * OPP_PAGES} won cards on the pipeline; not counted rather than cut short`);
}

/**
 * Every record of one custom object (`POST /objects/{key}/records/search`, Version 2021-07-28, `{locationId, page, pageLimit,
 * query}`). The search has no property filter, so the caller filters; each record carries `searchAfter`, passed back to continue.
 */
export type GhlObjectRecord = { id: string; createdAt: string; properties: Record<string, unknown> };
export async function ghlObjectRecords(c: Company, objectKey: string): Promise<GhlObjectRecord[]> {
  const out = new Map<string, GhlObjectRecord>();
  let after: unknown[] | undefined, page = 1;
  for (let i = 0; i < OBJ_PAGES; i++) {
    const body = { locationId: c.locationId, pageLimit: OBJ_PAGE, query: "", ...(after ? { searchAfter: after } : { page }) };
    const r = await ghl<{ records?: { id: string; createdAt: string; properties?: Record<string, unknown>; searchAfter?: unknown[] }[] }>(c.pit, "POST", `/objects/${encodeURIComponent(objectKey)}/records/search`, { body });
    const recs = r.records ?? [];
    for (const x of recs) out.set(x.id, { id: x.id, createdAt: x.createdAt, properties: x.properties ?? {} });
    if (recs.length < OBJ_PAGE) return [...out.values()];
    const last = recs[recs.length - 1].searchAfter;
    after = Array.isArray(last) && last.length ? last : undefined;
    page++;
  }
  throw new Error(`more than ${OBJ_PAGE * OBJ_PAGES} ${objectKey} records; not counted rather than cut short`);
}

/**
 * The fields people can ask about: the location's contact custom fields and every custom object's properties, with their
 * answer options. A contact's value is keyed by the field id; an object record's by the last segment of the field key, and
 * an option field holds the option key (shown by its label).
 */
export type GhlFieldDef = { object: string; objectLabel: string; id: string; key: string; prop: string; name: string; type: string; options: { key: string; label: string }[] };
export async function ghlFieldCatalog(c: Company): Promise<GhlFieldDef[]> {
  const out: GhlFieldDef[] = [];
  const cf = await ghl<{ customFields?: { id: string; name: string; fieldKey?: string; dataType?: string; picklistOptions?: unknown[] }[] }>(c.pit, "GET", `/locations/${c.locationId}/customFields?model=contact`);
  for (const f of cf.customFields ?? []) out.push({ object: "contact", objectLabel: "Contact", id: f.id, key: f.fieldKey ?? f.id, prop: f.id, name: f.name, type: f.dataType ?? "TEXT",
    options: (f.picklistOptions ?? []).map((o) => (typeof o === "string" ? { key: o, label: o } : { key: String((o as { key?: unknown }).key ?? ""), label: String((o as { label?: unknown }).label ?? (o as { key?: unknown }).key ?? "") })) });
  const objs = await ghl<{ objects?: { key: string; labels?: { singular?: string } }[] }>(c.pit, "GET", `/objects/?locationId=${c.locationId}`);
  for (const o of (objs.objects ?? []).filter((x) => x.key.startsWith("custom_objects."))) {
    const d = await ghl<{ fields?: { id: string; name: string; fieldKey: string; dataType?: string; options?: { key: string; label?: string }[] | null }[] }>(c.pit, "GET", `/objects/${o.key}?locationId=${c.locationId}&fetchProperties=true`);
    for (const f of d.fields ?? []) out.push({ object: o.key, objectLabel: o.labels?.singular ?? o.key, id: f.id, key: f.fieldKey, prop: f.fieldKey.split(".").pop()!, name: f.name, type: f.dataType ?? "TEXT",
      options: (f.options ?? []).map((x) => ({ key: x.key, label: x.label ?? x.key })) });
  }
  return out;
}

/** The contact a custom object record is associated with in GHL (the link the CRM itself shows), or null. */
export async function ghlRecordContact(c: Company, recordId: string): Promise<string | null> {
  const r = await ghl<{ relations?: { firstObjectKey: string; firstRecordId: string; secondObjectKey: string; secondRecordId: string }[] }>(c.pit, "GET", `/associations/relations/${recordId}?locationId=${c.locationId}`);
  const hit = (r.relations ?? []).find((x) => x.firstObjectKey === "contact" || x.secondObjectKey === "contact");
  return hit ? (hit.firstObjectKey === "contact" ? hit.firstRecordId : hit.secondRecordId) : null;
}

/** Every card on one pipeline, any status (`GET /opportunities/search?location_id&pipeline_id`, 100 a page): what the bot joins a person to (D75). */
export type GhlCard = { id: string; pipelineId: string; stageId: string; status: string; monetaryValue?: number; assignedTo?: string; contactId: string; contactName?: string; contactEmail?: string; contactTags: string[]; createdAt?: string; updatedAt: string; statusChangedAt: string };
export async function ghlCards(c: Company, pipelineId: string): Promise<GhlCard[]> {
  const out = new Map<string, GhlCard>();
  for (let page = 1; page <= OPP_PAGES; page++) {
    const r = await ghl<{ opportunities?: (RawOpp & { pipelineStageId?: string; createdAt?: string })[] }>(c.pit, "GET", `/opportunities/search?location_id=${c.locationId}&pipeline_id=${encodeURIComponent(pipelineId)}&limit=${OPP_PAGE}&page=${page}`);
    const opps = r.opportunities ?? [];
    for (const o of opps) out.set(o.id, { id: o.id, pipelineId: o.pipelineId, stageId: o.pipelineStageId ?? "", status: o.status, monetaryValue: typeof o.monetaryValue === "number" ? o.monetaryValue : undefined, assignedTo: o.assignedTo ?? undefined,
      contactId: o.contact?.id ?? o.contactId ?? "", contactName: o.contact?.name, contactEmail: o.contact?.email, contactTags: o.contact?.tags ?? [], createdAt: o.createdAt, updatedAt: o.updatedAt, statusChangedAt: o.lastStatusChangeAt ?? o.lastStageChangeAt ?? o.updatedAt });
    if (opps.length < OPP_PAGE) return [...out.values()];
  }
  throw new Error(`more than ${OPP_PAGE * OPP_PAGES} cards on the pipeline; not read rather than cut short`);
}

/** Stage ids to names: `GET /opportunities/pipelines?locationId`. */
export type GhlPipeline = { id: string; name: string; stages: { id: string; name: string }[] };
export async function ghlPipelines(c: Company): Promise<GhlPipeline[]> {
  const r = await ghl<{ pipelines?: { id: string; name: string; stages?: { id: string; name: string }[] }[] }>(c.pit, "GET", `/opportunities/pipelines?locationId=${c.locationId}`);
  return (r.pipelines ?? []).map((p) => ({ id: p.id, name: p.name, stages: (p.stages ?? []).map((s) => ({ id: s.id, name: s.name })) }));
}

/** User ids to names: `GET /users/?locationId`. */
export async function ghlUsers(c: Company): Promise<{ id: string; name: string }[]> {
  const r = await ghl<{ users?: { id: string; name?: string; firstName?: string; lastName?: string; email?: string }[] }>(c.pit, "GET", `/users/?locationId=${c.locationId}`);
  return (r.users ?? []).map((u) => ({ id: u.id, name: (u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim()) || u.email || u.id }));
}

/** What the metric layer and the drift check read from the CRM, injectable so tests never touch the network. */
export type GhlReads = {
  contactsAdded(c: Company, from: Date, to: Date): Promise<ContactSnapshot[]>;
  wonCards(c: Company, pipelineId: string): Promise<GhlWonCard[]>;
  objectRecords(c: Company, objectKey: string): Promise<GhlObjectRecord[]>;
  /** null when the CRM says the record is gone */
  getContact(c: Company, id: string): Promise<ContactSnapshot | null>;
  fieldCatalog(c: Company): Promise<GhlFieldDef[]>;
  recordContact(c: Company, recordId: string): Promise<string | null>;
  cards(c: Company, pipelineId: string): Promise<GhlCard[]>;
  pipelines(c: Company): Promise<GhlPipeline[]>;
  users(c: Company): Promise<{ id: string; name: string }[]>;
};
export const liveGhlReads: GhlReads = { contactsAdded: ghlContactsAdded, wonCards: ghlWonCards, objectRecords: ghlObjectRecords, getContact: (c, id) => ghlRead.getContact(c, id), fieldCatalog: ghlFieldCatalog, recordContact: ghlRecordContact, cards: ghlCards, pipelines: ghlPipelines, users: ghlUsers };
