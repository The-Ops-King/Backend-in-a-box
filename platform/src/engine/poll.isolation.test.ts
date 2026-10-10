/** A SQL error in one entity must not poison the others ("current transaction is aborted") or undo their work. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { pollAll } from "@/engine/poll";
import type { Adapters, ContactSnapshot } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string;
let contacts: ContactSnapshot[] = [];
let inboundThrows = false;
const recordWrites: Record<string, unknown>[] = [];
const relations: string[] = [];
const fake: Adapters = {
  read: {
    openCards: async () => [], contactsChangedSince: async (c) => (c.id === companyId ? contacts : []),
    inboundSince: async () => { if (inboundThrows) throw new Error("ghl 500"); return []; }, callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [],
    opportunitiesSince: async () => [], pipelineCards: async () => [], getContact: async () => null, listUsers: async () => [],
  },
  booking: { ghl: { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }, calendly: { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] } },
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "task-x" }), createRecord: async (_c, _o, props) => { recordWrites.push({ op: "create", ...props }); return { id: `rec-${recordWrites.length}` }; }, updateRecord: async (_c, _o, id, props) => { recordWrites.push({ op: "update", id, ...props }); }, relateRecords: async (_c, a, f, s) => { relations.push(`${a}:${f}>${s}`); }, createOpportunity: async () => ({ id: "opp-x" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "doc-x" }) },
  sender: { sendSms: async () => ({ externalId: "", accepted: true }), sendEmail: async () => ({ externalId: "", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "unclear", confidence: 0, distribution: {}, unclear: true }) },
  notifier: { post: async () => ({ ts: "1" }), lookupUserByEmail: async () => null, react: async () => true, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
const snap = (id: string, when: string): ContactSnapshot => ({ id, firstName: id, tags: [], customFields: {}, dateUpdated: when, dateAdded: when });

describe.skipIf(!process.env.DATABASE_URL)("poll entity isolation", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='iso'");
      if (co) { for (const t of ["events", "contact_identifiers", "contacts", "bindings", "poll_cursors", "calendars"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('ISO','iso','UTC') returning id"))!.id;
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3)", [companyId, Buffer.from("L"), encrypt("p")]);
    });
  });
  it("a SQL error inside contacts rolls back only contacts; the other entities commit and the failure is counted, not 25P02", async () => {
    contacts = [snap("ok1", "2026-10-01T00:00:00Z"), snap("bad", "not-a-timestamp")];
    const r = await pollAll(fake);
    const err = r.errors.find((e) => e.company === "iso" && e.entity === "contacts");
    expect(err, "contacts error recorded").toBeTruthy();
    expect(err!.error).not.toMatch(/transaction is aborted/);
    expect(r.contacts).toBe(0);   // the rollback undid ok1, so the report must not claim it (other test companies return no contacts)
    expect(await asOperator((c) => many(c, "select 1 from contacts where company_id=$1", [companyId]))).toHaveLength(0);
    const cursors = await asOperator((c) => many<{ entity: string; consecutive_failures: number }>(c, "select entity, consecutive_failures from poll_cursors where company_id=$1 order by 1", [companyId]));
    expect(cursors.map((x) => x.entity)).toEqual(["agreements", "conversations"]);   // failure creates no contacts row (baseline not over); conversations committed on its own
  });
  it("a vendor error in conversations after a good contacts poll keeps the contacts commit and counts the failure", async () => {
    contacts = [snap("ok1", "2026-10-01T00:00:00Z")];
    inboundThrows = true;
    const r = await pollAll(fake);
    inboundThrows = false;
    expect(r.errors.filter((e) => e.company === "iso").map((e) => e.entity)).toEqual(["conversations"]);
    expect(await asOperator((c) => many(c, "select 1 from contacts where company_id=$1", [companyId]))).toHaveLength(1);
    const conv = await asOperator((c) => one<{ consecutive_failures: number }>(c, "select consecutive_failures from poll_cursors where company_id=$1 and entity='conversations'", [companyId]));
    expect(conv!.consecutive_failures).toBe(1);
  });
});
