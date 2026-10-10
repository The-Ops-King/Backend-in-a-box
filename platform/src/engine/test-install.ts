import type { Adapters, BookingRead, ContactSnapshot } from "@/adapters/types";
import type { PoolClient } from "pg";
import { asOperator, currentClient, one } from "@/db/client";
import { templates } from "@/templates";
import { parseDefinition, extractManifest, type Definition } from "./definition";
import { syncTriggers } from "./install";

/** Tests: put one shipped template on a company the way install does (a version, its triggers), optionally changed first (a node's settings, a schedule time). */
export async function installTemplateForTest(c: PoolClient, companyId: string, slug: string, opts: { enabled?: boolean; patch?: (def: Definition) => void } = {}): Promise<string> {
  const t = templates.find((x) => x.slug === slug); if (!t) throw new Error(`no template ${slug}`);
  const def = parseDefinition(JSON.parse(JSON.stringify(t.definition)));
  opts.patch?.(def);
  const parsed = parseDefinition(def);
  const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,$2,$3,$4) returning id", [companyId, t.name, parsed.reentry, opts.enabled ?? true]))!;
  await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'test')", [wf.id, parsed, extractManifest(parsed)]);
  await syncTriggers(c, companyId, wf.id, parsed);
  return wf.id;
}

/** Tests: health probes that never touch a vendor; every calendar has a dozen slots, every key answers. */
export const fakeProbes: import("./health").HealthProbes = {
  ghlLocationOk: async () => ({ ok: true, name: "Test Co" }),
  ghlFreeSlots: async (_p, _cal, from) => ({ ok: true, slots: 12, times: Array.from({ length: 12 }, (_, i) => new Date(from.getTime() + (i % 6) * 864e5 + (9 + Math.floor(i / 6)) * 36e5).toISOString()) }),
  ghlCatalog: async () => ({ users: [], pipelines: [], contactFields: [], opportunityFields: [], associations: [], objects: [], tags: [], errors: [] }),
  ghlCalendarTeam: async () => ({ ok: true, userIds: ["U-HOST"] }),
  calendlyWhoAmI: async () => ({ user: "u", organization: "o", email: "host@test", name: "Host" }), calendlyAvailableTimes: async () => ({ ok: true, slots: 12, times: [] }),
  calendlyEventTypeHosts: async () => ({ ok: true, duration: 45, hosts: [{ uri: "u", email: "host@test", name: "Host" }] }), calendlyEventTypeSchedules: async () => ({ ok: true, schedules: [] }), calendlyBusyTimes: async () => ({ ok: true, busy: [] }),
  whopPing: async () => true, whopGetWebhook: async () => ({ ok: true, found: true, enabled: true }), fathomPing: async () => true, fathomListWebhooks: async () => null, anthropicPing: async () => ({ ok: true }), urlOk: async () => ({ ok: true, status: 200 }),
};

/**
 * Tests: what the CRM "has" for a contact when a fixture holds no CRM of its own — the replica echoed back as a snapshot
 * (D68 reads the contact before every run; a fake that answered null would mark every test contact gone). A current
 * identifier counts as the person's id too (D60); an id the engine never saw is a 404 (null).
 */
export async function replicaSnapshot(companyId: string, ghlId: string): Promise<ContactSnapshot | null> {
  type Row = { first_name: string | null; last_name: string | null; timezone: string | null; tags: string[]; ghl_fields: Record<string, unknown>; attribution: ContactSnapshot["attribution"] | null; assigned_ghl_user_id: string | null; ghl_updated_at: Date | null; ghl_added_at: Date | null; created_at: Date; phone: string | null; email: string | null };
  // on the transaction already open when there is one: a second connection mid-transaction queues behind any lock waiting on the first (a concurrent migrate's alter table wedged the shared test database that way)
  const cur = currentClient();
  const ct = await (cur ? (fn: (c: PoolClient) => Promise<Row | undefined>) => fn(cur) : asOperator<Row | undefined>)((c) => one<Row>(c, `select ct.first_name, ct.last_name, ct.timezone, ct.tags, ct.ghl_fields, ct.attribution, ct.assigned_ghl_user_id, ct.ghl_updated_at, ct.ghl_added_at, ct.created_at,
      (select value from contact_identifiers i where i.contact_id=ct.id and i.kind='phone' and i.retired_at is null order by i.created_at limit 1) as phone,
      (select value from contact_identifiers i where i.contact_id=ct.id and i.kind='email' and i.retired_at is null order by i.created_at limit 1) as email
    from contacts ct where ct.company_id=$1 and ct.merged_into is null
      and (ct.ghl_contact_id=$2 or exists (select 1 from contact_identifiers i where i.contact_id=ct.id and i.kind='ghl_contact' and i.value=$2 and i.retired_at is null)) limit 1`, [companyId, ghlId]));
  if (!ct) return null;
  return { id: ghlId, firstName: ct.first_name ?? undefined, lastName: ct.last_name ?? undefined, email: ct.email ?? undefined, phone: ct.phone ?? undefined, timezone: ct.timezone ?? undefined, assignedTo: ct.assigned_ghl_user_id ?? undefined,
    tags: ct.tags, customFields: ct.ghl_fields, dateUpdated: (ct.ghl_updated_at ?? new Date()).toISOString(), dateAdded: (ct.ghl_added_at ?? ct.created_at).toISOString(), ...(ct.attribution && Object.keys(ct.attribution).length ? { attribution: ct.attribution } : {}) };
}

/** Tests: adapters that never touch a vendor; every send is accepted, every classify answers "confirmed". `crm`: the fixture's own CRM (an id it lacks is a 404); without one, `getContact` echoes the replica. */
export const fakeAdapters = (opts: { crm?: Map<string, ContactSnapshot> } = {}): Adapters => ({
  read: { contactsChangedSince: async () => [], openCards: async () => [], inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [],
    getContact: async (c, id) => (opts.crm ? opts.crm.get(id) ?? null : replicaSnapshot(c.id, id)), listUsers: async () => [] },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [{ id: "CAL", name: "Closer", teamMemberIds: [] }] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "doc-x" }) },
  sender: { sendSms: async () => ({ externalId: "s", accepted: true }), sendEmail: async () => ({ externalId: "e", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "confirmed", confidence: 1, distribution: {}, unclear: false }) },
  notifier: { post: async () => ({ ts: "1" }), lookupUserByEmail: async () => null, react: async () => true, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
});
