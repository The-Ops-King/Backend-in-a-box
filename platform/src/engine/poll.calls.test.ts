/** Phone calls the dialer logs (D28): every call is a ledger row, connected calls wait for their transcript, call.logged fires once, and a call never looks like a reply. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { pollAll } from "@/engine/poll";
import { repairUnfinishedCalls } from "@/engine/call-repair";
import type { Adapters, CallMedia, ContactSnapshot, MessageSnapshot } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string;
let messages: MessageSnapshot[] = [];
const media = new Map<string, CallMedia>();
/** D275: the call as GHL has it now, read again for a call first seen while it was ringing */
const callNow = new Map<string, { status: string; durationSec?: number }>();
const contacts: ContactSnapshot[] = [{ id: "GC1", firstName: "Ana", tags: [], customFields: {}, dateUpdated: "2026-10-01T00:00:00Z", dateAdded: "2026-10-01T00:00:00Z" }];
const fake: Adapters = {
  read: { openCards: async () => [], contactsChangedSince: async (c) => (c.id === companyId ? contacts : []), inboundSince: async (c) => (c.id === companyId ? messages : []), messageBodies: async () => new Map(), callMedia: async (_c, id) => media.get(id) ?? { transcript: null }, callNow: async (_c, id) => callNow.get(id) ?? null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [],
    getContact: async (_c, id) => (id === "GC-NEW" ? { id, firstName: "Newly", tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() } : null), listUsers: async () => [{ id: "U9", name: "Lu Setter", email: "lu@x.com" }] },
  booking: { ghl: { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }, calendly: { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] } },
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "doc-x" }) },
  sender: { sendSms: async () => ({ externalId: "", accepted: true }), sendEmail: async () => ({ externalId: "", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "unclear", confidence: 0, distribution: {}, unclear: true }) },
  notifier: { post: async () => ({ ts: "1" }), lookupUserByEmail: async () => null, react: async () => true, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
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
    expect(c1.raw.transcript_status).toBe("ready"); expect(c1.transcript).toBeNull(); expect(c1.url).toBe("https://ghl.test/c1/recording");   // D87: GHL keeps the transcript; the row only says there is one
    const ev2 = await logged(); expect(ev2).toHaveLength(2); expect(ev2[1].data).toMatchObject({ external_id: "c1", connected: true, has_transcript: true, duration_sec: 172, caller: "Lu Setter" });
    await pollAll(fake); expect(await logged()).toHaveLength(2);
  });
  it("D87: a transcript is waited for, every minute, for two hours after hang-up (the company's setting), then the call settles without one", async () => {
    // 90 minutes after hang-up: still waited for, and settled the minute it lands
    messages = [call("c3", "GC1", "completed", 100, 92)];
    await pollAll(fake);
    expect((await rows()).find((r) => r.external_id === "c3")!.raw.transcript_status).toBe("pending");
    media.set("c3", { transcript: [{ speaker: "0", text: "Sorry, the transcript took its time." }] });
    await pollAll(fake);
    const c3 = (await rows()).find((r) => r.external_id === "c3")!;
    expect(c3.raw.transcript_status).toBe("ready"); expect(c3.transcript).toBeNull();
    expect((await logged()).at(-1)!.data).toMatchObject({ external_id: "c3", connected: true, has_transcript: true });
    // more than two hours after hang-up: settled without one
    messages = [call("c3b", "GC1", "completed", 100, 125)];
    await pollAll(fake);
    const c3b = (await rows()).find((r) => r.external_id === "c3b")!;
    expect(c3b.raw.transcript_status).toBe("none"); expect(c3b.transcript).toBeNull();
    expect((await logged()).at(-1)!.data).toMatchObject({ external_id: "c3b", connected: true, has_transcript: false });
    // the wait is the company's: thirty minutes, and a call 45 minutes old settles without one
    await asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,'calls.transcript_wait_min','text',$2)", [companyId, Buffer.from("30")]));
    try {
      messages = [call("c3c", "GC1", "completed", 100, 45)];
      await pollAll(fake);
      expect((await rows()).find((r) => r.external_id === "c3c")!.raw.transcript_status).toBe("none");
    } finally { await asOperator((c) => c.query("delete from bindings where company_id=$1 and key='calls.transcript_wait_min'", [companyId])); }
  });
  it("D87: a 0-second connect is no call: not connected, nothing to wait for, never a part of one", async () => {
    messages = [call("c0s", "GC1", "completed", 0, 3)];
    await pollAll(fake);
    const z = (await rows()).find((r) => r.external_id === "c0s")!;
    expect(z.raw).toMatchObject({ call_status: "zero_seconds", transcript_status: "none", duration_sec: 0 });
    expect((await logged()).at(-1)!.data).toMatchObject({ external_id: "c0s", connected: false, has_transcript: false });
  });
  it("a call to a lead the contacts poll has not seen yet pulls the contact first", async () => {
    messages = [call("c4", "GC-NEW", "completed", 65, 1)];
    await pollAll(fake);
    const c4 = (await rows()).find((r) => r.external_id === "c4")!;
    const contact = await asOperator((c) => one<{ ghl_contact_id: string }>(c, "select ghl_contact_id from contacts where id=$1", [c4.contact_id]));
    expect(contact?.ghl_contact_id).toBe("GC-NEW");
  });
  it("D275: a call first seen still ringing is read again each tick until GHL has its end, then settles as any call does: connected, its length, its transcript, call.logged once", async () => {
    messages = [call("c5", "GC1", "ringing", undefined, 1)];
    const before = (await logged()).length;
    await pollAll(fake);
    expect((await rows()).find((r) => r.external_id === "c5")!.raw).toMatchObject({ call_status: "ringing", transcript_status: "unfinished" });
    expect(await logged()).toHaveLength(before);   // nothing yet: the call has not ended
    await pollAll(fake); expect(await logged()).toHaveLength(before);   // GHL still says nothing new
    callNow.set("c5", { status: "completed", durationSec: 412 });
    media.set("c5", { recordingUrl: "https://ghl.test/c5", transcript: [{ speaker: "0", text: "Hi Ana, thanks for picking up." }] });
    await pollAll(fake);
    expect((await rows()).find((r) => r.external_id === "c5")!.raw).toMatchObject({ call_status: "connected", duration_sec: 412, transcript_status: "ready", finished_late: true });
    expect((await logged()).at(-1)!.data).toMatchObject({ external_id: "c5", connected: true, has_transcript: true, duration_sec: 412 });
    await pollAll(fake); expect((await logged()).filter((e) => e.data.external_id === "c5")).toHaveLength(1);
  });
  it("D275: a ringing call GHL never finishes is settled as it stands once the company's wait has passed, so nothing waits for ever", async () => {
    messages = [call("c6", "GC1", "ringing", undefined, 130)];
    await pollAll(fake);
    expect((await rows()).find((r) => r.external_id === "c6")!.raw).toMatchObject({ call_status: "ringing", transcript_status: "none" });
    expect((await logged()).at(-1)!.data).toMatchObject({ external_id: "c6", connected: false });
  });
  it("D275: the calls left ringing before the fix are read again and corrected silently: dry run first, then the row, no event, audited", async () => {
    const stuck = await asOperator(async (c) => (await one<{ id: string }>(c, `insert into recordings (company_id, contact_id, provider, external_id, title, started_at, ended_at, duration_min, invitees, link_status, raw)
      select $1, id, 'ghl', 'old1', 'Outbound call · ringing', now() - interval '3 days', now() - interval '3 days', 0, '[]', 'linked', '{"kind":"phone","direction":"outbound","call_status":"ringing","duration_sec":0,"transcript_status":"none"}' from contacts where company_id=$1 and ghl_contact_id='GC1' returning id`, [companyId]))!.id);
    callNow.set("old1", { status: "completed", durationSec: 305 });
    media.set("old1", { transcript: [{ speaker: "0", text: "Old call." }] });
    const events = (await logged()).length;
    const dry = await asOperator((c) => repairUnfinishedCalls(c, fake, { company: "pc", why: "test", dryRun: true }));
    expect(dry).toMatchObject({ ok: true, dryRun: true, repaired: [expect.objectContaining({ id: stuck, was: "ringing", now: "connected", duration_sec: 305 })] });
    expect((await rows()).find((r) => r.external_id === "old1")!.raw.call_status).toBe("ringing");
    const done = await asOperator((c) => repairUnfinishedCalls(c, fake, { company: "pc", why: "test", dryRun: false }));
    expect(done).toMatchObject({ ok: true, dryRun: false, repaired: [expect.objectContaining({ id: stuck, transcript: true })] });
    expect((await rows()).find((r) => r.external_id === "old1")!.raw).toMatchObject({ call_status: "connected", duration_sec: 305, transcript_status: "ready", repaired: "D275" });
    expect(await logged()).toHaveLength(events);
    expect(await asOperator((c) => one(c, "select 1 from audit_log where company_id=$1 and action='calls.repaired'", [companyId]))).toBeTruthy();
  });
});
