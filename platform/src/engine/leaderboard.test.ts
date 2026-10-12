/** D94: the leaderboard. Closers by cash (closes and close rate beside), setters by sets (the show rate of their sets beside), from the metric registry; the narrow body; /leaderboard; the weekly post. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import type { ContactSnapshot } from "@/adapters/types";
import type { GhlCard, GhlObjectRecord, GhlReads, GhlWonCard } from "@/adapters/ghl/metrics";
import { encrypt } from "./crypto";
import { getMetric, parsePeriod } from "./metric-registry";
import { BOARD_WIDTH, formatLeaderboard, getLeaderboard, type Leaderboard } from "./leaderboard";
import { planCommand, shortcutBody } from "./bot";
import { helpText } from "./bot-format";
import { dispatchSchedules } from "./clock";
import { tick } from "./runner";
import { extractManifest, parseDefinition } from "./definition";
import { fakeAdapters, fakeProbes, installTemplateForTest } from "./test-install";
import { templates } from "@/templates";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";
const MONDAY = DateTime.fromISO("2026-10-12T09:05:00", { zone: TZ }) as DateTime<true>;   // the weekly post's moment: last week is Oct 5–11
const L = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate();
const iso = (at: string) => DateTime.fromISO(at, { zone: TZ }).toUTC().toISO()!;
let companyId: string;

// ---- GHL as the registry reads it live (D73, D75) -------------------------------------------------------------------------
const sc = (id: string, contact: string, at: string, outcome: string, closer: string, setter: string, booked: "setter_set" | "self_booked"): GhlObjectRecord =>
  ({ id, createdAt: "2026-10-01T00:00:00Z", properties: { external_id: `A-${id}`, contact_id: contact, scheduled_at: iso(at), call_date: at.slice(0, 10), closer, setter, outcome, booking_source: booked } });
const salesCalls: GhlObjectRecord[] = [
  sc("S1", "C1", "2026-10-06T10:00", "showed", "James Closer", "Luis Setter", "setter_set"),
  sc("S2", "C2", "2026-10-07T10:00", "showed", "James Closer", "Luis Setter", "setter_set"),
  sc("S3", "C3", "2026-10-08T10:00", "no_show", "Allan Closer", "Luis Setter", "setter_set"),
  sc("S4", "C4", "2026-10-08T11:00", "showed", "Allan Closer", "Sara Setter", "setter_set"),
  sc("S5", "C5", "2026-10-09T10:00", "showed", "James Closer", "Luis Setter", "self_booked"),   // self-booked: a show for James, never a set for anyone (D87)
  sc("S6", "CT", "2026-10-09T12:00", "showed", "Allan Closer", "Sara Setter", "setter_set"),    // the team's test contact: no number counts it
  sc("S7", "C6", "2026-10-10T10:00", "no_show", "Allan Closer", "Sara Setter", "setter_set"),
  sc("S9", "C8", "2026-10-09T14:00", "no_show", "James Closer", "Luis Setter", "setter_set"),   // set the week before, due last week: in Luis's show rate, not his sets
  sc("S10", "C7", "2026-10-16T10:00", "", "James Closer", "Luis Setter", "setter_set"),          // set last week, not due yet
];
const won = (id: string, contact: string, at: string, value: number, tags: string[] = []): GhlWonCard =>
  ({ id, pipelineId: "PIPE-CLOSER", status: "won", monetaryValue: value, wonAt: iso(at), contactId: contact, contactName: contact, contactTags: tags });
const wonCards: GhlWonCard[] = [won("W1", "C1", "2026-10-06T11:00", 3000), won("W2", "CT", "2026-10-09T13:00", 5000, ["sys-test"])];
const pay = (id: string, contact: string, amount: number, at: string, closer: string, setter = ""): GhlObjectRecord =>
  ({ id, createdAt: "2026-10-01T00:00:00Z", properties: { contact_id: contact, amount, type: "deposit", status: "succeeded", occurred_at: iso(at), closer, setter } });
const payments: GhlObjectRecord[] = [pay("P1", "C1", 750, "2026-10-06T11:00", "James Closer", "Luis Setter"), pay("P2", "CT", 999, "2026-10-09T13:00", "Allan Closer")];
const contacts: ContactSnapshot[] = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "CT"].map((id) => ({ id, firstName: id, tags: id === "CT" ? ["sys-test"] : [], customFields: {}, dateAdded: iso("2026-10-01T09:00"), dateUpdated: iso("2026-10-01T09:00") }));
const ghl: GhlReads = {
  contactsAdded: async () => [], wonCards: async () => wonCards, getContact: async (_c, id) => contacts.find((k) => k.id === id) ?? null,
  objectRecords: async (_c, key) => (key === "custom_objects.sales_call" ? salesCalls : key === "custom_objects.payment" ? payments : []),
  fieldCatalog: async () => [], recordContact: async () => null, cards: async (): Promise<GhlCard[]> => [], pipelines: async () => [], users: async () => [],
};

describe.skipIf(!process.env.DATABASE_URL)("the leaderboard (D94)", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const old = await one<{ id: string }>(c, "select id from companies where slug='lboard'");
      if (old) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [old.id]);
        await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [old.id]);
        // whatever else a run of the whole suite left on it (a tick or poll that saw every company): every table with a company_id, until the foreign keys let go
        const tables = (await many<{ t: string }>(c, "select k.table_name as t from information_schema.columns k join information_schema.tables b on b.table_schema=k.table_schema and b.table_name=k.table_name and b.table_type='BASE TABLE' where k.table_schema='public' and k.column_name='company_id' and k.table_name<>'companies'")).map((r) => r.t);
        for (let pass = 0, left = tables; left.length && pass < 10; pass++) {
          const stuck: string[] = [];
          for (const t of left) { await c.query("savepoint lb"); try { await c.query(`delete from ${t} where company_id=$1`, [old.id]); await c.query("release savepoint lb"); } catch { await c.query("rollback to savepoint lb"); stuck.push(t); } }
          left = stuck;
        }
        await c.query("delete from companies where id=$1", [old.id]);
      }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode) values ('Board Co','lboard',$1,'live') returning id", [TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      const closing = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      const user = async (name: string, role: string) => (await one<{ id: string }>(c, "insert into users (company_id, email, name, role) values ($1,$2,$3,$4) returning id", [companyId, `${name.split(" ")[0].toLowerCase()}@board.co`, name, role]))!.id;
      const james = await user("James Closer", "closer"), allan = await user("Allan Closer", "closer");
      await user("Dan Idle", "closer"); await user("Luis Setter", "setter"); await user("Sara Setter", "setter"); await user("Ned Nobody", "setter");
      for (const [k, kind, v] of [["secret.ghl_pit", "secret", "pit"], ["crm.location_id", "id", "LOC"], ["crm.pipeline_closer", "id", "PIPE-CLOSER"], ["crm.object_sales_call", "id", "custom_objects.sales_call"],
        ["sales_call.outcomes", "text", JSON.stringify({ showed: "showed", no_show: "noshow", cancelled: "cancelled" })], ["sales_call.booking_sources", "text", JSON.stringify({ setter: "setter_set", self: "self_booked" })],
        ["test.domains", "text", "test.co"], ["slack.channel.ops", "channel", "C-OPS"], ["slack.channel.reports", "channel", "C-REPORTS"]])
        await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4)", [companyId, k, kind, kind === "secret" ? encrypt(v) : Buffer.from(v)]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
      const ct: Record<string, string> = {};
      for (const k of contacts) ct[k.id] = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, tags) values ($1,$2,$2,$3) returning id", [companyId, k.id, k.tags]))!.id;
      // the bookings (the ledger's sets, D87: booked through a setter link): Luis 4 last week (one not due yet), Sara 2; a self-booked one and the test contact's are nobody's set
      const appt = (ext: string, contact: string, closer: string, starts: string, booked: string, setBy: string | null) =>
        c.query("insert into appointments (company_id, contact_id, external_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status, self_booked, set_by) values ($1,$2,$3,$4,$5,$6,$6,$7,'confirmed',$8,$9)",
          [companyId, ct[contact], ext, closing, closer, L(starts), L(booked), setBy === null, setBy]);
      await appt("A-S1", "C1", james, "2026-10-06T10:00", "2026-10-05T09:00", "Luis Setter");
      await appt("A-S2", "C2", james, "2026-10-07T10:00", "2026-10-05T12:00", "Luis Setter");
      await appt("A-S3", "C3", allan, "2026-10-08T10:00", "2026-10-06T09:00", "Luis Setter");
      await appt("A-S10", "C7", james, "2026-10-16T10:00", "2026-10-09T09:00", "Luis Setter");
      await appt("A-S4", "C4", allan, "2026-10-08T11:00", "2026-10-07T09:00", "Sara Setter");
      await appt("A-S7", "C6", allan, "2026-10-10T10:00", "2026-10-08T09:00", "Sara Setter");
      await appt("A-S5", "C5", james, "2026-10-09T10:00", "2026-10-06T10:00", null);
      await appt("A-S6", "CT", allan, "2026-10-09T12:00", "2026-10-06T11:00", "Sara Setter");
      await appt("A-S9", "C8", james, "2026-10-09T14:00", "2026-09-30T09:00", "Luis Setter");
    });
  });

  const lastWeek = () => parsePeriod("last week", TZ, MONDAY)!;
  const board = (reads: GhlReads = ghl) => asOperator((c) => getLeaderboard(c, companyId, { period: lastWeek(), now: MONDAY.toJSDate() }, reads));

  it("closers by cash with closes and close rate; setters by sets with the show rate of their sets; whole percents; nobody idle; test contacts never count", async () => {
    const lb = await board();
    expect(lb).toMatchObject({ metric: "leaderboard", period_name: "Last week", period_label: "Oct 5–11", timezone: TZ, source: "GHL, read just now and the engine's ledger", from: "2026-10-05", to: "2026-10-11" });
    // James: $750 (the test contact's $999 is nobody's), 1 close of 3 shows (S1, S2, S5); Allan: 1 show (S4; S6 is the test contact's), no close
    expect(lb.closers.map(({ name, cash, closes, shows, close_rate }) => ({ name, cash, closes, shows, close_rate }))).toEqual([
      { name: "James Closer", cash: 750, closes: 1, shows: 3, close_rate: 33 },
      { name: "Allan Closer", cash: 0, closes: 0, shows: 1, close_rate: 0 },
    ]);
    // Luis: 4 sets booked last week; of his set calls due last week (S1, S2, S3, S9) 2 showed. Sara: 2 sets; S4 showed, S7 did not (S6 is the test contact's)
    expect(lb.setters.map(({ name, sets, due, shows, show_rate }) => ({ name, sets, due, shows, show_rate }))).toEqual([
      { name: "Luis Setter", sets: 4, due: 4, shows: 2, show_rate: 50 },
      { name: "Sara Setter", sets: 2, due: 2, shows: 1, show_rate: 50 },
    ]);
    expect(lb.closers.concat().map((x) => x.name)).not.toContain("Dan Idle");
    expect(lb.setters.map((x) => x.name)).not.toContain("Ned Nobody");
  });

  it("every number is the registry's own: cash_collected, close_rate, booked_set and show_rate split by person", async () => {
    const m = (metric: string, groupBy: "closer" | "setter") => asOperator((c) => getMetric(c, companyId, { metric, period: lastWeek(), groupBy, now: MONDAY.toJSDate() }, ghl));
    const lb = await board();
    const cash = await m("cash_collected", "closer"), rate = await m("close_rate", "closer"), sets = await m("booked_set", "setter"), shows = await m("show_rate", "setter");
    for (const k of lb.closers) {
      expect(k.cash).toBe(cash.rows!.find((r) => r.key === k.key)?.value ?? 0);
      expect([k.closes, k.shows]).toEqual([rate.rows!.find((r) => r.key === k.key)!.numerator, rate.rows!.find((r) => r.key === k.key)!.denominator]);
    }
    for (const s of lb.setters) {
      expect(s.sets).toBe(sets.rows!.find((r) => r.key === s.key)!.value);
      expect([s.shows, s.due]).toEqual([shows.rows!.find((r) => r.key === s.key)!.numerator, shows.rows!.find((r) => r.key === s.key)!.denominator]);
    }
    // the show rate by setter is the company's show rate, split: the split adds back up, and a self-booked call is no one's set
    const all = await asOperator((c) => getMetric(c, companyId, { metric: "show_rate", period: lastWeek(), now: MONDAY.toJSDate() }, ghl));
    expect(shows.rows!.reduce((a, r) => a + (r.denominator ?? 0), 0)).toBe(all.denominator);
    expect(shows.rows!.find((r) => r.key === "")).toMatchObject({ numerator: 1, denominator: 1 });   // S5, self-booked
  });

  it("the body: narrow code blocks (no line over 34), whole percents, no source or period words; an empty side is one italic line", async () => {
    const body = formatLeaderboard(await board());
    expect(body).toBe([
      "🏆 *Leaderboard*",
      "*Closers* (by cash)",
      "```",
      "1. James  $750  1 close   33%",
      "2. Allan    $0  0 closes   0%",
      "```",
      "*Setters* (by sets)",
      "```",
      "1. Luis  4 sets  50% showed",
      "2. Sara  2 sets  50% showed",
      "```",
    ].join("\n"));
    expect(body).not.toMatch(/read just now|GHL|ledger|Period|\d+\.\d+%/);
    const quiet: Leaderboard = { metric: "leaderboard", label: "Leaderboard", source: "x", period_label: "Oct 12", period_name: "This week", from: "2026-10-12", to: "2026-10-12", timezone: TZ, closers: [], setters: [] };
    expect(formatLeaderboard(quiet)).toBe("🏆 *Leaderboard*\n*Closers* (by cash)\n_No closes yet._\n*Setters* (by sets)\n_No sets yet._");
  });

  it("long names, big money and two people with one first name still fit a phone: every line in a block is at most 34 characters", () => {
    const lb: Leaderboard = { metric: "leaderboard", label: "Leaderboard", source: "x", period_label: "", period_name: "", from: "", to: "", timezone: TZ,
      closers: [
        { key: "a", name: "Maximiliano Bartholomew-Featherstonehaugh", cash: 1234567, closes: 12, shows: 13, close_rate: 92 },
        { key: "b", name: "Maximiliano Smith", cash: -500, closes: 0, shows: 0, close_rate: null },
        ...Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, name: `Closer Number${i}`, cash: 10, closes: 1, shows: 1, close_rate: 100 })),
      ],
      setters: [{ key: "s", name: "Christopher Wolfeschlegelsteinhausen", sets: 1234, due: 3, shows: 1, show_rate: 33 }, { key: "t", name: "Ann", sets: 1, due: 0, shows: 0, show_rate: null }] };
    const body = formatLeaderboard(lb);
    const inBlocks = body.split("```").filter((_, i) => i % 2 === 1).flatMap((b) => b.split("\n").filter(Boolean));
    expect(inBlocks.length).toBe(13);
    for (const line of inBlocks) expect(line.length, line).toBeLessThanOrEqual(BOARD_WIDTH);
    expect(body).toContain("$1.2M");
    expect(body).toMatch(/^10\. Clo/m);
    expect(body).toMatch(/1 set\s*$/m);         // no set call due yet: no rate, never a made-up 0%
  });

  it("first names, with the last initial when two on one board share one", () => {
    const lb: Leaderboard = { metric: "leaderboard", label: "Leaderboard", source: "x", period_label: "", period_name: "", from: "", to: "", timezone: TZ,
      closers: [{ key: "a", name: "James Closer", cash: 120000, closes: 2, shows: 4, close_rate: 50 }, { key: "b", name: "James Other", cash: 900, closes: 1, shows: 2, close_rate: 50 }, { key: "c", name: "Allan", cash: 0, closes: 0, shows: 1, close_rate: 0 }], setters: [] };
    expect(formatLeaderboard(lb).split("\n").slice(3, 6)).toEqual(["1. James C.  $120k  2 closes  50%", "2. James O.   $900  1 close   50%", "3. Allan        $0  0 closes   0%"]);
  });

  it("GHL with no Payment records yet: cash is not $0, closers are ranked by closes", async () => {
    const lb = await board({ ...ghl, objectRecords: async (_c, key) => (key === "custom_objects.sales_call" ? salesCalls : []) });
    expect(lb.cash_unavailable).toBe("GHL has no Payment records yet");
    expect(lb.closers.map((k) => [k.name, k.cash, k.closes])).toEqual([["James Closer", null, 1], ["Allan Closer", null, 0]]);
    expect(formatLeaderboard(lb)).toContain("1. James  —  1 close   33%");
  });

  it("/leaderboard: a period in words, this week by default; the body is the formatter's", async () => {
    const cmd = (text: string) => planCommand({ command: "/leaderboard", text, userId: "U1", channelId: "C1" }, TZ, MONDAY);
    expect(cmd("")).toEqual({ plan: { shortcut: "leaderboard", title: "Leaderboard · This week", period: parsePeriod("this week", TZ, MONDAY) } });
    expect(cmd("last week")).toMatchObject({ plan: { shortcut: "leaderboard", title: "Leaderboard · Last week", period: { from: "2026-10-05", to: "2026-10-11" } } });
    expect(cmd("this month")).toMatchObject({ plan: { period: { from: "2026-10-01", to: "2026-10-12", name: "This month" } } });
    expect(cmd("someday")).toHaveProperty("error");
    const plan = (cmd("last week") as { plan: Parameters<typeof shortcutBody>[2] }).plan;
    const body = await shortcutBody({ adapters: fakeAdapters(), ghl, now: MONDAY }, companyId, plan, "U-ASKER");
    // D95: the formatter's body, then the one footer every answer carries
    expect(body).toBe(`${formatLeaderboard(await board())}\n\n_Oct 5–11 · From GHL and the engine, read ${MONDAY.setZone(TZ).toFormat("h:mm a ZZZZ")} · Asked by <@U-ASKER>_`);
    expect(helpText()).toContain("`/leaderboard`");
  });

  it("the weekly post: Monday 9:00 company time, last full week, to the ops channel (the reports channel when ops is unbound)", async () => {
    const t = templates.find((x) => x.slug === "weekly-leaderboard")!;
    const def = parseDefinition(t.definition);
    expect(def.nodes.find((n) => n.type === "trigger")).toMatchObject({ schedule: { at: "09:00", days: [1], for: "company" } });
    expect(def.nodes.find((n) => n.type === "leaderboard")).toMatchObject({ period: "last week" });
    expect(extractManifest(def).bindings.find((b) => b.key === "slack.channel.ops")).toMatchObject({ required: false, fallback: "slack.channel.reports" });

    await asOperator((c) => installTemplateForTest(c, companyId, "weekly-leaderboard"));
    expect((await asOperator((c) => dispatchSchedules(c, MONDAY.set({ hour: 8 }) as DateTime<true>, companyId))).started).toEqual([]);   // not before 9
    expect((await asOperator((c) => dispatchSchedules(c, MONDAY.plus({ days: 1 }) as DateTime<true>, companyId))).started).toEqual([]);   // not on a Tuesday
    const started = await asOperator((c) => dispatchSchedules(c, MONDAY, companyId));
    expect(started.started).toEqual([expect.objectContaining({ workflow: "Weekly leaderboard", node: "t_weekly" })]);
    const posts: { channel: string; text: string }[] = [];
    const a = fakeAdapters();
    a.notifier = { ...a.notifier, post: async (_t, channel, text) => { posts.push({ channel, text }); return { ts: "9.1", channel }; } };
    expect(await tick(a, MONDAY, companyId, { ...fakeProbes, ghl })).toMatchObject({ completed: 1, failed: 0 });
    expect(posts).toEqual([{ channel: "C-OPS", text: `${formatLeaderboard(await board())}\n_Last week · Oct 5–11_` }]);
    const step = await asOperator((c) => one<{ result: Record<string, unknown> }>(c, "select s.result from run_steps s join runs r on r.id=s.run_id where r.company_id=$1 and s.node_type='leaderboard'", [companyId]));
    expect(step?.result).toEqual({ period: { from: "2026-10-05", to: "2026-10-11" }, closers: 2, setters: 2 });
    expect(await asOperator((c) => many(c, "select 1 from sends where company_id=$1 and channel='slack'", [companyId]))).toHaveLength(1);
  });
});
