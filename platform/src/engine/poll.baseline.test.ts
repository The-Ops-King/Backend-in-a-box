/** The first poll of a company must not dispatch events for everything that already exists (480 lead.created → speed-to-lead = 480 texts). */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, db, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { pollAll } from "@/engine/poll";
import type { Adapters, ContactSnapshot } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let contacts: ContactSnapshot[] = [];
let companyId: string;
const recordWrites: Record<string, unknown>[] = [];
const relations: string[] = [];
const fake: Adapters = {
  read: { openCards: async () => [], contactsChangedSince: async (c) => (c.id === companyId ? contacts : []), inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], getContact: async () => null, listUsers: async () => [] },
  booking: { ghl: { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }, calendly: { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] } },
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "task-x" }), createRecord: async (_c, _o, props) => { recordWrites.push({ op: "create", ...props }); return { id: `rec-${recordWrites.length}` }; }, updateRecord: async (_c, _o, id, props) => { recordWrites.push({ op: "update", id, ...props }); }, relateRecords: async (_c, a, f, s) => { relations.push(`${a}:${f}>${s}`); }, createOpportunity: async () => ({ id: "opp-x" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "doc-x" }) },
  sender: { sendSms: async () => ({ externalId: "", accepted: true }), sendEmail: async () => ({ externalId: "", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "unclear", confidence: 0, distribution: {}, unclear: true }) },
  notifier: { post: async () => ({ ts: "1" }), lookupUserByEmail: async () => null, react: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
const snap = (id: string, tags: string[], when: string): ContactSnapshot => ({ id, firstName: id, tags, customFields: {}, dateUpdated: when, dateAdded: when });

describe.skipIf(!HAS_DB)("first poll is a silent baseline", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='bl'");
      if (co) { for (const t of ["events", "contact_identifiers", "contacts", "bindings", "poll_cursors"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('BL','bl','UTC') returning id"))!.id;
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3)", [companyId, Buffer.from("L"), encrypt("p")]);
    });
  });
  it("baseline: 3 existing contacts → replica rows, zero events", async () => {
    contacts = [snap("a", ["lead"], "2026-10-01T00:00:00Z"), snap("b", ["lead", "vip"], "2026-10-02T00:00:00Z"), snap("c", [], "2026-10-03T00:00:00Z")];
    const r = await pollAll(fake);
    expect(r.contacts).toBe(3); expect(r.baselined).toBe(3); expect(r.eventsDispatched).toBe(0);
    expect(await asOperator((c) => many(c, "select 1 from contacts where company_id=$1", [companyId]))).toHaveLength(3);
    expect(await asOperator((c) => many(c, "select 1 from events where company_id=$1", [companyId]))).toHaveLength(0);
  });
  it("after baseline: only the delta becomes events (one new contact, one new tag)", async () => {
    contacts = [snap("b", ["lead", "vip", "hot"], "2026-10-04T00:00:00Z"), snap("d", ["lead"], "2026-10-05T00:00:00Z")];
    const r = await pollAll(fake);
    expect(r.baselined).toBe(0);
    const ev = await asOperator((c) => many<{ event_type: string; data: { tag?: string } }>(c, "select event_type, data from events where company_id=$1 order by id", [companyId]));
    expect(ev.map((e) => e.event_type + (e.data.tag ? ":" + e.data.tag : ""))).toEqual(["tag.added:hot", "lead.created", "tag.added:lead"]);
  });
});
