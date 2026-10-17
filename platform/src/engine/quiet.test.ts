/**
 * D124: "for this client I want nothing to post if nothing happened." With the company's reports.quiet_when_empty on, a
 * scheduled wrap-up or leaderboard with nothing in it (by its own numbers, never its words) posts nothing and says why;
 * without it, every post is exactly as before (Hair, PMU). The chart shows the condition only where the setting is on.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "./crypto";
import { parseDefinition, type Definition } from "./definition";
import { templates } from "@/templates";
import { nothingHappened, reportFacts } from "./reports";
import { nothingOnBoard } from "./leaderboard";
import { QUIET_COND, QUIET_WHY, quietWhenEmpty } from "./quiet";
import { dispatchSchedules, fireNow } from "./clock";
import { tick } from "./runner";
import { fakeAdapters, fakeProbes, installTemplateForTest } from "./test-install";
import { installCompany } from "./install";
import { chartOf } from "@/api/words";
import { tidyOf } from "@/chart/pick";
import type { GhlReads } from "@/adapters/ghl/metrics";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const HAS_DB = !!process.env.DATABASE_URL;
const QUIET_SLUGS = ["daily-wrap-up", "weekly-wrap-up", "monthly-wrap-up", "weekly-leaderboard"];
const tpl = (slug: string) => parseDefinition(JSON.parse(JSON.stringify(templates.find((t) => t.slug === slug)!.definition)));
/** The template as it stood before D124: the same definition without the post's quiet_when_empty. */
const before = (slug: string): Definition => { const d = tpl(slug); for (const n of d.nodes) if (n.type === "slack_post") delete n.quiet_when_empty; return d; };

describe("D124: nothing, from the numbers (pure)", () => {
  const zero = { booked: 0, showed: 0, noshow: 0, cancelled: 0, missing: 0, rescheduled: 0 };
  it("a wrap-up is nothing only when every number and call count is zero or unread, nothing was said, and GHL was read", () => {
    expect(nothingHappened({ numbers: {}, calls: null, said: [] })).toBe(true);
    expect(nothingHappened({ numbers: { leads: 0, booked: null, cash_collected: 0 }, calls: zero, said: [] })).toBe(true);
    // GHL's breakdown as the registry hands it over carries its name lists too: empty lists are nothing
    expect(nothingHappened({ numbers: {}, calls: { ...zero, missing_names: [], mismatches: [] } as typeof zero, said: [] })).toBe(true);
    expect(nothingHappened({ numbers: { leads: 1 }, calls: zero, said: [] })).toBeNull();
    expect(nothingHappened({ numbers: { refunds: 200 }, said: [] })).toBeNull();
    expect(nothingHappened({ numbers: {}, calls: { ...zero, showed: 1 }, said: [] })).toBeNull();
    expect(nothingHappened({ numbers: {}, calls: { ...zero, missing: 1 }, said: [] })).toBeNull();
    expect(nothingHappened({ numbers: {}, said: [{ label: "goal", answered: 1, top: [["love", 1]], rest: 0, restKinds: 0 }] })).toBeNull();
    expect(nothingHappened({ numbers: { leads: null }, said: [], ghlError: "(contacts, 503): GHL 503" })).toBeNull();   // not known: the post says GHL could not be read
    expect(nothingHappened({ numbers: {}, said: [], by: { closer: [{ id: "c", name: "Sam", values: { showed: 1 } }], setter: [] } })).toBeNull();
    expect(nothingHappened({ numbers: {}, said: [], by: { closer: [{ id: "c", name: "Sam", values: { showed: 0 } }], setter: [] } })).toBe(true);
    const facts = (numbers: Record<string, number | null>) => reportFacts({ kind: "daily", period: { start: "2026-10-10", end: "2026-10-10" }, tz: "UTC", toDate: false, numbers, said: [] }).nothing;
    expect(facts({ leads: 0 })).toBe(true); expect(facts({ leads: 2 })).toBeNull();
  });
  it("a leaderboard is nothing with no closer cash or close and no sets", () => {
    const closer = { key: "c", name: "Sam", cash: 0, closes: 0, shows: 2, close_rate: 0 }, setter = { key: "s", name: "Lu", sets: 0, due: 3, shows: 1, show_rate: 33 };
    expect(nothingOnBoard({ closers: [], setters: [] })).toBe(true);
    expect(nothingOnBoard({ closers: [closer], setters: [setter] })).toBe(true);
    expect(nothingOnBoard({ closers: [{ ...closer, cash: 500 }], setters: [] })).toBeNull();
    expect(nothingOnBoard({ closers: [{ ...closer, cash: null, closes: 1 }], setters: [] })).toBeNull();   // GHL holds no Payment records: closes say it
    expect(nothingOnBoard({ closers: [], setters: [{ ...setter, sets: 1 }] })).toBeNull();
  });
  it("the setting is on only when it says so", () => {
    for (const v of ["true", "TRUE", "yes", "on", "1"]) expect(quietWhenEmpty({ "reports.quiet_when_empty": v })).toBe(true);
    for (const v of ["false", "", "no", "0"]) expect(quietWhenEmpty({ "reports.quiet_when_empty": v })).toBe(false);
    expect(quietWhenEmpty({})).toBe(false);
  });
});

describe("D124 on the chart (D111, D103)", () => {
  const company = { name: "Acme", timezone: "UTC" };
  const ON = { "reports.quiet_when_empty": "true" };
  it("only the four scheduled posts that can be empty opt in", () => {
    const opted = templates.filter((t) => parseDefinition(t.definition).nodes.some((n) => n.type === "slack_post" && n.quiet_when_empty)).map((t) => t.slug).sort();
    expect(opted).toEqual([...QUIET_SLUGS].sort());
    expect(tpl("weekly-leaderboard").nodes.find((n) => n.id === "n_post")).toMatchObject({ quiet_when_empty: "vars.board.nothing" });
    for (const s of QUIET_SLUGS.slice(0, 3)) expect(tpl(s).nodes.find((n) => n.id === "n_post")).toMatchObject({ quiet_when_empty: "vars.report.nothing" });
  });
  it("with the setting on, the post is a sometimes-step: “only if something happened”, exact at both widths", () => {
    for (const slug of QUIET_SLUGS) {
      const chart = chartOf(tpl(slug), company, ON), post = chart.nodes.find((n) => n.id === "n_post")!;
      expect(post.onlyIf, slug).toBe("something happened");
      expect(post.cond, slug).toBe(QUIET_COND);
      for (const width of [1000, 358]) {
        const t = tidyOf(chart, { width, pathOnly: false });
        expect(t.shown.check.problems, `${slug} ${width}`).toEqual([]);
        expect(t.shown.svg, `${slug} ${width}`).toMatch(/something happened/);
      }
    }
  });
  it("without it (Hair, PMU) or set false, the chart is exactly the chart before D124", () => {
    for (const slug of QUIET_SLUGS) for (const bindings of [{}, { "reports.quiet_when_empty": "false" }, { "slack.channel.reports": "C1" }] as Record<string, string>[]) {
      const now = chartOf(tpl(slug), company, bindings), was = chartOf(before(slug), company, bindings);
      expect(now, slug).toEqual(was);
      expect(now.nodes.find((n) => n.id === "n_post")!.onlyIf).toBeUndefined();
      for (const width of [1000, 358]) expect(tidyOf(now, { width, pathOnly: false }).shown.svg).toBe(tidyOf(was, { width, pathOnly: false }).shown.svg);
    }
  });
});

/** A test company gone with everything that points at it, whatever other tests' ticks left on it (each delete tried in turn until none is refused). */
async function wipe(c: import("pg").PoolClient, slug: string) {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
  await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
  let left = (await many<{ t: string }>(c, "select table_name as t from information_schema.columns where table_schema='public' and column_name='company_id' and table_name<>'companies'")).map((r) => r.t);
  for (let round = 0; left.length && round < 10; round++) {
    const refused: string[] = [];
    for (const t of left) { await c.query("savepoint w"); try { await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("release savepoint w"); } catch { await c.query("rollback to savepoint w"); refused.push(t); } }
    left = refused;
  }
  await c.query("delete from companies where id=$1", [co.id]);
}

describe.skipIf(!HAS_DB)("D124: a scheduled run with nothing in it", () => {
  // a Monday: the daily wrap-up (7pm) and the weekly leaderboard (9am Mondays) are both due at 19:05
  const MON = DateTime.fromISO("2026-10-12T19:05:00", { zone: "UTC" }) as DateTime<true>;
  const posts: { company: string; channel: string; text: string }[] = [];
  const adapters = (slug: string): Adapters => { const a = fakeAdapters(); a.notifier.post = async (_t, channel, text) => { posts.push({ company: slug, channel, text }); return { ts: `ts${posts.length}` }; }; return a; };
  let leads: { id: string; dateAdded: string }[] = [];
  const ghl: GhlReads = { contactsAdded: async () => leads.map((l) => ({ ...l, firstName: l.id, tags: [], customFields: {}, dateUpdated: l.dateAdded })),
    wonCards: async () => [], objectRecords: async () => [], cards: async () => [], pipelines: async () => [], users: async () => [], getContact: async () => null, recordContact: async () => null, fieldCatalog: async () => [] };
  const ids: Record<string, string> = {};

  async function company(slug: string, setting?: string, extra: (c: import("pg").PoolClient, id: string) => Promise<void> = async () => {}) {
    await asOperator(async (c) => {
      await wipe(c, slug);
      const id = ids[slug] = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ($1,$1,'UTC') returning id", [slug]))!.id;
      // what the wrap-up and the leaderboard read (the leaderboard's numbers come from GHL's Sales Calls, D94)
      for (const [k, kind, v] of [["secret.ghl_pit", "secret", "p"], ["crm.location_id", "id", "L"], ["slack.channel.reports", "channel", "CREPORTS"], ["crm.pipeline_closer", "id", "PCLOSER"], ["crm.object_sales_call", "id", "custom_objects.sales_call"],
        ["sales_call.outcomes", "text", JSON.stringify({ showed: "showed", no_show: "noshow", cancelled: "cancelled" })], ["sales_call.booking_sources", "text", JSON.stringify({ setter: "setter_set", self: "self_booked" })]])
        await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4)", [id, k, kind, kind === "secret" ? encrypt(v) : Buffer.from(v)]);
      if (setting !== undefined) await c.query("insert into bindings (company_id,key,kind,value) values ($1,'reports.quiet_when_empty','text',$2)", [id, Buffer.from(setting)]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [id, encrypt("xoxb-fake")]);
      await extra(c, id);
    });
  }
  const run = async (slug: string) => {
    expect((await asOperator((c) => dispatchSchedules(c, MON, ids[slug]))).started.length).toBeGreaterThan(0);
    return tick(adapters(slug), MON, ids[slug], { ...fakeProbes, ghl });
  };
  const steps = (slug: string) => asOperator((c) => many<{ workflow: string; status: string; result: Record<string, unknown> }>(c,
    "select w.name as workflow, s.status, s.result from run_steps s join runs r on r.id=s.run_id join workflows w on w.id=r.workflow_id where r.company_id=$1 and s.node_id='n_post' order by w.name, s.started_at", [ids[slug]]));
  const sends = (slug: string) => asOperator((c) => many<{ status: string; suppressed_reason: string | null; rendered_body: string }>(c, "select status, suppressed_reason, rendered_body from sends where company_id=$1 and channel='slack' order by rendered_body", [ids[slug]]));

  // gone after, so no other test's clock starts these companies' schedules
  afterAll(() => asOperator(async (c) => { for (const slug of ["quiet-on", "quiet-off", "quiet-false", "quiet-busy", "quiet-install"]) await wipe(c, slug); }));
  beforeAll(async () => {
    await migrate();
    await company("quiet-on", "true"); await company("quiet-off"); await company("quiet-false", "false");
    for (const slug of ["quiet-on", "quiet-off", "quiet-false"]) await asOperator(async (c) => { await installTemplateForTest(c, ids[slug], "daily-wrap-up"); await installTemplateForTest(c, ids[slug], "weekly-leaderboard"); });
  });

  it("with the setting on: neither the wrap-up nor the leaderboard posts, and the run says why", async () => {
    leads = []; posts.length = 0;
    expect(await run("quiet-on")).toMatchObject({ completed: 2, failed: 0 });
    expect(posts.filter((p) => p.company === "quiet-on")).toEqual([]);
    expect(await steps("quiet-on")).toEqual([
      { workflow: "Daily wrap-up", status: "skipped", result: { kind: "noop", why: QUIET_WHY } },
      { workflow: "Weekly leaderboard", status: "skipped", result: { kind: "noop", why: QUIET_WHY } },
    ]);
    // the send is kept, suppressed, with what it would have said (the dashboard shows it)
    const s = await sends("quiet-on");
    expect(s.map((x) => [x.status, x.suppressed_reason])).toEqual([["suppressed", "quiet when empty: nothing happened"], ["suppressed", "quiet when empty: nothing happened"]]);
    expect(s.map((x) => x.rendered_body).join("\n")).toContain("Nothing today: no leads, bookings, calls or payments.");
    // the wrap-up itself is still kept in the wrapups ledger, as every report step's is
    expect(await asOperator((c) => many(c, "select 1 from wrapups where company_id=$1", [ids["quiet-on"]]))).toHaveLength(1);
  });

  it("with the setting on and something in the day: the wrap-up posts as it always did", async () => {
    leads = [{ id: "L1", dateAdded: "2026-10-12T10:00:00.000Z" }]; posts.length = 0;
    const id = (await asOperator((c) => one<{ id: string }>(c, "select id from workflows where company_id=$1 and name='Daily wrap-up'", [ids["quiet-on"]])))!.id;
    await asOperator((c) => c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [ids["quiet-on"]]));
    await asOperator((c) => fireNow(c, ids["quiet-on"], id, undefined, MON));   // by hand: posts whatever it holds
    await tick(adapters("quiet-on"), MON, ids["quiet-on"], { ...fakeProbes, ghl });
    expect(posts).toHaveLength(1); expect(posts[0].text).toMatch(/Leads +1/);
    leads = []; posts.length = 0;
    await asOperator((c) => fireNow(c, ids["quiet-on"], id, undefined, MON.plus({ minutes: 1 }) as DateTime<true>));
    await tick(adapters("quiet-on"), MON.plus({ minutes: 1 }) as DateTime<true>, ids["quiet-on"], { ...fakeProbes, ghl });
    expect(posts.map((p) => p.text)).toEqual([expect.stringContaining("Nothing today: no leads, bookings, calls or payments.")]);   // a run started by hand always posts
  });

  it("with something in it, a scheduled run of a quiet company posts", async () => {
    await company("quiet-busy", "true"); await asOperator((c) => installTemplateForTest(c, ids["quiet-busy"], "daily-wrap-up"));
    leads = [{ id: "L1", dateAdded: "2026-10-12T10:00:00.000Z" }]; posts.length = 0;
    expect(await run("quiet-busy")).toMatchObject({ completed: 1, failed: 0 });
    expect(posts).toHaveLength(1); expect(posts[0].text).toMatch(/Leads +1/);
    expect((await steps("quiet-busy"))[0]).toMatchObject({ status: "ok" });
  });

  it("without the setting (Hair, PMU), or set false: both post, byte for byte as the templates before D124 do", async () => {
    leads = [];
    for (const slug of ["quiet-off", "quiet-false"]) {
      // the template before D124 beside the one now, on the same company and the same empty day
      await asOperator(async (c) => {
        for (const s of ["daily-wrap-up", "weekly-leaderboard"]) await installTemplateForTest(c, ids[slug], s, { patch: (d) => { for (const n of d.nodes) if (n.type === "slack_post") delete n.quiet_when_empty; } });
        await c.query("update workflows set name=name||' (before)' where company_id=$1 and id not in (select distinct on (name) id from workflows where company_id=$1 order by name, created_at)", [ids[slug]]);
      });
      posts.length = 0;
      expect(await run(slug)).toMatchObject({ completed: 4, failed: 0 });
      const mine = posts.filter((p) => p.company === slug).map((p) => p.text).sort();
      expect(mine).toHaveLength(4);
      expect(mine[0]).toBe(mine[1]); expect(mine[2]).toBe(mine[3]);   // now and before: the same text
      expect(mine.join("\n")).toContain("Nothing today: no leads, bookings, calls or payments.");
      expect(mine.join("\n")).toContain("🏆 *Leaderboard*");
      const st = await steps(slug);
      expect(st.map((s) => s.status)).toEqual(["ok", "ok", "ok", "ok"]);
      // the step rows match too, but for the post's own ts
      const strip = (r: Record<string, unknown>) => { const { ts: _ts, ...rest } = r; return rest; };
      expect(strip(st[0].result)).toEqual(strip(st[1].result)); expect(strip(st[2].result)).toEqual(strip(st[3].result));
      expect((await sends(slug)).every((s) => s.status !== "suppressed")).toBe(true);
    }
  });

  it("install binds quietWhenEmpty as reports.quiet_when_empty; leaving it out leaves it as it is; false turns it off", async () => {
    const base = { name: "Quiet install", slug: "quiet-install", timezone: "UTC", locationId: "LQ", pit: "pit-x", templates: ["daily-wrap-up"] };
    await asOperator((c) => wipe(c, "quiet-install"));
    const value = async () => (await asOperator((c) => one<{ v: string }>(c, "select convert_from(value,'UTF8') as v from bindings b join companies co on co.id=b.company_id where co.slug='quiet-install' and key='reports.quiet_when_empty'")))?.v ?? null;
    const a = fakeAdapters();
    await installCompany(base, a); expect(await value()).toBeNull();
    await installCompany({ ...base, quietWhenEmpty: true }, a); expect(await value()).toBe("true");
    await installCompany(base, a); expect(await value()).toBe("true");
    await installCompany({ ...base, quietWhenEmpty: false }, a); expect(await value()).toBe("false");
  });
});
