/** D78: a person's lead source, read in one order everywhere, and captured from bookings by the engine (no Zap). */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { DateTime } from "luxon";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "./crypto";
import { installCompany } from "./install";
import { applyAppointment } from "./poll";
import { loadCompany } from "./context";
import { tick } from "./runner";
import { fakeAdapters, fakeProbes } from "./test-install";
import { getMetric, parsePeriod } from "./metric-registry";
import { planCommand, runCommand } from "./bot";
import { extractManifest, parseDefinition } from "./definition";
import { leadSource, type SourceFields } from "./lead-source";
import { mapAttribution, mapContact, type RawContact } from "@/adapters/ghl/read";
import { templates } from "@/templates";
import type { Adapters, AppointmentSnapshot, Attribution, ContactSnapshot } from "@/adapters/types";
import type { GhlReads } from "@/adapters/ghl/metrics";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";

describe("the source order (D78)", () => {
  const f: SourceFields = { leadSource: "F-LEAD", utmSource: "F-UTM" };
  const attribution: Attribution = { first: { utmSource: " FB ", medium: "form" }, last: { utmSource: "ig", medium: "zapier" } };
  it("the lead-source field first, as GHL has it, trimmed and lower-cased", () =>
    expect(leadSource({ fields: { "F-LEAD": " Instagram ", "F-UTM": "fb" }, attribution, bookingUtm: "google" }, f)).toBe("instagram"));
  it("then the contact's UTM Source field", () => expect(leadSource({ fields: { "F-LEAD": "  ", "F-UTM": "FB" }, attribution, bookingUtm: "google" }, f)).toBe("fb"));
  it("then GHL's first-touch attribution, then its latest touch", () => {
    expect(leadSource({ fields: {}, attribution, bookingUtm: "google" }, f)).toBe("fb");
    expect(leadSource({ fields: {}, attribution: { first: { medium: "manual" }, last: { utmSource: "IG" } }, bookingUtm: "google" }, f)).toBe("ig");
  });
  it("then the latest booking's UTM", () => expect(leadSource({ fields: {}, attribution: { first: { medium: "zapier" } }, bookingUtm: " Google " }, f)).toBe("google"));
  it("then how GHL says the record came in (its attribution medium)", () => expect(leadSource({ fields: {}, attribution: { first: { medium: "Manual" } }, bookingUtm: null }, f)).toBe("manual"));
  it("else unknown; an unbound field is not read", () => {
    expect(leadSource({ fields: {}, attribution: null, bookingUtm: null }, f)).toBe("unknown");
    expect(leadSource({ fields: { "F-LEAD": "instagram" } }, {})).toBe("unknown");
  });
  it("a multi-pick field reads as its answers joined", () => expect(leadSource({ fields: { "F-LEAD": ["Instagram", "Referral"] } }, f)).toBe("instagram, referral"));
});

describe("GHL's attribution on a contact (ghl/02-api-facts.md)", () => {
  const raw = (o: Partial<RawContact>): RawContact => ({ id: "C1", dateAdded: "2026-10-01T00:00:00Z", dateUpdated: "2026-10-01T00:00:00Z", ...o });
  it("attributionSource is the first touch and lastAttributionSource the latest; GHL's keys mapped, blanks dropped", () => {
    const a = mapAttribution(raw({
      attributionSource: { utmSource: "fb", utmMedium: "paid", campaign: "120249602961280685", utmContent: "1202496", utmKeyword: "kw", fbclid: "IwAR1", medium: "form", sessionSource: "Social media", url: "https://x.test/?utm_source=fb", referrer: null, fbp: "fb.1", ip: "1.2.3.4" },
      lastAttributionSource: { utmSource: "", medium: "zapier", sessionSource: "Third Party" } }));
    expect(a).toEqual({ first: { utmSource: "fb", utmMedium: "paid", utmCampaign: "120249602961280685", utmContent: "1202496", utmTerm: "kw", fbclid: "IwAR1", medium: "form", sessionSource: "Social media", url: "https://x.test/?utm_source=fb" },
      last: { medium: "zapier", sessionSource: "Third Party" } });
  });
  it("the list form (attributions, flagged isFirst / isLast) when only that is sent", () =>
    expect(mapAttribution(raw({ attributions: [{ utmSource: "ig", isFirst: true }, { utmSource: "fb", isLast: true }] }))).toEqual({ first: { utmSource: "ig" }, last: { utmSource: "fb" } }));
  it("no attribution: the snapshot carries none, and everything else maps as before", () => {
    expect(mapAttribution(raw({ attributionSource: {} }))).toBeUndefined();
    const k = mapContact(raw({ source: "Optin Form", tags: ["a"], customFields: [{ id: "F1", value: "x" }] }));
    expect(k).toEqual({ id: "C1", firstName: undefined, lastName: undefined, email: undefined, phone: undefined, timezone: undefined, assignedTo: undefined, tags: ["a"], source: "Optin Form", customFields: { F1: "x" }, dateAdded: "2026-10-01T00:00:00Z", dateUpdated: "2026-10-01T00:00:00Z" });
    expect(mapContact(raw({ attributionSource: { utmSource: "ig" } })).attribution).toEqual({ first: { utmSource: "ig" } });
  });
});

describe("Call booked's capture step", () => {
  const def = parseDefinition(templates.find((t) => t.slug === "call-booked")!.definition);
  it("the six UTM field bindings are optional (unbound: not written); the rest of the template's stay required", () => {
    const m = new Map(extractManifest(def).bindings.map((b) => [b.key, b.required]));
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"]) expect(m.get(`crm.field_contact_${k}`)).toBe(false);
    expect(m.get("crm.field_contact_appointment_date")).toBe(true);
    expect(m.get("crm.pipeline_closer")).toBe(true);
  });
});

// ---- through the engine ------------------------------------------------------------------------------------------------
const TABLES = ["alerts", "bot_threads", "eod_reports", "slack_posts", "agreements", "sends", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
const wipe = (slug: string) => asOperator(async (c) => {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
  await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
  await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
  await c.query("update appointments set disposition_id=null where company_id=$1", [co.id]);
  for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
  await c.query("delete from companies where id=$1", [co.id]);
});

const CRM = { pipeline_setter: "PIPE-SETTER", pipeline_closer: "PIPE-CLOSER", stage_setter_direct_booked: "STAGE-DIRECT", stage_setter_appointment_set: "STAGE-SET", stage_closer_scheduled: "STAGE-SCHED",
  field_contact_appointment_date: "CF-APPT-DATE", field_contact_setter: "CF-SETTER", field_opportunity_setter_owner: "CF-SETTER-OWNER", assoc_sales_call_contact: "ASSOC-SC", assoc_sales_call_opportunity: "ASSOC-SO",
  // four of the six bound; utm_content and utm_term are not
  field_contact_lead_source: "CF-LEAD", field_contact_utm_source: "CF-UTM-SRC", field_contact_utm_medium: "CF-UTM-MED", field_contact_utm_campaign: "CF-UTM-CMP", field_contact_fbclid: "CF-FBCLID" };
const TRACKING = { utm_source: "fb", utm_medium: "paid", utm_campaign: "120249602961280685", utm_content: "ad-7", utm_term: "hair", fbclid: "IwAR-1" };

const crm = new Map<string, ContactSnapshot>();
const writes: { id: string; fields: Record<string, string> }[] = [];
const posts: { channel: string; text: string }[] = [];
const appts = new Map<string, AppointmentSnapshot>();
const base = fakeAdapters({ crm });
const fake: Adapters = {
  ...base,
  read: { ...base.read, listUsers: async () => [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }] },
  booking: (() => { const b = { appointmentsInWindow: async () => [], listCalendars: async () => [{ id: "CAL", name: "Closer Call", teamMemberIds: ["U1"] }], getAppointment: async (_c: unknown, id: string) => appts.get(id) ?? null }; return { ghl: b, calendly: b }; })(),
  write: { ...base.write, updateContact: async (_c, id, patch) => {
    const fields = Object.fromEntries((patch.customFields ?? []).map((f) => [f.id, f.field_value]));
    writes.push({ id, fields });
    const k = crm.get(id); if (k) crm.set(id, { ...k, customFields: { ...k.customFields, ...fields }, dateUpdated: new Date().toISOString() });
  } },
  notifier: { ...base.notifier, post: async (_t, channel, text) => { posts.push({ channel, text }); return { ts: `ts${posts.length}` }; } },
};
let companyId: string;
const utmWrites = (ghl: string) => writes.filter((w) => w.id === ghl && Object.keys(w.fields).some((k) => k.startsWith("CF-UTM") || k === "CF-FBCLID")).map((w) => w.fields);
const person = (ghl: string, o: { tags?: string[]; fields?: Record<string, unknown>; attribution?: Attribution } = {}) => asOperator(async (c) => {
  const now = new Date().toISOString();
  crm.set(ghl, { id: ghl, firstName: ghl, tags: o.tags ?? [], customFields: o.fields ?? {}, dateAdded: now, dateUpdated: now, ...(o.attribution ? { attribution: o.attribution } : {}) });
  const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, timezone, tags, ghl_fields, attribution) values ($1,$2,$2,$3,$4,$5,$6) returning id", [companyId, ghl, TZ, o.tags ?? [], o.fields ?? {}, o.attribution ?? {}]))!.id;
  await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [companyId, id, `${ghl.toLowerCase()}@people.test`]);
  return id;
});
const book = async (id: string, ghl: string, tracking: Record<string, string> = TRACKING, kind: "booked" | "moved" = "booked") => {
  const start = DateTime.now().setZone(TZ).plus({ days: 3 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
  const s: AppointmentSnapshot = { id, calendarId: "CAL", contactId: ghl, assignedUserId: "U1", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), tracking, raw: {},
    ...(kind === "moved" ? { startTime: start.plus({ days: 1 }).toISO()!, endTime: start.plus({ days: 1, minutes: 45 }).toISO()!, dateUpdated: new Date().toISOString() } : {}) };
  appts.set(id, s);
  await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, s); });
  await tick(fake, undefined, companyId);
};
const captureStep = (ghl: string) => asOperator((c) => many<{ status: string; result: Record<string, unknown> }>(c, `select s.status, s.result from run_steps s join runs r on r.id=s.run_id join contacts ct on ct.id=r.contact_id
  where r.company_id=$1 and ct.ghl_contact_id=$2 and s.node_id='u1' order by s.started_at`, [companyId, ghl]));

describe.skipIf(!process.env.DATABASE_URL)("lead source through the engine (D78)", () => {
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    await wipe("lsrc"); await wipe("lsrc2");
    const r = await installCompany({ name: "Lead Source", slug: "lsrc", timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, enable: true, templates: ["call-booked"], crm: CRM, slack: { bookings: "CBOOK" }, mode: "test" }, fake);
    companyId = r.companyId;
    await asOperator(async (c) => {
      await c.query("update companies set send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, channels) values ($1,'T1',$2,'UBOT','{}')", [companyId, encrypt("xoxb-fake")]);
    });
  });
  beforeEach(() => { writes.length = 0; posts.length = 0; });

  it("a booking's UTMs go on the contact's empty UTM fields only: a filled one (the first touch) is kept, an unbound one is skipped; the card shows the person's source", async () => {
    const id = await person("LS1", { tags: ["sys-test"], fields: { "CF-UTM-SRC": "ig" } });
    await book("A-LS1", "LS1");
    expect(utmWrites("LS1")).toEqual([{ "CF-UTM-MED": "paid", "CF-UTM-CMP": "120249602961280685", "CF-FBCLID": "IwAR-1" }]);
    expect((await captureStep("LS1"))[0]).toMatchObject({ status: "ok", result: { already_set: ["CF-UTM-SRC"] } });
    expect(crm.get("LS1")!.customFields).toMatchObject({ "CF-UTM-SRC": "ig", "CF-UTM-MED": "paid" });
    // the replica learns the write, so the next read of the person agrees
    expect((await asOperator((c) => one<{ f: Record<string, string> }>(c, "select ghl_fields as f from contacts where id=$1", [id])))!.f).toMatchObject({ "CF-UTM-MED": "paid", "CF-FBCLID": "IwAR-1" });
    const card = posts.find((p) => p.channel === "CBOOK");
    expect(card?.text).toContain("*Source:* ig");
  });

  it("idempotent: a second booking (or a move) writes nothing once the CRM has every value, whatever its own UTMs say", async () => {
    await book("A-LS1b", "LS1", { utm_source: "google", utm_medium: "cpc", fbclid: "IwAR-2" });
    expect(utmWrites("LS1")).toEqual([]);
    const steps = await captureStep("LS1");
    expect(steps[steps.length - 1]).toMatchObject({ status: "skipped", result: { why: expect.stringMatching(/already has every value/) } });
    expect(crm.get("LS1")!.customFields).toMatchObject({ "CF-UTM-SRC": "ig", "CF-UTM-MED": "paid", "CF-FBCLID": "IwAR-1" });
  });

  it("test mode: a real contact is shadowed (what would be written is recorded, nothing reaches the CRM); a booking with no UTMs writes nothing", async () => {
    await person("LS2");
    await book("A-LS2", "LS2");
    expect(utmWrites("LS2")).toEqual([]);
    expect((await captureStep("LS2"))[0]).toMatchObject({ status: "ok", result: { shadow: true, would_update: { customFields: expect.arrayContaining([{ id: "CF-UTM-SRC", field_value: "fb" }]) } } });
    await person("LS3", { tags: ["sys-test"] });
    await book("A-LS3", "LS3", {});
    expect(utmWrites("LS3")).toEqual([]);
    expect((await captureStep("LS3"))[0]).toMatchObject({ status: "skipped" });
  });

  it("a contact with nothing filled gets all four bound fields from the booking", async () => {
    await person("LS4", { tags: ["sys-test"], attribution: { first: { utmSource: "ig", medium: "form" } } });
    await book("A-LS4", "LS4");
    expect(utmWrites("LS4")).toEqual([{ "CF-UTM-SRC": "fb", "CF-UTM-MED": "paid", "CF-UTM-CMP": "120249602961280685", "CF-FBCLID": "IwAR-1" }]);
  });

  describe("reading it back", () => {
    let co2: string;
    const NOW = DateTime.fromISO("2026-10-10T12:00:00", { zone: TZ });
    const period = parsePeriod("this month", TZ, NOW)!;
    const iso = (d: string) => DateTime.fromISO(d, { zone: TZ }).toUTC().toISO()!;
    // October's leads as GHL holds them: the lead-source field, the UTM field, GHL's attribution, nothing at all
    const ghl: ContactSnapshot[] = [
      { id: "G1", firstName: "G1", tags: [], customFields: { "CF-LEAD": "Referral" }, attribution: { first: { utmSource: "fb" } }, dateAdded: iso("2026-10-02T09:00"), dateUpdated: iso("2026-10-02T09:00") },
      { id: "G2", firstName: "G2", tags: [], customFields: { "CF-UTM-SRC": "IG" }, attribution: { first: { utmSource: "fb" } }, dateAdded: iso("2026-10-03T09:00"), dateUpdated: iso("2026-10-03T09:00") },
      { id: "G3", firstName: "G3", tags: [], customFields: {}, attribution: { first: { utmSource: "fb", medium: "form" }, last: { utmSource: "ig" } }, dateAdded: iso("2026-10-04T09:00"), dateUpdated: iso("2026-10-04T09:00") },
      { id: "G4", firstName: "G4", tags: [], customFields: {}, attribution: { first: { utmSource: "ig" } }, dateAdded: iso("2026-10-05T09:00"), dateUpdated: iso("2026-10-05T09:00") },
      { id: "G5", firstName: "G5", tags: [], customFields: {}, attribution: { first: { medium: "zapier" } }, dateAdded: iso("2026-10-06T09:00"), dateUpdated: iso("2026-10-06T09:00") },   // booked with a UTM
      { id: "G6", firstName: "G6", tags: [], customFields: {}, attribution: { first: { medium: "Manual" } }, dateAdded: iso("2026-10-07T09:00"), dateUpdated: iso("2026-10-07T09:00") },
      { id: "G7", firstName: "G7", tags: [], customFields: {}, dateAdded: iso("2026-10-08T09:00"), dateUpdated: iso("2026-10-08T09:00") },
    ];
    const reads: GhlReads = {
      contactsAdded: async (_c, from, to) => ghl.filter((k) => { const t = Date.parse(k.dateAdded); return t >= from.getTime() && t <= to.getTime(); }),
      getContact: async (_c, id) => ghl.find((k) => k.id === id) ?? null,
      wonCards: async () => [], objectRecords: async () => [], fieldCatalog: async () => [], recordContact: async () => null, cards: async () => [], pipelines: async () => [], users: async () => [],
    };
    const WANT = { referral: 1, ig: 2, fb: 1, google: 1, manual: 1 };
    beforeAll(async () => {
      await asOperator(async (c) => {
        co2 = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('Lead Source 2','lsrc2',$1) returning id", [TZ]))!.id;
        await c.query(`insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories`, [co2]);
        const closing = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [co2]))!.id;
        for (const [k, v] of [["crm.location_id", "LOC"], ["crm.field_contact_lead_source", "CF-LEAD"], ["crm.field_contact_utm_source", "CF-UTM-SRC"], ["crm.field_contact_work_situation", "CF-WORK"], ["qualify.mql_answers", "[\"Employed\"]"], ["qualify.dq_answers", "[\"Between jobs\"]"]])
          await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'id',$3)", [co2, k, Buffer.from(v)]);
        await c.query("insert into bindings (company_id, key, kind, value) values ($1,'secret.ghl_pit','secret',$2)", [co2, encrypt("pit")]);
        await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id) values ($1,'T-LS2',$2,'UBOT2')", [co2, encrypt("xoxb-fake")]);
        // the ledger's copy, as the poll keeps it: bound fields on ghl_fields, GHL's attribution on attribution
        for (const k of ghl) {
          const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, ghl_added_at, ghl_fields, attribution) values ($1,$2,$2,$3,$4,$5) returning id", [co2, k.id, k.dateAdded, k.customFields, k.attribution ?? {}]))!.id;
          const tracking = k.id === "G5" ? { utm_source: "Google" } : k.id === "G1" ? { utm_source: "tiktok" } : {};
          await c.query("insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status, tracking) values ($1,$2,'ghl',$3,$4,$5,$5,$6,'confirmed',$7)",
            [co2, id, `AP-${k.id}`, closing, iso("2026-10-12T10:00"), k.dateAdded, tracking]);
        }
      });
    });

    it("GHL-read leads split by source in the one order: field, UTM field, attribution (first, then last touch), booking UTM, attribution medium", async () => {
      const r = await asOperator((c) => getMetric(c, co2, { metric: "leads", period, groupBy: "source", now: NOW.toJSDate() }, reads));
      expect(Object.fromEntries(r.rows!.map((x) => [x.label, x.value]))).toEqual({ ...WANT, unknown: 1 });
    });

    it("the ledger's metrics coalesce the same order from the contact row (bookings by source)", async () => {
      const r = await asOperator((c) => getMetric(c, co2, { metric: "booked", period, groupBy: "source", now: NOW.toJSDate() }, reads));
      expect(Object.fromEntries(r.rows!.map((x) => [x.label, x.value]))).toEqual({ ...WANT, unknown: 1 });
      const ig = await asOperator((c) => getMetric(c, co2, { metric: "booked", period, filters: { source: "IG" }, now: NOW.toJSDate() }, reads));
      expect(ig.value).toBe(2);
    });

    it("/leads splits by source from GHL's attribution: no lead whose contact GHL attributed is unknown", async () => {
      const said: string[] = [];
      const adapters: Adapters = { ...fakeAdapters(), notifier: { ...fakeAdapters().notifier, post: async (_t, _ch, text) => { said.push(text); return { ts: "1.0", channel: "C-LS" }; } } };
      const cmd = { command: "/leads", text: "", userId: "U-ASK", channelId: "C-LS" };
      const p = planCommand(cmd, TZ, NOW); if (!("plan" in p)) throw new Error("no plan");
      await runCommand({ adapters, probes: fakeProbes, ghl: reads, now: NOW }, co2, cmd, p.plan);
      const rows = said[0].split("\n").filter((l) => /^(ig|fb|referral|google|manual|unknown)\s/.test(l));
      expect(rows.map((l) => l.split(/\s+/).slice(0, 2).join(" ")).sort()).toEqual(["fb 1", "google 1", "ig 2", "manual 1", "referral 1", "unknown 1"]);
    });
  });
});
