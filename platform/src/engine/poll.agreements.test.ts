/** D30: the CRM's documents mirrored into the agreements ledger; sent once, signed once, baseline silent. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { pollAll } from "@/engine/poll";
import type { Adapters, ContactSnapshot, DocumentSnapshot } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string;
let docs: DocumentSnapshot[] = [];
const contacts: ContactSnapshot[] = [{ id: "GA1", firstName: "Ada", tags: [], customFields: {}, dateUpdated: "2026-10-01T00:00:00Z", dateAdded: "2026-10-01T00:00:00Z" }];
const fake: Adapters = {
  read: { contactsChangedSince: async (c) => (c.id === companyId ? contacts : []), inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async (c) => (c.id === companyId ? docs : []), opportunitiesSince: async () => [], getContact: async () => null, listUsers: async () => [] },
  booking: { ghl: { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }, calendly: { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] } },
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "doc-x" }) },
  sender: { sendSms: async () => ({ externalId: "", accepted: true }), sendEmail: async () => ({ externalId: "", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "unclear", confidence: 0, distribution: {}, unclear: true }) },
  notifier: { post: async () => ({ ts: "1" }), lookupUserByEmail: async () => null, react: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
const events = () => asOperator((c) => many<{ event_type: string; data: Record<string, unknown> }>(c, "select event_type, data from events where company_id=$1 and event_type like 'agreement.%' order by id", [companyId]));

describe.skipIf(!HAS_DB)("agreements mirrored from the CRM's documents", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='ag'");
      if (co) { for (const t of ["poll_cursors", "wrapup_schedules", "rollups_daily", "sends", "events", "agreements", "contact_identifiers", "contacts", "bindings"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('AG','ag','UTC') returning id"))!.id;
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3)", [companyId, Buffer.from("L"), encrypt("p")]);
    });
  });
  it("baseline mirrors what exists and says nothing; a new document is 'sent'; its completion is 'signed' exactly once", async () => {
    docs = [{ id: "d0", name: "Purchase Agreement", status: "completed", contactId: "GA1", createdAt: "2026-10-01T10:00:00Z", signedAt: "2026-10-01T11:00:00Z" }];
    await pollAll(fake);
    expect(await events()).toEqual([]);
    expect(await asOperator((c) => one<{ status: string; signed_at: Date | null }>(c, "select status, signed_at from agreements where company_id=$1 and external_id='d0'", [companyId]))).toMatchObject({ status: "completed" });
    docs = [...docs, { id: "d1", name: "Purchase Agreement", status: "sent", contactId: "GA1", createdAt: "2026-10-06T10:00:00Z" }];
    await pollAll(fake);
    expect((await events()).map((e) => e.event_type)).toEqual(["agreement.sent"]);
    docs = docs.map((d) => (d.id === "d1" ? { ...d, status: "viewed" } : d));
    await pollAll(fake);
    expect((await events()).map((e) => e.event_type)).toEqual(["agreement.sent"]);   // viewed is not a fact anyone acts on
    docs = docs.map((d) => (d.id === "d1" ? { ...d, status: "completed", signedAt: "2026-10-06T12:00:00Z" } : d));
    await pollAll(fake); await pollAll(fake);
    const evs = await events();
    expect(evs.map((e) => e.event_type)).toEqual(["agreement.sent", "agreement.signed"]);
    expect(evs[1].data).toMatchObject({ external_id: "d1", signed: true, signed_at: "2026-10-06T12:00:00.000Z" });
  });
});
