/**
 * D117: a company installed into a CRM location another business shares acts only on its own people: contacts GHL tags with
 * the company's scope tag, and anyone booked on its mapped calendars (tagged in GHL for them when writes are real). Everyone
 * else the location holds is never replicated, fetched, counted, matched to a payment, or the start of anything. A company
 * without a scope tag is untouched: every other test in the suite is that proof.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { loadCompany } from "@/engine/context";
import { pollCompany } from "@/engine/poll";
import { ledgerDrift } from "@/engine/ledger-drift";
import { getMetric } from "@/engine/metric-registry";
import { recordPayment } from "@/engine/payments";
import { paymentOf } from "@/engine/ghl-metrics";
import { fakeAdapters } from "@/engine/test-install";
import type { Adapters, AppointmentSnapshot, ContactSnapshot, DocumentSnapshot, MessageSnapshot } from "@/adapters/types";
import type { GhlReads } from "@/adapters/ghl/metrics";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "UTC";
const NOW = DateTime.now();
const iso = (d: DateTime) => d.toUTC().toISO()!;
const person = (id: string, tags: string[], o: Partial<ContactSnapshot> = {}): ContactSnapshot => ({ id, firstName: id, tags, customFields: {}, email: `${id.toLowerCase()}@x.com`, dateUpdated: iso(NOW), dateAdded: iso(NOW.minus({ hours: 2 })), ...o });

// GHL as the location holds it: the offer's tagged lead, the other business's contacts, bookers who are not tagged
const crm = new Map<string, ContactSnapshot>([["T1", person("T1", ["dating"])], ["U1", person("U1", ["hair-client"])], ["B1", person("B1", [])], ["B2", person("B2", [])], ["U5", person("U5", ["hair-client"])]]);
let updated: ContactSnapshot[] = [], messages: MessageSnapshot[] = [], docs: DocumentSnapshot[] = [], appts: AppointmentSnapshot[] = [];
const searched: (string | undefined)[] = [], fetched: string[] = [], tagged: { id: string; tag: string }[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base,
  read: { ...base.read, contactsChangedSince: async (_c, _since, tag) => { searched.push(tag); return updated; },   // the fake lets everyone through: the engine holds the line too
    inboundSince: async () => messages, documents: async () => docs, callMedia: async () => ({ transcript: null }),
    getContact: async (_c, id) => { fetched.push(id); return crm.get(id) ?? null; } },
  booking: { ...base.booking, ghl: { ...base.booking.ghl, appointmentsInWindow: async (_c, cal) => appts.filter((a) => a.calendarId === cal), listCalendars: async () => [{ id: "CAL", name: "Dating discovery", teamMemberIds: [] }] } },
  write: { ...base.write, addTag: async (_c, id, tag) => { tagged.push({ id, tag }); } },
};
const call = (id: string, contactId: string): MessageSnapshot => ({ id, conversationId: `conv-${contactId}`, contactId, channel: "call", direction: "outbound", status: "no-answer", dateAdded: iso(NOW.minus({ minutes: 1 })), call: { status: "no-answer" } });
const booking = (id: string, contactId: string): AppointmentSnapshot => ({ id, calendarId: "CAL", contactId, startTime: iso(NOW.plus({ days: 1 })), endTime: iso(NOW.plus({ days: 1, minutes: 30 })), status: "confirmed", dateAdded: iso(NOW), raw: {} });

let companyId: string;
const poll = () => pollCompany(fake, companyId);
const contactOf = async (ghl: string) => (await asOperator((c) => one<{ id: string; tags: string[] }>(c, "select id, tags from contacts where company_id=$1 and ghl_contact_id=$2", [companyId, ghl]))) ?? null;
const events = (type: string) => asOperator((c) => many<{ contact_id: string | null; data: Record<string, unknown> }>(c, "select contact_id, data from events where company_id=$1 and event_type=$2 order by id", [companyId, type]));

describe.skipIf(!process.env.DATABASE_URL)("a company's scope tag (D117)", () => {
  beforeAll(async () => {
    await migrate();
    const slug = `scope-${Date.now()}`;
    companyId = (await installCompany({ name: "Dating", slug, timezone: TZ, locationId: "LOC", pit: "pit", calendars: { CAL: "first_call" }, scopeTag: " Dating " }, fake)).companyId;
    await asOperator(async (c) => {
      // never picked up by another test's pollAll; New lead on, so "starts nothing" is a run that did not start
      await c.query("update companies set status='onboarding' where id=$1", [companyId]);
      await c.query("update workflows w set enabled=true from workflow_templates t where t.id=w.template_id and w.company_id=$1 and t.slug='new-lead'", [companyId]);
    });
    await poll();   // the silent baseline of every entity
  }, 60_000);
  afterAll(async () => { if (companyId) await asOperator((c) => c.query("update runs set status='exited', next_run_at=null where company_id=$1", [companyId])); });

  it("the install key binds the tag as GHL spells tags (lowercase); the poll asks the CRM's search for it", async () => {
    expect((await asOperator((c) => one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='scope.tag'", [companyId])))!.value.toString()).toBe("dating");
    expect(searched.at(-1)).toBe("dating");
  });

  it("an untagged contact GHL updates is not ingested and starts nothing; a tagged one is a lead", async () => {
    updated = [crm.get("U1")!, crm.get("T1")!];
    await poll();
    expect(await contactOf("U1")).toBeNull();
    const t1 = await contactOf("T1"); expect(t1).not.toBeNull();
    expect((await events("lead.created")).map((e) => e.contact_id)).toEqual([t1!.id]);
    expect(await asOperator((c) => many<{ contact_id: string }>(c, "select contact_id from runs where company_id=$1", [companyId]))).toEqual([{ contact_id: t1!.id }]);
    updated = [];
  });

  it("an untagged booker on a mapped calendar is in scope; in shadow the tag is only what would have been written", async () => {
    appts = [booking("A1", "B1")];
    await poll();
    const b1 = await contactOf("B1"); expect(b1).not.toBeNull();
    expect((await events("appointment.booked")).map((e) => e.contact_id)).toEqual([b1!.id]);
    expect(tagged).toEqual([]);
    expect(b1!.tags).toEqual([]);   // neither GHL nor the replica: the next poll must not see a phantom removal
    expect((await events("tag.added")).filter((e) => e.contact_id === b1!.id).map((e) => e.data)).toEqual([{ tag: "dating", ghost: true, by: "scope" }]);
  });

  it("when writes are real the booker is tagged in GHL and on the replica", async () => {
    await asOperator((c) => c.query("update companies set mode='live' where id=$1", [companyId]));
    try {
      appts = [booking("A1", "B1"), booking("A2", "B2")];
      await poll();
      expect(tagged).toEqual([{ id: "B2", tag: "dating" }]);
      expect((await contactOf("B2"))!.tags).toEqual(["dating"]);
    } finally { await asOperator((c) => c.query("update companies set mode='ghost' where id=$1", [companyId])); }
  });

  it("a dialer call with someone out of scope is ignored: nobody is fetched or created, no call row", async () => {
    // O1: in the replica (from before) but neither tagged nor booked
    await asOperator((c) => c.query("insert into contacts (company_id, ghl_contact_id, first_name, timezone, tags) values ($1,'O1','Other',$2,'{}')", [companyId, TZ]));
    fetched.length = 0;
    messages = [call("m-u5", "U5"), call("m-o1", "O1"), call("m-t1", "T1"), call("m-b1", "B1")];
    await poll();
    expect(fetched).not.toContain("U5"); expect(fetched).not.toContain("O1"); expect(fetched).not.toContain("B1");   // a booker needs no read
    expect(await contactOf("U5")).toBeNull();
    const rows = await asOperator((c) => many<{ external_id: string }>(c, "select external_id from recordings where company_id=$1 and provider='ghl' order by external_id", [companyId]));
    expect(rows.map((r) => r.external_id)).toEqual(["m-b1", "m-t1"]);
    messages = [];
  });

  it("the tag taken off in GHL: out of scope, nothing new starts, nothing deleted", async () => {
    crm.set("T1", person("T1", ["nurture"]));
    messages = [{ id: "sms-t1", conversationId: "conv-T1", contactId: "T1", channel: "sms", direction: "inbound", body: "hi", dateAdded: iso(NOW) }];
    await poll();
    const t1 = (await contactOf("T1"))!;
    expect(t1.tags).toEqual(["nurture"]);
    expect(await events("message.received")).toEqual([]);
    expect((await events("scope.left")).map((e) => e.contact_id)).toEqual([t1.id]);
    expect(await asOperator((c) => one(c, "select 1 from runs where company_id=$1 and contact_id=$2", [companyId, t1.id]))).not.toBeNull();
    messages = [];
  });

  it("a document signed by someone out of scope is mirrored but says nothing", async () => {
    docs = [{ id: "D-O1", status: "completed", contactId: "O1", createdAt: iso(NOW.minus({ hours: 1 })), signedAt: iso(NOW) }, { id: "D-B1", status: "completed", contactId: "B1", createdAt: iso(NOW.minus({ hours: 1 })), signedAt: iso(NOW) }];
    await poll();
    const b1 = (await contactOf("B1"))!;
    expect((await events("agreement.signed")).map((e) => e.contact_id)).toEqual([b1.id]);
    expect(await asOperator((c) => one<{ contact_id: string | null }>(c, "select contact_id from agreements where company_id=$1 and external_id='D-O1'", [companyId]))).toEqual({ contact_id: null });
    docs = [];
  });

  const reads = (added: ContactSnapshot[]): GhlReads => ({ contactsAdded: async () => added, wonCards: async () => [], objectRecords: async () => [], getContact: async (_c, id) => crm.get(id) ?? null, fieldCatalog: async () => [], recordContact: async () => null, cards: async () => [], pipelines: async () => [], users: async () => [] });

  it("the drift sweep pulls in only the tagged contacts GHL added; the location's others are no drift", async () => {
    const added = [person("U2", []), person("T2", ["dating"])];
    await asOperator(async (c) => { const { row, adapterCompany, bindings } = await loadCompany(c, companyId); await ledgerDrift(c, row, adapterCompany, bindings, reads(added), fake, undefined, NOW); });
    expect(await contactOf("U2")).toBeNull();
    expect(await contactOf("T2")).not.toBeNull();
  });

  it("leads count only the tagged and the bookers", async () => {
    const from = NOW.minus({ days: 1 }).toISODate()!, to = NOW.toISODate()!;
    const added = [person("T3", ["dating"]), person("U3", ["hair-client"]), crm.get("B1")!, person("U4", [])];
    const r = await asOperator((c) => getMetric(c, companyId, { metric: "leads", period: { from, to, label: "since yesterday", name: "since yesterday" }, now: NOW.toJSDate() }, reads(added)));
    expect(r.value).toBe(2);
  });

  it("a payment whose email names someone out of scope links nobody; a booker's links", async () => {
    await asOperator((c) => c.query("insert into contact_identifiers (company_id, contact_id, kind, value) select $1, id, 'email', 'o1@x.com' from contacts where company_id=$1 and ghl_contact_id='O1'", [companyId]));
    const pay = (id: string, email: string) => asOperator((c) => recordPayment(c, companyId, { providerPaymentId: id, amount: 500, status: "succeeded", paidAt: new Date(), email }));
    expect((await pay("P-O1", "o1@x.com")).outcome).toBe("unlinked");
    expect((await pay("P-B1", "b1@x.com")).outcome).toBe("linked");
  });
});

describe("money read back from GHL (D116 hardening)", () => {
  it("a Payment record's amount counts whether it is a number, text, or GHL's { currency, value }", () => {
    const rec = (amount: unknown) => paymentOf({ id: "r", createdAt: "2026-10-01T00:00:00Z", properties: { amount, status: "succeeded", type: "payment", contact_id: "C" } }, TZ);
    expect(rec({ currency: "default", value: 1500 }).amount).toBe(1500);
    expect(rec({ currency: "USD", value: "2,500.50" }).amount).toBe(2500.5);
    expect(rec(-300).flow).toBe("out");
    expect(rec("$1,000").amount).toBe(1000);
  });
});
