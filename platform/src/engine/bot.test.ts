/** The Slack bot (D70): the metric registry on a seeded ledger, the shortcuts, the conversation rules, the doors. A fake Slack and a scripted model keep it deterministic. */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import type { Adapters, BotMessage, BotModel, BotTurn, ContactSnapshot } from "@/adapters/types";
import type { GhlObjectRecord, GhlReads, GhlWonCard } from "@/adapters/ghl/metrics";
import { encrypt } from "./crypto";
import { fakeAdapters, fakeProbes } from "./test-install";
import type { HealthProbes } from "./health";
import { getAvailability, getCloses, getMetric, parsePeriod, previousPeriod } from "./metric-registry";
import { answerList, classifyCall, qualify, salesCallsFor, type QualifyConfig } from "./ghl-metrics";
import { loadCompany } from "./context";
import { formatAnswer, formatCombined, formatSummary, formatAvailability, availabilityBody, table, MAX_ROWS, helpText } from "./bot-format";
import { handleMessage, planCommand, preview, runCommand, type SlackMessage } from "./bot";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const pending: Promise<unknown>[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<unknown>) => { pending.push(fn()); } }));

const TZ = "America/Phoenix";
const NOW = DateTime.fromISO("2026-10-10T12:00:00", { zone: TZ });
const L = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate();   // a local Phoenix time
const SECRET = "sign-me";
let companyId: string;
const ids: Record<string, string> = {};

// ---- fakes ------------------------------------------------------------------------------------------------------------
type Posted = { channel: string; text: string; thread?: string };
let posts: Posted[] = [], reacts: string[] = [], unreacts: string[] = [];
let script: ((req: { messages: BotMessage[] }) => BotTurn)[] = [], seen: BotMessage[][] = [];
let n = 0;
const call = (name: string, input: Record<string, unknown>): BotTurn => { const id = `tu${++n}`; return { text: "", calls: [{ id, name, input }], stop: "tool_use", content: [{ type: "tool_use", id, name, input }] }; };
const model: BotModel = { async next(_k, req) { seen.push(JSON.parse(JSON.stringify(req.messages))); const step = script.shift(); if (!step) throw new Error("script ran out"); return step(req); } };
const slots: Record<string, string[]> = {};
const team: Record<string, string[]> = { "CAL-CARA": ["G-CARA"], "CAL-DAN": ["G-DAN"] };
const probes: HealthProbes = { ...fakeProbes, ghlFreeSlots: async (_p, cal) => ({ ok: true, slots: (slots[cal] ?? []).length, times: slots[cal] ?? [] }), ghlCalendarTeam: async (_p, cal) => ({ ok: true, userIds: team[cal] ?? [] }) };
const adapters = (): Adapters => {
  const a = fakeAdapters();
  let ts = 100;
  a.notifier = { ...a.notifier, post: async (_t, channel, text, _as, thread) => { posts.push({ channel, text, thread }); return { ts: `${++ts}.0`, channel }; },
    react: async (_t, ch, t, e) => { reacts.push(`${ch}:${t}:${e}`); return true; }, unreact: async (_t, ch, t, e) => { unreacts.push(`${ch}:${t}:${e}`); return true; } };
  a.bot = model;
  return a;
};
// GHL as the bot reads it live (D73): contacts by dateAdded, won cards, Sales Call records
const WORK = "F-WORK";
const gc = (id: string, added: string, o: { tags?: string[]; source?: string; work?: string; email?: string } = {}): ContactSnapshot => ({ id, firstName: id, tags: o.tags ?? [], email: o.email,
  customFields: { ...(o.source ? { "F-SRC": o.source } : {}), ...(o.work !== undefined ? { [WORK]: o.work } : {}) }, dateAdded: DateTime.fromISO(added, { zone: TZ }).toUTC().toISO()!, dateUpdated: DateTime.fromISO(added, { zone: TZ }).toUTC().toISO()! });
const ghlContacts: ContactSnapshot[] = [
  gc("C1", "2026-10-02T09:00", { tags: ["mql"], source: "instagram", work: "Employed full-time" }),
  gc("C2", "2026-10-03T09:00", { tags: ["dq-budget"], source: "facebook", work: "Currently between jobs" }),
  gc("C3", "2026-10-04T09:00", { tags: ["dq-age"], source: "instagram", work: "" }),                 // never answered
  gc("C4", "2026-10-05T09:00", { work: " retired " }),                                                // not a form option: unrecognized; source from the booking's UTM
  gc("C5", "2026-09-20T09:00", { tags: ["mql"], source: "instagram", work: "Investor" }),             // last month
  gc("CT1", "2026-10-06T09:00", { tags: ["sys-test"], work: "Investor" }),                          // the team's test contact: tagged
  gc("CT2", "2026-10-06T10:00", { email: "qa@Test.co", work: "Investor" }),                          // … or on a test domain
  gc("C9", "2026-08-01T09:00", { source: "referral" }),                                                // a buyer the ledger never saw
];
const won = (id: string, contact: string, pipelineId: string, wonAt: string, value: number, o: { tags?: string[]; assignedTo?: string } = {}): GhlWonCard =>
  ({ id, pipelineId, status: "won", monetaryValue: value, assignedTo: o.assignedTo, wonAt: DateTime.fromISO(wonAt, { zone: TZ }).toUTC().toISO()!, contactId: contact, contactName: contact, contactTags: o.tags ?? [] });
const ghlCards: GhlWonCard[] = [
  won("W1", "C1", "PIPE-CLOSER", "2026-10-06T11:00", 2999), won("W2", "C1", "PIPE-CLOSER", "2026-10-07T11:00", 1000),   // two cards, one person
  won("W3", "C2", "PIPE-SETTER", "2026-10-06T11:00", 0),                                                                  // the setter board's won is a show, not a sale
  won("W4", "CT1", "PIPE-CLOSER", "2026-10-06T12:00", 1, { tags: ["sys-test"] }),
  won("W5", "C3", "PIPE-CLOSER", "2026-09-20T11:00", 999),
  won("W6", "C9", "PIPE-CLOSER", "2026-10-08T11:00", 500, { assignedTo: "G-DAN" }),                                     // no call in the ledger: the card's owner
];
const sc = (id: string, ext: string, contact: string, at: string, outcome: string, closer: string): GhlObjectRecord =>
  ({ id, createdAt: "2026-10-01T00:00:00Z", properties: { external_id: ext, contact_id: contact, scheduled_at: DateTime.fromISO(at, { zone: TZ }).toUTC().toISO(), call_date: at.slice(0, 10), closer, outcome } });
const salesCalls: GhlObjectRecord[] = [
  sc("S1", "A1", "C1", "2026-10-06T10:00", "showed", "Cara Closer"),
  sc("S2", "A2", "C2", "2026-10-07T10:00", "no_show", "cara closer"),
  sc("S3", "A3", "C3", "2026-10-08T10:00", "showed", "Dan Dealer"),
  sc("S4", "A4", "C4", "2026-10-09T10:00", "scheduled", "Dan Dealer"),       // nothing filed: missing from EOD disposition
  sc("S5", "A5", "C4", "2026-10-12T10:00", "", "Dan Dealer"),               // not yet
  sc("S6", "A6", "C2", "2026-10-08T15:00", "no_show", "Cara Closer"),       // the booking source says cancelled: cancelled wins, and it is a mismatch
  sc("S7", "A8", "C9", "2026-10-09T13:00", "late_cancel", "Zed Outsider"),  // not on the roster: shown by name
  sc("S8", "A7", "C1", "2026-10-07T12:00", "showed", "Cara Closer"),        // a harness booking
  sc("S9", "A10", "CT1", "2026-10-07T13:00", "showed", "Cara Closer"),      // a test contact
  sc("S10", "INV-9f2c", "C3", "2026-10-09T16:00", "showed", "Dan Dealer"),   // an outside integration's id (the invitee's): matched to A12 by C3 and 16:00
  sc("S11", "A13", "C1", "2026-10-08T09:00", "no_show", "Cara Closer"),     // cancelled after the start: the no-show stands
];
salesCalls.push({ id: "S-LINKED", createdAt: "2026-08-01T00:00:00Z", properties: { external_id: "X-LINKED", call_date: "2026-08-14", outcome: "showed", closer: "Cara Closer" } });   // August, linked to its contact only by GHL's association
salesCalls.find((r) => r.id === "S3")!.properties.disposition = "dq";
salesCalls.find((r) => r.id === "S1")!.properties.objections_raised = ["price", "timing"];
salesCalls.find((r) => r.id === "S2")!.properties.objections_raised = ["price"];
salesCalls.find((r) => r.id === "S9")!.properties.objections_raised = ["price"];   // a test contact's call: never counted
salesCalls.find((r) => r.id === "S10")!.properties.disposition = "closed_won";
let ghlDown = false;
const ghlReads: GhlReads = {
  contactsAdded: async (_c, from, to) => { if (ghlDown) throw Object.assign(new Error("GHL 503 on /contacts/search: busy"), { status: 503 }); return ghlContacts.filter((k) => { const t = Date.parse(k.dateAdded); return t >= from.getTime() && t <= to.getTime(); }); },
  wonCards: async () => ghlCards,
  objectRecords: async (_c, key) => (key === "custom_objects.sales_call" ? salesCalls : []),
  getContact: async (_c, id) => ghlContacts.find((k) => k.id === id) ?? null,
  recordContact: async (_c, id) => (id === "S-LINKED" ? "C3" : null),
  fieldCatalog: async () => [
    { object: "contact", objectLabel: "Contact", id: WORK, key: "contact.what_best_describes_your_current_work_situation", prop: WORK, name: "What best describes your current work situation?", type: "TEXT", options: [] },
    { object: "contact", objectLabel: "Contact", id: "F-SRC", key: "contact.utm_source", prop: "F-SRC", name: "UTM Source", type: "TEXT", options: [] },
    { object: "custom_objects.sales_call", objectLabel: "Sales Call", id: "P1", key: "custom_objects.sales_call.call_date", prop: "call_date", name: "Call date", type: "DATE", options: [] },
    { object: "custom_objects.sales_call", objectLabel: "Sales Call", id: "P2", key: "custom_objects.sales_call.objections_raised", prop: "objections_raised", name: "Objections raised", type: "MULTIPLE_OPTIONS", options: [{ key: "price", label: "Price" }, { key: "timing", label: "Timing" }] },
  ],
};
const deps = () => ({ adapters: adapters(), probes, ghl: ghlReads, now: NOW });
const cfgQ: QualifyConfig = { field: WORK, mql: ["Employed full-time", "Business owner or entrepreneur", "Investor"], dq: ["Currently between jobs", "Employed part-time"], unansweredIsMql: false };
const msg = (o: Partial<SlackMessage>): SlackMessage => ({ eventId: `Ev${++n}`, teamId: "T-BOT", type: "app_mention", channel: "C-SALES", channelType: "channel", user: "U-CARA", text: "<@UBOT> hi", ts: `${1700000000 + ++n}.000100`, ...o });
const lastToolResult = () => { const m = seen[seen.length - 1]; const u = m[m.length - 1]; return (u.content as { content: string; is_error?: boolean }[])[0]; };

describe.skipIf(!process.env.DATABASE_URL)("the Slack bot", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='bot'");
      if (co) {
        await c.query("update contacts set merged_into=null where company_id=$1", [co.id]);
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["audit_log", "bot_threads", "poll_cursors", "alerts", "sends", "runs", "workflow_triggers", "workflows", "webhook_deliveries", "events", "recordings", "payments", "appointments", "opportunities", "calendars", "contact_identifiers", "contacts", "bindings", "slack_connections", "users", "company_terms"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]);
      }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('Bot Co','bot',$1) returning id", [TZ]))!.id;
      await c.query(`insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories`, [companyId]);
      const term = async (domain: string, cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain=$2 and category=$3", [companyId, domain, cat]))!.id;
      const closing = await term("appointment_type", "closing"), showed = await term("appointment_outcome", "showed"), closed = await term("call_outcome", "closed"), unq = await term("call_outcome", "unqualified");
      const user = async (name: string, email: string, role: string, slack: string | null, ghl: string | null = null) => (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, slack_user_id, ghl_user_id) values ($1,$2,$3,$4,$5,$6) returning id", [companyId, email, name, role, slack, ghl]))!.id;
      ids.cara = await user("Cara Closer", "cara@bot.co", "closer", "U-CARA", "G-CARA"); ids.dan = await user("Dan Dealer", "dan@bot.co", "closer", null, "G-DAN");
      ids.tyler = await user("Tyler Ray", "owner@bot.co", "owner", "U-TYLER");
      await c.query("update users set ghl_user_id='G-' || upper(split_part(name, ' ', 1)) where company_id=$1 and role='closer'", [companyId]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id) values ($1,'T-BOT',$2,'UBOT')", [companyId, encrypt("xoxb-fake")]);
      for (const [k, kind, v] of [["secret.slack_signing", "secret", SECRET], ["secret.anthropic_key", "secret", "sk-fake"], ["secret.ghl_pit", "secret", "pit"], ["crm.location_id", "id", "LOC"], ["crm.field_contact_lead_source", "id", "F-SRC"], ["bot.escalate_to", "id", "U-TYLER"],
        ["crm.field_contact_work_situation", "id", WORK], ["qualify.mql_answers", "text", JSON.stringify(["Employed full-time", "Business owner or entrepreneur", "Investor"])], ["qualify.dq_answers", "text", JSON.stringify(["Currently between jobs", "Employed part-time"])],
        ["crm.pipeline_closer", "id", "PIPE-CLOSER"], ["crm.object_sales_call", "id", "custom_objects.sales_call"], ["sales_call.outcomes", "text", JSON.stringify({ showed: "showed", no_show: "noshow", noshow: "noshow", cancelled: "cancelled", late_cancel: "cancelled" })], ["test.domains", "text", "test.co"], ["sales_call.dq_dispositions", "text", JSON.stringify(["dq"])]])
        await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4)", [companyId, k, kind, kind === "secret" ? encrypt(v) : Buffer.from(v)]);
      const cal = async (ext: string, owner: string) => (await one<{ id: string }>(c, "insert into calendars (company_id, source, external_id, name, appointment_term, default_user_id) values ($1,'ghl',$2,$3,$4,$5) returning id", [companyId, ext, `Calendar ${ext}`, closing, owner]))!.id;
      await cal("CAL-CARA", ids.cara); await cal("CAL-DAN", ids.dan);
      const contact = async (ghl: string, added: string, tags: string[], source?: string) => (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, ghl_added_at, tags, ghl_fields) values ($1,$2,$2,$3,$4,$5) returning id", [companyId, ghl, L(added), tags, source ? { "F-SRC": source } : {}]))!.id;
      const c1 = await contact("C1", "2026-10-02T09:00", ["mql"], "instagram");
      const c2 = await contact("C2", "2026-10-03T09:00", ["dq-budget"], "facebook");
      const c3 = await contact("C3", "2026-10-04T09:00", ["dq-age"], "instagram");
      const c4 = await contact("C4", "2026-10-05T09:00", []);                         // source from the booking's UTM
      await contact("C5", "2026-09-20T09:00", ["mql"], "instagram");                  // last month
      const dup = await contact("C6", "2026-10-06T09:00", ["mql"], "instagram");       // folded into C1: never a lead of its own
      await c.query("update contacts set merged_into=$2 where id=$1", [dup, c1]);
      const appt = (ext: string, ct: string, closer: string, starts: string, booked: string, status: string, outcome: string | null, callOutcome: string | null, extra: { source?: string; tracking?: object; updated?: string } = {}) =>
        c.query("insert into appointments (company_id, contact_id, source, external_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status, outcome_term, call_outcome_term, tracking, source_updated_at) values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13)",
          [companyId, ct, extra.source ?? "ghl", ext, closing, closer, L(starts), L(booked), status, outcome, callOutcome, extra.tracking ?? {}, extra.updated ? L(extra.updated) : null]);
      await appt("A1", c1, ids.cara, "2026-10-06T10:00", "2026-10-02T10:00", "confirmed", showed, closed);
      await appt("A2", c2, ids.cara, "2026-10-07T10:00", "2026-10-03T10:00", "noshow", null, null);
      await appt("A3", c3, ids.dan, "2026-10-08T10:00", "2026-10-04T10:00", "confirmed", showed, unq);
      await appt("A4", c4, ids.dan, "2026-10-09T10:00", "2026-10-05T10:00", "confirmed", null, null, { tracking: { utm_source: "google" } });   // due, nothing filed: counts as not showed
      await appt("A5", c4, ids.dan, "2026-10-12T10:00", "2026-10-06T10:00", "confirmed", null, null);   // not due yet
      await appt("A6", c2, ids.cara, "2026-10-08T15:00", "2026-10-04T11:00", "cancelled", null, null, { updated: "2026-10-05T09:00" });   // cancelled days before the call
      await appt("A12", c3, ids.dan, "2026-10-09T16:00", "2026-10-05T12:00", "confirmed", null, null);   // GHL's record for it carries another id: matched by person and minute
      await appt("A13", c1, ids.cara, "2026-10-08T09:00", "2026-10-03T12:00", "cancelled", null, null, { updated: "2026-10-08T09:30" });   // the host cleared the slot after a no-show
      await appt("A7", c1, ids.cara, "2026-10-07T12:00", "2026-10-02T11:00", "showed", null, null, { source: "test" });   // harness: never counts
      await c.query("insert into opportunities (company_id, contact_id, status, opened_by, won_at, contract_value) values ($1,$2,'won','test',$3,5000)", [companyId, c1, L("2026-10-06T11:00")]);
      const t1 = await contact("CT1", "2026-10-06T09:00", ["sys-test"]);                // the team's test contact: in no number, ledger or GHL
      const t2 = await contact("CT2", "2026-10-06T10:00", []);
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','qa@test.co')", [companyId, t2]);
      await appt("A10", t1, ids.cara, "2026-10-07T13:00", "2026-10-05T10:00", "showed", showed, closed);
      await appt("A11", t2, ids.dan, "2026-10-07T14:00", "2026-10-05T11:00", "showed", showed, null);
      const pay = (ext: string, ct: string | null, amount: number, status: string, at: string, raw: object = {}) => c.query("insert into payments (company_id, contact_id, whop_payment_id, amount, status, paid_at, raw, link_status) values ($1,$2,$3,$4,$5,$6,$7,$8)", [companyId, ct, ext, amount, status, L(at), raw, ct ? "linked" : "unlinked"]);
      await pay("P1", c1, 3000, "succeeded", "2026-10-06T11:00"); await pay("P2", c1, -500, "refunded", "2026-10-08T11:00");
      await pay("P3", null, 1000, "succeeded", "2026-10-07T11:00"); await pay("P4", c2, 999, "succeeded", "2026-10-07T11:00", { simulated: true });
      await pay("P5", c1, 2000, "succeeded", "2026-09-01T11:00"); await pay("P6", t1, 700, "succeeded", "2026-10-07T11:00");
      const dial = (ext: string, ct: string, at: string) => c.query("insert into recordings (company_id, contact_id, provider, external_id, started_at, raw) values ($1,$2,'ghl',$3,$4,$5)", [companyId, ct, ext, L(at), { kind: "phone", direction: "outbound", call_status: "connected", duration_sec: 300, caller_ghl_user_id: "G-CARA" }]);
      await dial("D1", c4, "2026-10-05T09:30"); await dial("D2", t1, "2026-10-06T09:30");   // a dial to the team's test contact is not a dial
    });
    const at = (d: string, h: number) => DateTime.fromISO(d, { zone: TZ }).set({ hour: h }).toISO()!;
    slots["CAL-CARA"] = [at("2026-10-10", 14), at("2026-10-10", 15), at("2026-10-10", 16), at("2026-10-11", 9)];
    slots["CAL-DAN"] = [at("2026-10-10", 13), at("2026-10-10", 14), at("2026-10-12", 9), at("2026-10-12", 10), at("2026-10-12", 11), at("2026-10-12", 12)];
  });
  beforeEach(() => { posts = []; reacts = []; unreacts = []; script = []; seen = []; });

  const month = () => parsePeriod("this month", TZ, NOW)!;
  const metric = (m: string, o: { groupBy?: Parameters<typeof getMetric>[2]["groupBy"]; filters?: Parameters<typeof getMetric>[2]["filters"]; period?: ReturnType<typeof month> } = {}) =>
    asOperator((c) => getMetric(c, companyId, { metric: m, period: o.period ?? month(), groupBy: o.groupBy, filters: o.filters, now: NOW.toJSDate() }, ghlReads));

  describe("periods", () => {
    it("reads plain words in the company's zone; this month is the calendar month so far", () => {
      expect(month()).toMatchObject({ from: "2026-10-01", to: "2026-10-10", label: "Oct 1–10" });
      expect(parsePeriod("last month", TZ, NOW)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
      expect(parsePeriod("last week", TZ, NOW)).toMatchObject({ from: "2026-09-28", to: "2026-10-04" });
      expect(parsePeriod("last 30 days", TZ, NOW)).toMatchObject({ from: "2026-09-11", to: "2026-10-10" });
      expect(parsePeriod("Sep 1 to Sep 15", TZ, NOW)).toMatchObject({ from: "2026-09-01", to: "2026-09-15" });
      expect(parsePeriod("2026-09-01..2026-09-30", TZ, NOW)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
      expect(parsePeriod("november", TZ, NOW)).toMatchObject({ from: "2025-11-01", to: "2025-11-30" });   // a year-less month is never in the future
      expect(parsePeriod("yesterday", TZ, NOW)).toMatchObject({ from: "2026-10-09", to: "2026-10-09" });
      expect(parsePeriod("", TZ, NOW)).toBeNull(); expect(parsePeriod("whenever", TZ, NOW)).toBeNull();
      expect(previousPeriod(month(), "month", TZ, NOW)).toMatchObject({ from: "2026-09-01", to: "2026-09-10" });
      expect(previousPeriod(parsePeriod("last month", TZ, NOW)!, "month", TZ, NOW)).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    });
  });

  describe("the registry: people, deals and calls from GHL; bookings and cash from the ledger", () => {
    it("leads, MQLs, marketing DQs and the financial DQL, read from GHL by arrival; test contacts and other months never count", async () => {
      expect(await metric("leads")).toMatchObject({ value: 4, source: "GHL, read just now" });
      const mq = await metric("mqls");
      expect(mq.value).toBe(1);
      expect(mq.qualification).toEqual({ mql: 1, dq: 1, unanswered: 1, unrecognized: 1, unrecognized_answers: ["retired"], unanswered_is_mql: false });
      expect((await metric("marketing_dqs")).value).toBe(1);
      const r = await metric("mql_rate"); expect(r).toMatchObject({ numerator: 1, denominator: 4, value: 0.25, source: "GHL, read just now" });
      const by = await metric("leads", { groupBy: "source" });
      expect(Object.fromEntries(by.rows!.map((x) => [x.label, x.value]))).toEqual({ instagram: 2, facebook: 1, google: 1 });   // C4's from the booking's UTM
      expect((await metric("mqls", { filters: { source: "Instagram" } })).value).toBe(1);
      expect((await metric("leads_showed", { groupBy: "source" })).rows!.map((x) => [x.label, x.value])).toEqual([["instagram", 2]]);   // the ledger's, test contacts out
    });
    it("a blank answer is an MQL only when the company says so; the answer match is exact, never a guess", async () => {
      expect(qualify(" employed FULL-time ", cfgQ)).toBe("mql"); expect(qualify("Employed part-time", cfgQ)).toBe("dq");
      expect(qualify("", cfgQ)).toBe("unanswered"); expect(qualify(null, cfgQ)).toBe("unanswered");
      expect(qualify("Employed full-time and happy", cfgQ)).toBe("unrecognized");
      expect(answerList(JSON.stringify(["A", " B "]))).toEqual(["A", "B"]); expect(answerList("A\nB")).toEqual(["A", "B"]);
      await asOperator((c) => c.query("insert into bindings (company_id, key, kind, value) values ($1,'qualify.unanswered_is_mql','text',$2)", [companyId, Buffer.from("true")]));
      try { expect(await metric("mqls")).toMatchObject({ value: 2, qualification: { unanswered: 1, unanswered_is_mql: true } }); }
      finally { await asOperator((c) => c.query("delete from bindings where company_id=$1 and key='qualify.unanswered_is_mql'", [companyId])); }
    });
    it("show rate: Sales Call records whose time has passed, cancellations included; a booking cancelled before its start is cancelled whatever GHL says, and named", async () => {
      expect((await metric("booked")).value).toBe(8);       // the ledger: test contacts' bookings out
      expect((await metric("calls_due")).value).toBe(5);
      expect((await metric("calls_booked_due")).value).toBe(8);
      const sr = await metric("show_rate", { groupBy: "closer" });
      expect(sr).toMatchObject({ numerator: 3, denominator: 8, source: "GHL, read just now" });
      expect(sr.rows!.map((x) => [x.label, x.numerator, x.denominator])).toEqual([["Cara Closer", 1, 4], ["Dan Dealer", 2, 3], ["Zed Outsider", 0, 1]]);
      expect(sr.shows_breakdown).toEqual({ booked: 8, showed: 3, noshow: 2, cancelled: 2, rescheduled: 0, missing: 1, missing_names: ["C4"],
        mismatches: [{ name: "C2", ghl_contact_id: "C2", record_id: "S6", ghl: "noshow", booking_source: "the GHL calendar" }] });
      expect((await metric("shows")).value).toBe(3);
      expect((await metric("no_shows")).value).toBe(2);       // S11 stands: cancelled after the start
      expect((await metric("cancellations")).value).toBe(2);
      expect((await metric("sales_dqs")).value).toBe(1);      // the DQ disposition, from GHL
      expect((await metric("show_rate", { filters: { closer: "Dan Dealer" } })).shows_breakdown).toMatchObject({ booked: 3, showed: 2, missing: 1 });
    });
    it("the cancel rule: before the start the booking wins; after it, or at an unknown time, the filed outcome stands", () => {
      const start = new Date("2026-10-05T15:00:00Z");
      expect(classifyCall("noshow", { status: "cancelled", cancelledAt: new Date("2026-10-02T15:00:00Z"), startsAt: start })).toEqual({ cls: "cancelled", flipped: true, cancelUnknown: false });
      expect(classifyCall("noshow", { status: "cancelled", cancelledAt: new Date("2026-10-05T16:00:00Z"), startsAt: start })).toEqual({ cls: "noshow", flipped: false, cancelUnknown: false });
      expect(classifyCall("noshow", { status: "cancelled", cancelledAt: null, startsAt: start })).toEqual({ cls: "noshow", flipped: false, cancelUnknown: true });
      expect(classifyCall(null, { status: "cancelled", cancelledAt: new Date("2026-10-02T15:00:00Z"), startsAt: start })).toEqual({ cls: "cancelled", flipped: false, cancelUnknown: false });
      expect(classifyCall(null, null)).toEqual({ cls: "missing", flipped: false, cancelUnknown: false });
    });
    it("closes: distinct people with a won card on the Closer pipeline (never the setter board, never a test contact); revenue is their cards' value", async () => {
      expect(await metric("closes")).toMatchObject({ value: 2, source: "GHL, read just now" });
      expect((await metric("revenue")).value).toBe(4499);
      const cr = await metric("close_rate", { groupBy: "closer" });
      expect(cr).toMatchObject({ numerator: 2, denominator: 3 });
      expect(cr.rows!.find((x) => x.label === "Cara Closer")).toMatchObject({ value: 1, numerator: 1, denominator: 1 });   // the closer of C1's latest call
      expect(cr.rows!.find((x) => x.label === "Dan Dealer")).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });  // C9: no call, the card's owner
      const list = await asOperator((c) => getCloses(c, companyId, { period: month(), now: NOW.toJSDate() }, ghlReads));
      expect(list).toMatchObject({ count: 2, closes: [{ name: "C9", closer: "Dan Dealer", won: "Thu Oct 8", value: 500 }, { name: "C1", closer: "Cara Closer", won: "Wed Oct 7", value: 3999 }] });
      expect(await metric("close_rate", { filters: { userId: ids.cara } })).toMatchObject({ value: 1, filters: { closer: "Cara Closer" } });
      await expect(metric("close_rate", { filters: { closer: "Zed" } })).rejects.toThrow(/no one on the roster/);
      expect(Object.fromEntries((await metric("closes", { groupBy: "source" })).rows!.map((x) => [x.label, x.value]))).toEqual({ instagram: 1, referral: 1 });
    });
    it("GHL that cannot be read is an error with its status, never the ledger's number", async () => {
      ghlDown = true;
      try { await expect(metric("leads")).rejects.toThrow(/GHL could not be read \(contacts, 503\)/); await expect(metric("mql_rate")).rejects.toThrow(/GHL could not be read/); }
      finally { ghlDown = false; }
    });
    it("cash is net of refunds; harness payments and test contacts never count; unlinked money is its own row", async () => {
      expect((await metric("cash_gross")).value).toBe(4000);
      expect((await metric("refunds")).value).toBe(500);
      const net = await metric("cash_collected", { groupBy: "closer" });
      expect(net.value).toBe(3500);
      expect(Object.fromEntries(net.rows!.map((x) => [x.label, x.value]))).toEqual({ "Cara Closer": 2500, unassigned: 1000 });
      await expect(metric("leads", { groupBy: "closer" })).rejects.toThrow(/cannot be split by closer/);
      expect((await metric("dials")).value).toBe(1); expect((await metric("connected")).value).toBe(1);
    });
    it("availability: open slots per closer per day from the live calendar read (the calendar's team, matched to the roster); a source that fails everywhere is an error, not zero", async () => {
      const a = await asOperator((c) => getAvailability(c, companyId, probes, 7, NOW));
      expect(a.source).toBe("GHL, read just now");
      expect(a.days.map((d) => d.total)).toEqual([5, 1, 4, 0, 0, 0, 0]); expect(a.total).toBe(10); expect(a.split_error).toBeUndefined();
      expect(a.closers).toEqual([{ name: "Cara Closer", short: "Cara", per_day: [3, 1, 0, 0, 0, 0, 0], total: 4 }, { name: "Dan Dealer", short: "Dan", per_day: [2, 0, 4, 0, 0, 0, 0], total: 6 }]);
      const down: HealthProbes = { ...probes, ghlFreeSlots: async () => ({ ok: false, error: "401 unauthorized" }) };
      await expect(asOperator((c) => getAvailability(c, companyId, down, 7, NOW))).rejects.toThrow(/GHL did not answer.*401/);
    });
    it("availability, GHL round robin: each team member's free slots are read on their own; a time two calendars offer counts once per closer; a time no member has fails the split", async () => {
      // Dan's calendar is shared with Cara: she is free on it at 2pm Saturday (also offered on her own calendar: once) and 9am Monday
      const shared: HealthProbes = { ...probes, ghlCalendarTeam: async (_p, cal) => ({ ok: true, userIds: cal === "CAL-DAN" ? ["G-DAN", "G-CARA"] : ["G-CARA"] }),
        ghlFreeSlots: async (_p, cal, _f, _t, _z, user) => { const all = slots[cal] ?? []; const t = !user ? all : user === "G-CARA" ? all.filter((x) => /T1[4]:|2026-10-12T09/.test(x)) : all.filter((x) => !/2026-10-12T09/.test(x)); return { ok: true, slots: t.length, times: t }; } };
      const a = await asOperator((c) => getAvailability(c, companyId, shared, 3, NOW));
      expect(a.closers.map((x) => [x.short, x.per_day])).toEqual([["Cara", [3, 1, 1]], ["Dan", [2, 0, 3]]]);
      expect(a.days.map((d) => d.total)).toEqual([5, 1, 4]); expect(a.total).toBe(10);
      // Monday 9am is offered but neither member's own read has it: no split, the day totals are the distinct offered times
      const gap: HealthProbes = { ...shared, ghlFreeSlots: async (p, cal, f, t, z, user) => { const r = await shared.ghlFreeSlots(p, cal, f, t, z, user); return user && r.ok ? { ...r, times: r.times.filter((x) => !/2026-10-12T09/.test(x)) } : r; } };
      const b = await asOperator((c) => getAvailability(c, companyId, gap, 3, NOW));
      expect(b.closers).toEqual([]); expect(b.split_error).toBe("Could not split by closer: 1 offered time matched no host's schedule");
      expect(b.days.map((d) => d.total)).toEqual([4, 1, 4]); expect(b.total).toBe(9);   // Saturday 2pm is offered by both calendars: one distinct time
    });
  });

  describe("the formatter", () => {
    it("a table is aligned monospace, capped at 25 rows with the rest counted, with a totals row", () => {
      const t = table(["Source", "Leads"], Array.from({ length: 30 }, (_, i) => [`s${i}`, String(i)]), ["Total", "435"]);
      const lines = t.split("\n");
      expect(lines[0]).toBe("```"); expect(lines[lines.length - 1]).toBe("```");
      expect(lines[1]).toBe("Source  Leads"); expect(lines[2]).toBe("s0          0");
      expect(lines).toContain(`… ${30 - MAX_ROWS} more`); expect(lines[lines.length - 2]).toBe("Total     435");
    });
    it("an answer: key numbers first with their source, the table, then only the period (definitions stay with /help and the model)", async () => {
      const text = formatAnswer([await metric("close_rate", { groupBy: "closer" })]);
      const lines = text.split("\n");
      expect(lines[0]).toBe("*Close rate: 66.7%*  ·  2 closes ÷ 3 shows  · _from GHL, read just now_");
      expect(text).toContain("Cara Closer        100%       1      1"); expect(text).not.toMatch(/closes ÷ shows in the same period/);
      expect(lines[lines.length - 1]).toBe("_Period: Oct 1–10 (America/Phoenix)_"); expect(lines[lines.length - 2]).toBe("");
      const combined = formatCombined([await metric("leads", { groupBy: "source" }), await metric("mqls", { groupBy: "source" })]).split("\n");
      expect(combined[combined.length - 1]).toBe("_Period: Oct 1–10 (America/Phoenix)_"); expect(combined.filter((l) => /^_.*: /.test(l) && !l.startsWith("_Period"))).toEqual([]);
      const summary = formatSummary([await metric("leads")], null).split("\n");
      expect(summary[summary.length - 1]).toBe("_Period: Oct 1–10 (America/Phoenix)_"); expect(summary.join("\n")).not.toContain("people who entered");
      expect(helpText()).toContain("*Show rate*: shows ÷ calls booked whose time has passed");
    });
    it("show rate carries every due call by outcome, who is missing from EOD disposition, and what to fix in GHL; MQLs say how leads answered", async () => {
      const text = formatAnswer([await metric("show_rate", { groupBy: "closer" }), await metric("show_rate", { groupBy: "source" })]);
      const lines = text.split("\n");
      expect(lines.slice(0, 3)).toEqual(["*Show rate: 37.5%*  ·  3 shows ÷ 8 calls booked  · _from GHL, read just now_",
        "Calls booked: 8 · Showed 3 · No-show 2 · Cancelled 2 · Missing from EOD disposition 1 (C4)",
        "⚠️ C2: GHL says no-show, the GHL calendar says cancelled (counted as cancelled; fix the Sales Call in GHL)"]);
      expect(text).toContain("Zed Outsider");
      expect(formatAnswer([await metric("mqls")]).split("\n")[1]).toBe("MQLs: 1 matched the employment standard · 1 didn't answer · 1 unrecognized answer (\"retired\")");
    });
    it("availability: one table, a day per row, a column per closer (first names), the day's total, a total row; the period line under it and nothing else", async () => {
      const text = formatAvailability(await asOperator((c) => getAvailability(c, companyId, probes, 3, NOW)));
      expect(text).toBe([
        "*Open slots, next 3 days: 10*  · _from GHL, read just now_", "",
        "```", "Day         Cara Open  Dan Open  Total Open", "Sat Oct 10          3         2           5", "Sun Oct 11          1         0           1", "Mon Oct 12          0         4           4", "Total               4         6          10", "```", "",
        "_Period: Sat Oct 10 to Mon Oct 12, read just now (America/Phoenix)_"].join("\n"));
      expect(text).not.toMatch(/light/i);
    });
  });

  describe("shortcuts", () => {
    it("/mtd: the key numbers first, compared with the same days last month, top source by cash, then the period line", async () => {
      const cmd = { command: "/mtd", text: "", userId: "U-CARA", channelId: "C-SALES" };
      const p = planCommand(cmd, TZ, NOW); if (!("plan" in p)) throw new Error("no plan");
      const out = await runCommand(deps(), companyId, cmd, p.plan);
      expect(out).toMatchObject({ channel: "C-SALES" });
      const lines = posts[0].text.split("\n");
      expect(lines[0]).toBe("📊 *Month to date* — asked by <@U-CARA>");
      expect(lines[1]).toBe("*Leads: 4*  · _from GHL, read just now_  ·  same days last month 0 (▲ 4)");
      expect(lines[3]).toBe("MQLs: 1 matched the employment standard · 1 didn't answer · 1 unrecognized answer (\"retired\")");
      expect(lines.find((l) => l.startsWith("*Calls booked"))).toMatch(/^\*Calls booked: 8\*  · _from GHL, read just now_/);
      expect(lines.find((l) => l.startsWith("*Show rate"))).toMatch(/^\*Show rate: 37.5%\*  ·  3 shows ÷ 8 calls booked/);
      expect(lines).toContain("Calls booked: 8 · Showed 3 · No-show 2 · Cancelled 2 · Missing from EOD disposition 1 (C4)");
      expect(lines.find((l) => l.startsWith("*Close rate"))).toMatch(/^\*Close rate: 66.7%\*  ·  2 closes ÷ 3 shows/);
      expect(posts[0].text).not.toMatch(/^_(?!Period).*: /m);   // no definition lines, only the period
      expect(posts[0].text).toContain("*Cash collected: $3,500*"); expect(posts[0].text).toContain("*Top source by cash: instagram* ($2,500)");
      expect(lines[lines.length - 1]).toBe("_Period: Oct 1–10 (America/Phoenix) · compared with Sep 1–10_"); expect(lines[lines.length - 2]).toBe("");
      const row = await asOperator((c) => one<{ messages: unknown[] }>(c, "select messages from bot_threads where company_id=$1 and channel='C-SALES' and thread_ts=$2", [companyId, (out as { ts: string }).ts]));
      expect(row?.messages).toHaveLength(2);   // anyone follows up in the post's thread
    });
    it("/mtd when GHL cannot be read: says so and pings, never the ledger's numbers", async () => {
      const cmd = { command: "/mtd", text: "", userId: "U-CARA", channelId: "C-SALES" };
      const p = planCommand(cmd, TZ, NOW); if (!("plan" in p)) throw new Error("no plan");
      ghlDown = true;
      try { await runCommand(deps(), companyId, cmd, p.plan); } finally { ghlDown = false; }
      expect(posts[0].text).toContain("I couldn't get a live read (GHL could not be read (contacts, 503)"); expect(posts[0].text).not.toContain("*Leads");
      expect(posts[1].text).toBe("Hey <@U-TYLER>, can you help?");
    });
    it("a shortcut takes a period in words; one it cannot read is refused with examples; help is its own command", () => {
      expect(planCommand({ command: "/close-rate", text: "last month", userId: "U", channelId: "C" }, TZ, NOW)).toMatchObject({ plan: { period: { from: "2026-09-01", to: "2026-09-30" } } });
      expect(planCommand({ command: "/close-rate", text: "blorp", userId: "U", channelId: "C" }, TZ, NOW)).toMatchObject({ error: expect.stringContaining("couldn't read \"blorp\"") });
      expect(planCommand({ command: "/monthly", text: "", userId: "U", channelId: "C" }, TZ, NOW)).toMatchObject({ plan: { title: "Last month" } });
      expect(planCommand({ command: "/availability", text: "3", userId: "U", channelId: "C" }, TZ, NOW)).toMatchObject({ plan: { days: 3 } });
      expect(planCommand({ command: "/help", text: "", userId: "U", channelId: "C" }, TZ, NOW)).toEqual({ help: true });
    });
    it("/leads from a DM answers in the DM", async () => {
      const cmd = { command: "/leads", text: "", userId: "U-CARA", channelId: "D-CARA", channelName: "directmessage" };
      const p = planCommand(cmd, TZ, NOW); if (!("plan" in p)) throw new Error("no plan");
      await runCommand(deps(), companyId, cmd, p.plan);
      expect(posts[0].channel).toBe("D-CARA");
      expect(posts[0].text).toContain("Source     Leads  MQLs  Marketing DQs");
      expect(posts[0].text).toContain("MQLs: 1 matched the employment standard · 1 didn't answer");
    });
    it("/closes lists each close, newest first, with the count on top; /weekly is the same GHL numbers", async () => {
      const cmd = { command: "/closes", text: "", userId: "U-CARA", channelId: "C-SALES" };
      const p = planCommand(cmd, TZ, NOW); if (!("plan" in p)) throw new Error("no plan");
      await runCommand(deps(), companyId, cmd, p.plan);
      expect(posts[0].text.split("\n")).toEqual(["📊 *Closes* — asked by <@U-CARA>", "*Closes: 2*  · _from GHL, read just now_", "", "• C9 — Dan Dealer — won Thu Oct 8", "• C1 — Cara Closer — won Wed Oct 7", "", "_Period: Oct 1–10 (America/Phoenix)_"]);
      const wk = { command: "/weekly", text: "this week", userId: "U-CARA", channelId: "C-SALES" };
      const pw = planCommand(wk, TZ, NOW); if (!("plan" in pw)) throw new Error("no plan");
      await runCommand(deps(), companyId, wk, pw.plan);
      expect(posts[1].text).toContain("*Leads: 1*  · _from GHL, read just now_  ·  week before 2 (▼ 1)"); expect(posts[1].text).toContain("*Calls booked: 8*  · _from GHL, read just now_");
      expect(posts[1].text).not.toMatch(/^_(?!Period).*: /m);
    });
  });

  describe("questions", () => {
    it("a mention: 👀 at once, the answer in the thread rendered from the tool results, the model's note kept only when its numbers are real", async () => {
      script = [() => call("get_metric", { metric: "close_rate", period: "this month", group_by: "closer", filters: { closer: "", setter: "", source: "", me: false } }),
        () => call("reply", { result_ids: ["r1"], note: "Cara closed 100% of her shows." })];
      const ev = msg({ text: "<@UBOT> close rate this month by closer?" });
      expect(await handleMessage(deps(), companyId, ev)).toMatchObject({ answered: "answer", thread: ev.ts });
      expect(reacts).toEqual([`C-SALES:${ev.ts}:eyes`]); expect(unreacts).toEqual([`C-SALES:${ev.ts}:eyes`]);
      expect(posts).toHaveLength(1); expect(posts[0].thread).toBe(ev.ts);
      expect(posts[0].text.split("\n").slice(0, 3)).toEqual(["*Close rate: 66.7%*  ·  2 closes ÷ 3 shows  · _from GHL, read just now_", "", "Cara closed 100% of her shows."]);
      script = [() => call("get_metric", { metric: "leads", period: "this month", group_by: "none", filters: { closer: "", setter: "", source: "", me: false } }),
        () => call("reply", { result_ids: ["r1"], note: "Up 37% on last month." }),   // a number no tool produced: sent back once to be rewritten
        () => call("reply", { result_ids: ["r1"], note: "Still 17%, sure." })];         // made up again: dropped this time
      posts = [];
      await handleMessage(deps(), companyId, msg({ text: "<@UBOT> leads this month?" }));
      expect(lastToolResult()).toMatchObject({ is_error: true }); expect(lastToolResult().content).toMatch(/^Your note uses numbers the answer does not show: 37\./);
      expect(posts[0].text).not.toContain("37%"); expect(posts[0].text).not.toContain("17%");
      script = [() => call("get_metric", { metric: "leads", period: "this month", group_by: "none", filters: { closer: "", setter: "", source: "", me: false } }),
        () => call("reply", { result_ids: ["r1"], note: "Up 37% on last month." }), () => call("reply", { result_ids: ["r1"], note: "That's this month so far." })];
      posts = [];
      await handleMessage(deps(), companyId, msg({ text: "<@UBOT> leads this month?" }));
      expect(posts[0].text).toContain("\n\nThat's this month so far.");   // the rewrite is kept, as its own paragraph
    });
    it("D74: a term no metric covers is resolved to a GHL field by the model, counted live, and the answer names the field it used", async () => {
      script = [() => call("list_fields", { object: "all" }),
        () => call("field_breakdown", { object: "contact", field: "contact.what_best_describes_your_current_work_situation", period: "this month", list: true }),
        () => call("reply", { result_ids: ["r1"], note: "" })];
      await handleMessage(deps(), companyId, msg({ text: "<@UBOT> how do this month's leads describe their jobs?" }));
      const fields = JSON.parse((seen[1][seen[1].length - 1].content as { content: string }[])[0].content);
      expect(fields.fields.map((f: { name: string }) => f.name)).toContain("Objections raised");
      expect(fields.fields.find((f: { name: string }) => f.name === "Objections raised").options).toEqual(["Price", "Timing"]);
      const text = posts[0].text;
      // October's leads: C1–C4; the test contacts and September's lead are not in it
      expect(text.split("\n")[0]).toBe("*What best describes your current work situation?*: 3 of 4 answered  · _leads GHL added in the period, from GHL, read just now_");
      expect(text).toContain("\n*What best describes your current work situation?*\n```"); expect(text).toMatch(/Employed full-time\s+1\s+25%/); expect(text).toMatch(/Currently between jobs\s+1/); expect(text).toMatch(/retired\s+1/); expect(text).toMatch(/\(no answer\)\s+1/);
      expect(text).toContain("• C3 — (no answer)"); expect(text).not.toContain("CT1");
      expect(text.trim().split("\n").at(-1)).toMatch(/^_Period: /);
    });
    it("D74: a custom object's multi-pick field counts each pick by its label, dated by the object's date field, test contacts left out", async () => {
      script = [() => call("field_breakdown", { object: "custom_objects.sales_call", field: "custom_objects.sales_call.objections_raised", period: "this month", list: false }),
        () => call("reply", { result_ids: ["r1"], note: "" })];
      await handleMessage(deps(), companyId, msg({ text: "<@UBOT> most common objections this month?" }));
      const text = posts[0].text;
      expect(text.split("\n")[0]).toMatch(/^\*Objections raised\*: 2 of \d+ answered  · _Sales Call records with call date in the period, from GHL, read just now_$/);
      expect(text).toMatch(/Price\s+2\s/); expect(text).toMatch(/Timing\s+1\s/);
      expect(text).toContain("Several answers can be picked");
    });
    it("preview: a shortcut or a question answered as Slack would get it, and nothing posted", async () => {
      const a = await preview(deps(), companyId, { command: "/closes", text: "this month" });
      expect(a.kind).toBe("answer"); expect(a.text).toMatch(/^\*Closes: \d+\*/);
      script = [() => call("ask_clarification", { question: "For which period?" })];
      expect(await preview(deps(), companyId, { question: "show rate?" })).toEqual({ kind: "clarify", text: "For which period?" });
      expect(await preview(deps(), companyId, { command: "/nope" })).toMatchObject({ kind: "error" });
      expect(posts).toEqual([]);
    });
    it("D74: an answer against showing up: each answer's calls and show rate, its share of shows, and a verdict the numbers earn (too few here)", async () => {
      script = [() => call("compare_with_shows", { field: "contact.what_best_describes_your_current_work_situation", period: "this month" }),
        () => call("reply", { result_ids: ["r1"], note: "Too few calls to call it a pattern." })];
      await handleMessage(deps(), companyId, msg({ text: "<@UBOT> do people's jobs line up with who shows?" }));
      const text = posts[0].text;
      expect(text.split("\n")[0]).toMatch(/^\*Show rate by "What best describes your current work situation\?"\*: \d+ of \d+ calls showed \(\d+%\)  · _Sales Calls in the period, from GHL, read just now_$/);
      expect(text).toContain("Too few calls to call it a pattern.");
      expect(text).toMatch(/Answer\s+Calls\s+Showed\s+No-show.*Show rate\s+Share of shows/);
      expect(text).toMatch(/Employed full-time\s+\d+/);
      expect(text).toMatch(/_Only \d+ calls have an answer to this question: too few to tell a pattern from chance\._/);
      const res = JSON.parse(lastToolResult().content);
      expect(res.rows.reduce((a: number, r: { calls: number }) => a + r.calls, 0)).toBe(res.calls);
    });
    it("D74: a Sales Call linked to its contact only by GHL's association is read through that association", async () => {
      const calls = await asOperator(async (c) => { const { adapterCompany: ac, bindings } = await loadCompany(c, companyId);
        return salesCallsFor({ c, companyId, ac, bindings, reads: ghlReads, tz: TZ, start: DateTime.fromISO("2026-08-01", { zone: TZ }).toJSDate(), end: DateTime.fromISO("2026-09-01", { zone: TZ }).toJSDate(), now: NOW.toJSDate(), sourceField: "", domains: [] }); });
      expect(calls.map((k) => [k.id, k.ghl, k.cls])).toEqual([["S-LINKED", "C3", "showed"]]);
    });
    it("D74: a field key the catalogue does not hold is an error back to the model, never a guess", async () => {
      script = [() => call("field_breakdown", { object: "contact", field: "hair_severity", period: "this month", list: false }), () => call("ask_clarification", { question: "Which field?" })];
      await handleMessage(deps(), companyId, msg({ text: "<@UBOT> hair severity this month" }));
      expect(lastToolResult()).toMatchObject({ is_error: true }); expect(lastToolResult().content).toMatch(/call list_fields/);
    });
    it("no period: the bot asks, then the reply in the thread continues the conversation without a new mention", async () => {
      const ev = msg({ text: "<@UBOT> what's our show rate?" });
      script = [() => call("ask_clarification", { question: "For which period? This month, last month, or something else?" })];
      expect(await handleMessage(deps(), companyId, ev)).toMatchObject({ answered: "clarify" });
      expect(posts[0]).toEqual({ channel: "C-SALES", thread: ev.ts, text: "For which period? This month, last month, or something else?" });
      script = [() => call("get_metric", { metric: "show_rate", period: "last month", group_by: "none", filters: { closer: "", setter: "", source: "", me: false } }), () => call("reply", { result_ids: ["r1"], note: "" })];
      const follow = msg({ type: "message", text: "last month", threadTs: ev.ts });
      expect(await handleMessage(deps(), companyId, follow)).toMatchObject({ answered: "answer", thread: ev.ts });
      const first = seen[seen.length - 2];
      expect(first.map((m) => (typeof m.content === "string" ? m.content : "[blocks]")).slice(0, 2)).toEqual(["what's our show rate?", "For which period? This month, last month, or something else?"]);
      expect(posts[1].text).toMatch(/^\*Show rate: —\*/);   // September had no calls due: no rate, never 0%
    });
    it("a period the parser cannot read goes back to the model as an error, never a guess", async () => {
      script = [() => call("get_metric", { metric: "leads", period: "a while ago", group_by: "none", filters: { closer: "", setter: "", source: "", me: false } }), () => call("ask_clarification", { question: "Which dates?" })];
      await handleMessage(deps(), companyId, msg({ text: "<@UBOT> leads a while ago" }));
      expect(lastToolResult()).toMatchObject({ is_error: true }); expect(lastToolResult().content).toMatch(/not a period/);
      expect(posts[0].text).toBe("Which dates?");
    });
    it("\"my close rate\" in a DM: filtered to the asker, answered privately in the DM", async () => {
      script = [() => call("get_metric", { metric: "close_rate", period: "this month", group_by: "none", filters: { closer: "", setter: "", source: "", me: true } }), () => call("reply", { result_ids: ["r1"], note: "" })];
      const ev = msg({ type: "message", channel: "D-CARA", channelType: "im", text: "what's my close rate this month?" });
      expect(await handleMessage(deps(), companyId, ev)).toMatchObject({ answered: "answer", channel: "D-CARA" });
      expect(posts).toEqual([expect.objectContaining({ channel: "D-CARA", thread: undefined })]);
      expect(posts[0].text.split("\n")[0]).toBe("*Close rate (Cara Closer): 100%*  ·  1 closes ÷ 1 shows  · _from GHL, read just now_");
    });
    it("\"my\" from someone not on the roster is an error the model must turn into a question", async () => {
      script = [() => call("get_metric", { metric: "close_rate", period: "this month", group_by: "none", filters: { closer: "", setter: "", source: "", me: true } }), () => call("ask_clarification", { question: "Who are you in the CRM?" })];
      await handleMessage(deps(), companyId, msg({ user: "U-NOBODY", text: "<@UBOT> my close rate this month" }));
      expect(lastToolResult().content).toMatch(/not on the roster/); expect(posts[0].text).toBe("Who are you in the CRM?");
    });
    it("an unknown metric: the two escalation messages in the thread, the second a real mention; the thread is then the team's", async () => {
      script = [() => call("cannot_answer", { reason: "no metric for a DQL rate" })];
      const ev = msg({ text: "<@UBOT> what was the DQL rate for this month?" });
      expect(await handleMessage(deps(), companyId, ev)).toMatchObject({ answered: "escalate" });
      expect(posts).toEqual([
        { channel: "C-SALES", thread: ev.ts, text: "I'm not sure how to get that information. Let me ping Tyler real quick." },
        { channel: "C-SALES", thread: ev.ts, text: "Hey <@U-TYLER>, can you help?" }]);
      expect(await handleMessage(deps(), companyId, msg({ type: "message", user: "U-TYLER", text: "it's 50%, I'll add it", threadTs: ev.ts }))).toEqual({ ignored: "escalated: the thread is the team's now" });
      const audit = await asOperator((c) => one<{ after: { reason: string } }>(c, "select after from audit_log where company_id=$1 and action='bot.escalated' order by id desc limit 1", [companyId]));
      expect(audit?.after.reason).toBe("no metric for a DQL rate");
    });
    it("a live source that fails is named, not filled", async () => {
      const down = { ...deps(), probes: { ...probes, ghlFreeSlots: async () => ({ ok: false as const, error: "503 down" }) } };
      script = [() => call("get_availability", { days: 7 }), () => call("cannot_answer", { reason: "calendars unreadable" })];
      await handleMessage(down, companyId, msg({ text: "<@UBOT> what does our availability look like?" }));
      expect(posts[0].text).toMatch(/^I couldn't get a live read \(GHL did not answer for any calendar: .*503 down\)\. I'm not sure how to get that information\. Let me ping Tyler real quick\.$/);
    });
    it("a list no metric covers goes through the read-only door and is labelled ad hoc", async () => {
      script = [() => call("run_readonly_query", { sql: "select first_name from contacts where merged_into is null and ghl_added_at >= '2026-10-01' and not ('sys-test' = any(tags)) and first_name <> 'CT2' order by first_name", why: "leads who arrived this month, by name" }), () => call("reply", { result_ids: ["r1"], note: "" })];
      await handleMessage(deps(), companyId, msg({ text: "<@UBOT> list this month's leads" }));
      expect(posts[0].text).toBe("*Ad hoc, from the raw ledger:* leads who arrived this month, by name\n```\nfirst_name\nC1\nC2\nC3\nC4\n```");
    });
    it("ignores its own messages, other bots, edits, and channel chatter outside its threads", async () => {
      expect(await handleMessage(deps(), companyId, msg({ user: "UBOT" }))).toEqual({ ignored: "own message" });
      expect(await handleMessage(deps(), companyId, msg({ user: undefined, botId: "B1" }))).toEqual({ ignored: "own message" });
      expect(await handleMessage(deps(), companyId, msg({ subtype: "message_changed" }))).toEqual({ ignored: "message message_changed" });
      expect(await handleMessage(deps(), companyId, msg({ type: "message", text: "lunch?", threadTs: "1.1" }))).toEqual({ ignored: "a thread the bot is not in" });
      expect(await handleMessage(deps(), companyId, msg({ type: "message", text: "<@UBOT> hi" }))).toEqual({ ignored: "a mention arrives as app_mention" });
      expect(await handleMessage(deps(), companyId, msg({ teamId: "T-OTHER" }))).toEqual({ ignored: "another workspace" });
      expect(posts).toEqual([]); expect(reacts).toEqual([]);
    });
  });

  describe("the doors", () => {
    const sign = (raw: string) => { const ts = String(Math.floor(Date.now() / 1000)); return { "x-slack-request-timestamp": ts, "x-slack-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex")}` }; };
    it("events: a retried delivery is answered once; the bot's own message changes nothing", async () => {
      const { POST } = await import("../../app/api/webhooks/slack/[companyId]/route");
      const raw = JSON.stringify({ type: "event_callback", team_id: "T-BOT", event_id: `Ev-retry-${Date.now()}`, event: { type: "message", channel: "C-SALES", channel_type: "channel", user: "UBOT", text: "Here you go", ts: "1.5", thread_ts: "1.0" } });
      const send = () => POST(new Request("http://x", { method: "POST", body: raw, headers: sign(raw) }), { params: Promise.resolve({ companyId }) });
      expect(await (await send()).json()).toEqual({ ok: true, accepted: true });
      await expect(Promise.all(pending.splice(0))).resolves.toEqual([{ ignored: "own message" }]);
      expect(await (await send()).json()).toEqual({ ok: true, duplicate_delivery: true });
      expect(pending).toHaveLength(0);
    });
    it("slash commands: a bad signature is refused; help and an unreadable period answer at once, privately", async () => {
      const { POST } = await import("../../app/api/webhooks/slack/[companyId]/commands/route");
      const form = (o: Record<string, string>) => new URLSearchParams({ team_id: "T-BOT", user_id: "U-CARA", channel_id: "C-SALES", channel_name: "sales", response_url: "https://hooks.slack.com/commands/x", ...o }).toString();
      const raw = form({ command: "/close-rate", text: "" });
      const bad = await POST(new Request("http://x", { method: "POST", body: raw, headers: { ...sign(raw), "x-slack-signature": "v0=forged" } }), { params: Promise.resolve({ companyId }) });
      expect(bad.status).toBe(401); expect(pending).toHaveLength(0);
      const helpRaw = form({ command: "/help", text: "" });
      const help = await (await POST(new Request("http://x", { method: "POST", body: helpRaw, headers: sign(helpRaw) }), { params: Promise.resolve({ companyId }) })).json();
      expect(help.response_type).toBe("ephemeral"); expect(help.text).toContain("`/close-rate`"); expect(help.text).toContain("<@UBOT> what does our calendar availability look like?");
      const oddRaw = form({ command: "/cash", text: "blorp" });
      const odd = await (await POST(new Request("http://x", { method: "POST", body: oddRaw, headers: sign(oddRaw) }), { params: Promise.resolve({ companyId }) })).json();
      expect(odd).toMatchObject({ response_type: "ephemeral", text: expect.stringContaining("blorp") });
      expect(pending).toHaveLength(0);
    });
  });
});
