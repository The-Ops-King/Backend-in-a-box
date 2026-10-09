/** Phone calls the dialer logs (D28): every call is a ledger row, connected calls wait for their transcript, call.logged fires once, and a call never looks like a reply. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { pollAll } from "@/engine/poll";
import type { Adapters, CallMedia, ContactSnapshot, MessageSnapshot } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string;
let messages: MessageSnapshot[] = [];
const media = new Map<string, CallMedia>();
const contacts: ContactSnapshot[] = [{ id: "GC1", firstName: "Ana", tags: [], customFields: {}, dateUpdated: "2026-10-01T00:00:00Z", dateAdded: "2026-10-01T00:00:00Z" }];
const fake: Adapters = {
  read: { openCards: async () => [], contactsChangedSince: async (c) => (c.id === companyId ? contacts : []), inboundSince: async (c) => (c.id === companyId ? messages : []), callMedia: async (_c, id) => media.get(id) ?? { transcript: null }, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [],
    getContact: async (_c, id) => (id === "GC-NEW" ? { id, firstName: "Newly", tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() } : null), listUsers: async () => [{ id: "U9", name: "Lu Setter", email: "lu@x.com" }] },
  booking: { ghl: { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }, calendly: { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] } },
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "doc-x" }) },
  sender: { sendSms: async () => ({ externalId: "", accepted: true }), sendEmail: async () => ({ externalId: "", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "unclear", confidence: 0, distribution: {}, unclear: true }) },
  notifier: { post: async () => ({ ts: "1" }), lookupUserByEmail: async () => null, react: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString();
const call = (id: string, contactId: string, status: string, durationSec: number | undefined, minutesAgo: number, direction: "inbound" | "outbound" = "outbound"): MessageSnapshot =>
  ({ id, conversationId: `conv-${contactId}`, contactId, channel: "call", direction, status, dateAdded: ago(minutesAgo), call: { status, durationSec, userId: "U9" } });
const rows = () => asOperator((c) => many<{ external_id: string; transcript: unknown[] | null; url: string | null; raw: Record<string, unknown>; recorded_by_name: string | null; contact_id: string }>(c, "select external_id, transcript, url, raw, recorded_by_name, contact_id from recordings where company_id=$1 and provider='ghl' order by external_id", [companyId]));
const logged = () => asOperator((c) => many<{ data: Record<string, unknown> }>(c, "select data from events where company_id=$1 and event_type='call.logged' order by id", [companyId]));

describe.skipIf(!HAS_DB)("dialer calls in the recordings ledger", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='pc'");
      if (co) { for (const t of ["events", "recordings", "messages", "contact_identifiers", "contacts", "users", "bindings", "poll_cursors"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('PC','pc','UTC') returning id"))!.id;
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3)", [companyId, Buffer.from("LOC"), encrypt("p")]);
    });
  });
  it("baseline keeps the calls it finds and says nothing", async () => {
    messages = [call("c0", "GC1", "completed", 90, 600)];
    const r = await pollAll(fake);
    expect(r.calls).toBe(1); expect(r.eventsDispatched).toBe(0);
    const [c0] = await rows(); expect(c0.raw).toMatchObject({ kind: "phone", call_status: "connected", transcript_status: "none", baseline: true });
    expect(await logged()).toHaveLength(0);
  });
  it("a connected call waits for its transcript; a missed call settles at once; neither is a reply", async () => {
    messages = [call("c1", "GC1", "completed", 172, 3), call("c2", "GC1", "no-answer", undefined, 2, "inbound")];
    await pollAll(fake);
    const byId = Object.fromEntries((await rows()).map((r) => [r.external_id, r]));
    expect(byId.c1.raw).toMatchObject({ transcript_status: "pending", duration_sec: 172 }); expect(byId.c1.recorded_by_name).toBe("Lu Setter");
    expect(byId.c2.raw).toMatchObject({ transcript_status: "none", call_status: "no_answer", direction: "inbound" });
    const ev = await logged(); expect(ev).toHaveLength(1); expect(ev[0].data).toMatchObject({ external_id: "c2", kind: "phone", connected: false, has_transcript: false });
    expect(await asOperator((c) => many(c, "select 1 from messages where company_id=$1", [companyId]))).toHaveLength(0);
    expect(await asOperator((c) => many(c, "select 1 from events where company_id=$1 and event_type='message.received'", [companyId]))).toHaveLength(0);
    // nothing new on the next tick: still pending, no second event
    await pollAll(fake); expect(await logged()).toHaveLength(1);
    // the transcript lands → settled once, with the recording link
    media.set("c1", { recordingUrl: "https://ghl.test/c1/recording", transcript: [{ speaker: "0", text: "Hey Ana." }, { speaker: "1", text: "Hi." }] });
    await pollAll(fake);
    const c1 = (await rows()).find((r) => r.external_id === "c1")!;
    expect(c1.raw.transcript_status).toBe("ready"); expect(c1.transcript).toHaveLength(2); expect(c1.url).toBe("https://ghl.test/c1/recording");
    const ev2 = await logged(); expect(ev2).toHaveLength(2); expect(ev2[1].data).toMatchObject({ external_id: "c1", connected: true, has_transcript: true, duration_sec: 172, caller: "Lu Setter" });
    await pollAll(fake); expect(await logged()).toHaveLength(2);
  });
  it("a connected call nobody recorded settles without a transcript once the wait runs out", async () => {
    messages = [call("c3", "GC1", "completed", 100, 45)];
    await pollAll(fake);
    const c3 = (await rows()).find((r) => r.external_id === "c3")!;
    expect(c3.raw.transcript_status).toBe("none"); expect(c3.transcript).toBeNull();
    expect((await logged()).at(-1)!.data).toMatchObject({ external_id: "c3", connected: true, has_transcript: false });
  });
  it("a call to a lead the contacts poll has not seen yet pulls the contact first", async () => {
    messages = [call("c4", "GC-NEW", "completed", 65, 1)];
    await pollAll(fake);
    const c4 = (await rows()).find((r) => r.external_id === "c4")!;
    const contact = await asOperator((c) => one<{ ghl_contact_id: string }>(c, "select ghl_contact_id from contacts where id=$1", [c4.contact_id]));
    expect(contact?.ghl_contact_id).toBe("GC-NEW");
  });
});
