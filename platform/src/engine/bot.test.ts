/** The Slack bot (D70): the metric registry on a seeded ledger, the shortcuts, the conversation rules, the doors. A fake Slack and a scripted model keep it deterministic. */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import type { Adapters, BotMessage, BotModel, BotTurn } from "@/adapters/types";
import { encrypt } from "./crypto";
import { fakeAdapters, fakeProbes } from "./test-install";
import type { HealthProbes } from "./health";
import { getAvailability, getMetric, parsePeriod, previousPeriod } from "./metric-registry";
import { formatAnswer, availabilityBody, table, MAX_ROWS } from "./bot-format";
import { handleMessage, planCommand, runCommand, type SlackMessage } from "./bot";

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
const probes: HealthProbes = { ...fakeProbes, ghlFreeSlots: async (_p, cal) => ({ ok: true, slots: (slots[cal] ?? []).length, times: slots[cal] ?? [] }) };
const adapters = (): Adapters => {
  const a = fakeAdapters();
  let ts = 100;
  a.notifier = { ...a.notifier, post: async (_t, channel, text, _as, thread) => { posts.push({ channel, text, thread }); return { ts: `${++ts}.0`, channel }; },
    react: async (_t, ch, t, e) => { reacts.push(`${ch}:${t}:${e}`); return true; }, unreact: async (_t, ch, t, e) => { unreacts.push(`${ch}:${t}:${e}`); return true; } };
  a.bot = model;
  return a;
};
const deps = () => ({ adapters: adapters(), probes, now: NOW });
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
        for (const t of ["audit_log", "bot_threads", "poll_cursors", "alerts", "sends", "runs", "workflow_triggers", "workflows", "webhook_deliveries", "events", "payments", "appointments", "opportunities", "calendars", "contact_identifiers", "contacts", "bindings", "slack_connections", "users", "company_terms"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]);
      }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('Bot Co','bot',$1) returning id", [TZ]))!.id;
      await c.query(`insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories`, [companyId]);
      const term = async (domain: string, cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain=$2 and category=$3", [companyId, domain, cat]))!.id;
      const closing = await term("appointment_type", "closing"), showed = await term("appointment_outcome", "showed"), closed = await term("call_outcome", "closed"), unq = await term("call_outcome", "unqualified");
      const user = async (name: string, email: string, role: string, slack: string | null) => (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, slack_user_id) values ($1,$2,$3,$4,$5) returning id", [companyId, email, name, role, slack]))!.id;
      ids.cara = await user("Cara Closer", "cara@bot.co", "closer", "U-CARA"); ids.dan = await user("Dan Dealer", "dan@bot.co", "closer", null);
      ids.tyler = await user("Tyler Ray", "owner@bot.co", "owner", "U-TYLER");
      await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id) values ($1,'T-BOT',$2,'UBOT')", [companyId, encrypt("xoxb-fake")]);
      for (const [k, kind, v] of [["secret.slack_signing", "secret", SECRET], ["secret.anthropic_key", "secret", "sk-fake"], ["secret.ghl_pit", "secret", "pit"], ["crm.location_id", "id", "LOC"], ["crm.field_contact_lead_source", "id", "F-SRC"], ["bot.escalate_to", "id", "U-TYLER"]])
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
      const appt = (ext: string, ct: string, closer: string, starts: string, booked: string, status: string, outcome: string | null, callOutcome: string | null, extra: { source?: string; tracking?: object } = {}) =>
        c.query("insert into appointments (company_id, contact_id, source, external_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status, outcome_term, call_outcome_term, tracking) values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12)",
          [companyId, ct, extra.source ?? "ghl", ext, closing, closer, L(starts), L(booked), status, outcome, callOutcome, extra.tracking ?? {}]);
      await appt("A1", c1, ids.cara, "2026-10-06T10:00", "2026-10-02T10:00", "confirmed", showed, closed);
      await appt("A2", c2, ids.cara, "2026-10-07T10:00", "2026-10-03T10:00", "noshow", null, null);
      await appt("A3", c3, ids.dan, "2026-10-08T10:00", "2026-10-04T10:00", "confirmed", showed, unq);
      await appt("A4", c4, ids.dan, "2026-10-09T10:00", "2026-10-05T10:00", "confirmed", null, null, { tracking: { utm_source: "google" } });   // due, nothing filed: counts as not showed
      await appt("A5", c4, ids.dan, "2026-10-12T10:00", "2026-10-06T10:00", "confirmed", null, null);   // not due yet
      await appt("A6", c2, ids.cara, "2026-10-08T15:00", "2026-10-04T11:00", "cancelled", null, null);
      await appt("A7", c1, ids.cara, "2026-10-07T12:00", "2026-10-02T11:00", "showed", null, null, { source: "test" });   // harness: never counts
      await c.query("insert into opportunities (company_id, contact_id, status, opened_by, won_at, contract_value) values ($1,$2,'won','test',$3,5000)", [companyId, c1, L("2026-10-06T11:00")]);
      const pay = (ext: string, ct: string | null, amount: number, status: string, at: string, raw: object = {}) => c.query("insert into payments (company_id, contact_id, whop_payment_id, amount, status, paid_at, raw, link_status) values ($1,$2,$3,$4,$5,$6,$7,$8)", [companyId, ct, ext, amount, status, L(at), raw, ct ? "linked" : "unlinked"]);
      await pay("P1", c1, 3000, "succeeded", "2026-10-06T11:00"); await pay("P2", c1, -500, "refunded", "2026-10-08T11:00");
      await pay("P3", null, 1000, "succeeded", "2026-10-07T11:00"); await pay("P4", c2, 999, "succeeded", "2026-10-07T11:00", { simulated: true });
      await pay("P5", c1, 2000, "succeeded", "2026-09-01T11:00");
    });
    const at = (d: string, h: number) => DateTime.fromISO(d, { zone: TZ }).set({ hour: h }).toISO()!;
    slots["CAL-CARA"] = [at("2026-10-10", 14), at("2026-10-10", 15), at("2026-10-10", 16), at("2026-10-11", 9)];
    slots["CAL-DAN"] = [at("2026-10-10", 13), at("2026-10-10", 14), at("2026-10-12", 9), at("2026-10-12", 10), at("2026-10-12", 11), at("2026-10-12", 12)];
  });
  beforeEach(() => { posts = []; reacts = []; unreacts = []; script = []; seen = []; });

  const month = () => parsePeriod("this month", TZ, NOW)!;
  const metric = (m: string, o: { groupBy?: Parameters<typeof getMetric>[2]["groupBy"]; filters?: Parameters<typeof getMetric>[2]["filters"]; period?: ReturnType<typeof month> } = {}) =>
    asOperator((c) => getMetric(c, companyId, { metric: m, period: o.period ?? month(), groupBy: o.groupBy, filters: o.filters, now: NOW.toJSDate() }));

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

  describe("the registry on a seeded ledger", () => {
    it("leads, MQLs, marketing DQs and the financial DQL, by arrival; merged records and other months never count", async () => {
      expect((await metric("leads")).value).toBe(4);
      expect((await metric("mqls")).value).toBe(1);
      expect((await metric("dqls")).value).toBe(2);
      expect((await metric("dqls_financial")).value).toBe(1);
      const r = await metric("mql_rate"); expect(r).toMatchObject({ numerator: 1, denominator: 4, value: 0.25 });
      const by = await metric("leads", { groupBy: "source" });
      expect(Object.fromEntries(by.rows!.map((x) => [x.label, x.value]))).toEqual({ instagram: 2, facebook: 1, google: 1 });
      expect((await metric("leads_showed", { groupBy: "source" })).rows!.map((x) => [x.label, x.value])).toEqual([["instagram", 2]]);
    });
    it("bookings, shows over calls due (an unfiled past call counts as not showed), no-shows, sales DQs, cancellations", async () => {
      expect((await metric("booked")).value).toBe(6);
      expect((await metric("calls_due")).value).toBe(4);
      const sr = await metric("show_rate", { groupBy: "closer" });
      expect(sr).toMatchObject({ value: 0.5, numerator: 2, denominator: 4 });
      expect(sr.rows!.map((x) => [x.label, x.numerator, x.denominator])).toEqual([["Cara Closer", 1, 2], ["Dan Dealer", 1, 2]]);
      expect((await metric("no_shows")).value).toBe(1);
      expect((await metric("sales_dqs")).value).toBe(1);
      expect((await metric("cancellations")).value).toBe(1);
    });
    it("closes over shows, per closer and filtered to one person; revenue", async () => {
      const cr = await metric("close_rate", { groupBy: "closer" });
      expect(cr).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
      expect(cr.rows!.find((x) => x.label === "Cara Closer")).toMatchObject({ value: 1, numerator: 1, denominator: 1 });
      expect(cr.rows!.find((x) => x.label === "Dan Dealer")).toMatchObject({ value: 0, numerator: 0, denominator: 1 });
      expect(await metric("close_rate", { filters: { userId: ids.cara } })).toMatchObject({ value: 1, filters: { closer: "Cara Closer" } });
      expect(await metric("close_rate", { filters: { closer: "dan" } })).toMatchObject({ value: 0, filters: { closer: "Dan Dealer" } });
      await expect(metric("close_rate", { filters: { closer: "Zed" } })).rejects.toThrow(/no one on the roster/);
      expect((await metric("revenue")).value).toBe(5000);
    });
    it("cash is net of refunds; harness payments never count; unlinked money is its own row", async () => {
      expect((await metric("cash_gross")).value).toBe(4000);
      expect((await metric("refunds")).value).toBe(500);
      const net = await metric("cash_collected", { groupBy: "closer" });
      expect(net.value).toBe(3500);
      expect(Object.fromEntries(net.rows!.map((x) => [x.label, x.value]))).toEqual({ "Cara Closer": 2500, unassigned: 1000 });
      await expect(metric("leads", { groupBy: "closer" })).rejects.toThrow(/cannot be split by closer/);
    });
    it("availability: open slots per closer per day from the live calendar read, light days flagged; a source that fails everywhere is an error, not zero", async () => {
      const a = await asOperator((c) => getAvailability(c, companyId, probes, 7, NOW));
      expect(a.source).toBe("GHL, read just now");
      expect(a.days.map((d) => d.total)).toEqual([5, 1, 4, 0, 0, 0, 0]);
      expect(a.closers).toEqual([{ name: "Dan Dealer", per_day: [2, 0, 4, 0, 0, 0, 0], total: 6 }, { name: "Cara Closer", per_day: [3, 1, 0, 0, 0, 0, 0], total: 4 }]);
      expect(a.days.filter((d) => d.light).map((d) => d.label)).toEqual(["Tue Oct 13", "Wed Oct 14", "Thu Oct 15", "Fri Oct 16"]);
      const down: HealthProbes = { ...probes, ghlFreeSlots: async () => ({ ok: false, error: "401 unauthorized" }) };
      await expect(asOperator((c) => getAvailability(c, companyId, down, 7, NOW))).rejects.toThrow(/GHL did not answer.*401/);
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
    it("an answer: key numbers first with their source, the table, then definition and period", async () => {
      const text = formatAnswer([await metric("close_rate", { groupBy: "closer" })]);
      const lines = text.split("\n");
      expect(lines[0]).toBe("*Close rate: 50%*  ·  1 closes ÷ 2 shows  · _from the engine's ledger_");
      expect(text).toContain("Cara Closer        100%       1      1"); expect(text).toMatch(/_Close rate: closes ÷ shows in the same period_/);
      expect(lines[lines.length - 1]).toBe("_Period: Oct 1–10 (America/Phoenix)_");
    });
    it("availability: total per day with light days, then each closer per day", async () => {
      const body = availabilityBody(await asOperator((c) => getAvailability(c, companyId, probes, 3, NOW)));
      expect(body).toContain("Sat Oct 10           5");
      expect(body).toContain("Closer       Sat 10  Sun 11  Mon 12  Total");
      expect(body).toContain("Dan Dealer        2       0       4      6");
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
      expect(lines[1]).toBe("*Leads: 4*  · _from the engine's ledger_  ·  same days last month 0 (▲ 4)");
      expect(lines[4]).toMatch(/^\*Show rate: 50%\*  ·  2 shows ÷ 4 calls due/);
      expect(posts[0].text).toContain("*Cash collected: $3,500*"); expect(posts[0].text).toContain("*Top source by cash: instagram* ($2,500)");
      expect(lines[lines.length - 1]).toBe("_Period: Oct 1–10 (America/Phoenix) · compared with Sep 1–10_");
      const row = await asOperator((c) => one<{ messages: unknown[] }>(c, "select messages from bot_threads where company_id=$1 and channel='C-SALES' and thread_ts=$2", [companyId, (out as { ts: string }).ts]));
      expect(row?.messages).toHaveLength(2);   // anyone follows up in the post's thread
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
      expect(posts[0].text).toContain("Source     Leads  MQLs  Marketing DQs  DQLs (financial)");
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
      expect(posts[0].text.split("\n").slice(0, 2)).toEqual(["*Close rate: 50%*  ·  1 closes ÷ 2 shows  · _from the engine's ledger_", "Cara closed 100% of her shows."]);
      script = [() => call("get_metric", { metric: "leads", period: "this month", group_by: "none", filters: { closer: "", setter: "", source: "", me: false } }),
        () => call("reply", { result_ids: ["r1"], note: "Up 37% on last month." })];   // a number no tool produced: the note is dropped
      posts = [];
      await handleMessage(deps(), companyId, msg({ text: "<@UBOT> leads this month?" }));
      expect(posts[0].text).not.toContain("37%");
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
      expect(posts[0].text.split("\n")[0]).toBe("*Close rate (Cara Closer): 100%*  ·  1 closes ÷ 1 shows  · _from the engine's ledger_");
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
      script = [() => call("run_readonly_query", { sql: "select first_name from contacts where merged_into is null and ghl_added_at >= '2026-10-01' order by first_name", why: "leads who arrived this month, by name" }), () => call("reply", { result_ids: ["r1"], note: "" })];
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
