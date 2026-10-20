/** D98: each company ticks on its own (its own lease, poll, runs, alerts and clock); the engine's minute watches for a company that stopped; the scheduler fires one request per company. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asOperator, db, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { fakeAdapters } from "@/engine/test-install";
import { raise } from "@/engine/alerts";
import { acquireTickLock, companyLock, LEGACY_LOCK, releaseTickLock } from "./lock";
import { companyClock, STALE_KEY, tickCompany, tickEngine, tickEveryone, type CompanyClock } from "./ticks";
import { tickCommand } from "./schedule";
import type { Adapters } from "@/adapters/types";
import { runningSql } from "./running";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUGS = ["tka", "tkb", "tkz"];
let A: string, B: string, Z: string;
const slowA = { ms: 0, fails: false };
const base = fakeAdapters();
const adapters: Adapters = { ...base, read: { ...base.read, contactsChangedSince: async (co) => {
  if (co.id === A) { if (slowA.ms) await new Promise((r) => setTimeout(r, slowA.ms)); if (slowA.fails) throw new Error("GHL 429 Too Many Requests"); }
  return [];
} } };
const clock = (id: string) => asOperator((c) => one<{ value: CompanyClock }>(c, "select value from engine_state where key=$1", [companyClock(id)])).then((r) => r?.value);
const openKeys = (id: string) => asOperator((c) => many<{ key: string }>(c, "select key from alerts where company_id=$1 and resolved_at is null order by key", [id])).then((r) => r.map((x) => x.key));
const definition = { schema: 1, reentry: "always", nodes: [{ id: "t1", type: "trigger", event: "tag.added" }, { id: "g1", type: "set_tag", tag: ["stat-x"] }, { id: "x1", type: "exit", reason: "done" }], edges: [{ from: "t1", to: "g1" }, { from: "g1", to: "x1" }] };
const failedRun = (companyId: string, key: string) => asOperator(async (c) => {
  const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Tag it','always',true) returning id", [companyId]))!;
  await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,'{}')", [wf.id, definition]);
  await c.query("insert into runs (company_id, workflow_id, workflow_version, status, current_node, exit_reason, reentry_key, finished_at) values ($1,$2,1,'failed','g1','GHL 500 on tags',$3,now())", [companyId, wf.id, key]);
  return wf.id;
});

describe.skipIf(!process.env.DATABASE_URL)("each company ticks on its own (D98)", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      for (const co of await many<{ id: string }>(c, "select id from companies where slug = any($1)", [SLUGS])) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
        await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["alerts", "sends", "runs", "events", "contact_identifiers", "contacts", "workflow_triggers", "workflows", "calendars", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from engine_state where key = any($1)", [[`scheduler:${co.id}`, `alerts_cursor:${co.id}`, `tick_lock:${co.id}`]]);
        await c.query("delete from companies where id=$1", [co.id]);
      }
      const mk = async (slug: string, status = "active") => {
        const id = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status) values ($1,$1,'UTC',$2) returning id", [slug, status]))!.id;
        await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3)", [id, Buffer.from(`L-${slug}`), encrypt("p")]);
        return id;
      };
      A = await mk("tka"); B = await mk("tkb"); Z = await mk("tkz", "archived");
      await c.query("insert into engine_state (key, value, updated_at) values ('alerts_cursor', $1, now()) on conflict (key) do update set value=$1", [{ since: new Date(Date.now() - 1000).toISOString() }]);
      await c.query("insert into engine_state (key, value, updated_at) values ('scheduler', $1, now()) on conflict (key) do update set value=$1", [{ last_tick: new Date().toISOString() }]);   // the engine ticked a moment ago
    });
  });
  afterAll(async () => {
    await asOperator(async (c) => {
      await c.query("update companies set status='archived' where slug = any($1)", [SLUGS]);   // other suites' whole-engine polls and ticks need not visit these
      await c.query("delete from alerts where key=$1", [STALE_KEY]);   // the engine-minute test found every other suite's company stale too
    });
  });

  it("a slow, failing company does not hold another up: B's tick finishes while A's is still reading, and records its own clock with where its time went", async () => {
    await tickCompany(adapters, A);   // the baseline: a read that fails before it is not counted (the first poll is silent)
    slowA.ms = 2500; slowA.fails = true;
    let aDone = false;
    const a = tickCompany(adapters, A).then((r) => { aDone = true; return r; });
    await new Promise((r) => setTimeout(r, 200));   // A holds its lease and is inside its contacts read
    const b = await tickCompany(adapters, B);
    expect(aDone).toBe(false);
    expect(b).toMatchObject({ busy: false, slug: "tkb", errors: [] });
    const cb = await clock(B);
    expect(cb).toMatchObject({ claimed: 0, completed: 0, failed: 0, errors: [], recovery: false });   // its first own tick reads the engine's clock: the upgrade is not a gap
    expect(Date.now() - new Date(cb!.last_tick!).getTime()).toBeLessThan(5000);
    expect(Object.keys(cb!.poll_ms!)).toEqual(expect.arrayContaining(["setup", "contacts", "conversations", "calls", "agreements", "cards"]));
    expect(typeof cb!.schedules_ms).toBe("number"); expect(typeof cb!.runs_ms).toBe("number"); expect(typeof cb!.alerts_ms).toBe("number");
    const ra = await a;
    expect(ra).toMatchObject({ busy: false, slug: "tka" });
    const ca = await clock(A);
    expect(ca!.ms).toBeGreaterThanOrEqual(2500); expect(ca!.poll_ms!.contacts).toBeGreaterThanOrEqual(2500);
    expect(ca!.errors).toEqual([expect.stringMatching(/^poll contacts: GHL 429/)]);
    // the second failure in a row is an alert, A's alone
    slowA.ms = 0;
    await tickCompany(adapters, A); await tickCompany(adapters, B);
    expect(await openKeys(A)).toEqual(["poll:contacts"]);
    expect(await openKeys(B)).toEqual([]);
    slowA.fails = false;
    await tickCompany(adapters, A);
    expect(await openKeys(A)).toEqual([]);
  });

  it("one lease per company: a second tick for the same company is busy, a tick for another company is not", async () => {
    slowA.ms = 1500;
    const [x, y, other] = await Promise.all([tickCompany(adapters, A), new Promise((r) => setTimeout(r, 200)).then(() => tickCompany(adapters, A)), new Promise((r) => setTimeout(r, 200)).then(() => tickCompany(adapters, B))]);
    slowA.ms = 0;
    expect(x.busy).toBe(false);
    expect(y).toMatchObject({ busy: true, slug: "tka" });
    expect(other.busy).toBe(false);
    // the lease is the company's own: held by hand, A is busy and B is not
    const held = await acquireTickLock(60, companyLock(A));
    expect(held).toBeTruthy();
    expect((await tickCompany(adapters, A)).busy).toBe(true);
    expect((await tickCompany(adapters, B)).busy).toBe(false);
    await releaseTickLock(held!, companyLock(A));
    expect((await tickCompany(adapters, A)).busy).toBe(false);
    // during a rollout an older deployment's engine-wide tick may still be finishing: no company tick polls beside it
    const legacy = await acquireTickLock(60, LEGACY_LOCK);
    try { expect(await tickCompany(adapters, B)).toMatchObject({ busy: true, why: expect.stringMatching(/older deployment/) }); }
    finally { await releaseTickLock(legacy!, LEGACY_LOCK); }
  });

  it("a company that is not active does not tick", async () => {
    expect(await tickCompany(adapters, Z)).toMatchObject({ busy: false, skipped: "company is not active" });
    expect(await clock(Z)).toBeUndefined();
  });

  it("a company's tick raises and announces only its own alerts, from its own cursor", async () => {
    const before = (await asOperator((c) => one<{ value: { since: string } }>(c, "select value from engine_state where key='alerts_cursor'")))!.value.since;
    const wfB = await failedRun(B, "tk-b-1");
    const other = await asOperator((c) => raise(c, { companyId: B, key: "x:b-only", level: "warning", source: "engine", text: "B's own" }));
    await tickCompany(adapters, A);
    expect(await openKeys(A)).toEqual([]);
    expect(await openKeys(B)).toEqual(["x:b-only"]);   // A's look at failed runs never saw B's
    expect((await asOperator((c) => one<{ announced_at: Date | null }>(c, "select announced_at from alerts where id=$1", [other.id])))!.announced_at).toBeNull();   // nor announced B's alert
    const cursors = await asOperator((c) => many<{ key: string }>(c, "select key from engine_state where key = any($1) order by key", [[`alerts_cursor:${A}`, `alerts_cursor:${B}`]]));
    expect(cursors.map((r) => r.key)).toEqual([`alerts_cursor:${A}`, `alerts_cursor:${B}`].sort());   // each its own (B's from its earlier ticks)
    expect((await asOperator((c) => one<{ value: { since: string } }>(c, "select value from engine_state where key='alerts_cursor'")))!.value.since).toBe(before);   // the engine-wide one is untouched
    // B's own cursor stood before its failed run: B's next tick raises it and announces its own alert
    await asOperator((c) => c.query("update engine_state set value=$2 where key=$1", [`alerts_cursor:${B}`, { since: new Date(Date.now() - 60_000).toISOString() }]));
    await tickCompany(adapters, B);
    expect(await openKeys(B)).toEqual([`step:${wfB}:g1`, "x:b-only"]);
    expect((await asOperator((c) => one<{ announced_at: Date | null }>(c, "select announced_at from alerts where id=$1", [other.id])))!.announced_at).not.toBeNull();
    await asOperator((c) => c.query("update alerts set resolved_at=now(), resolved_announced=true where company_id=$1 and resolved_at is null", [B]));
  });

  it("a company's gap is its own: after more than ten minutes without its own tick, its runs come back in recovery", async () => {
    await asOperator((c) => c.query("update engine_state set value = value || $2 where key=$1", [companyClock(A), { last_tick: new Date(Date.now() - 20 * 60e3).toISOString() }]));
    await tickCompany(adapters, A);
    expect((await clock(A))!.recovery).toBe(true);
    expect((await clock(B))!.recovery).toBe(false);
    await tickCompany(adapters, A);
    expect((await clock(A))!.recovery).toBe(false);
  });

  it("the engine's minute: a company whose last tick is over five minutes old gets engine:company_stale; a fresh tick resolves it", async () => {
    await tickCompany(adapters, B);
    await asOperator((c) => c.query("update engine_state set value = value || $2 where key=$1", [companyClock(A), { last_tick: new Date(Date.now() - 7 * 60e3).toISOString() }]));
    const e1 = await tickEngine(adapters);
    expect(e1.busy).toBe(false);
    expect(await openKeys(A)).toEqual([STALE_KEY]);
    expect(await openKeys(B)).toEqual([]);
    expect(await openKeys(Z)).toEqual([]);   // archived: not expected to tick
    const heartbeat = await asOperator((c) => one<{ value: { last_tick: string } }>(c, "select value from engine_state where key='scheduler'"));
    expect(Date.now() - new Date(heartbeat!.value.last_tick).getTime()).toBeLessThan(5000);
    await tickCompany(adapters, A);
    await tickEngine(adapters);
    expect(await openKeys(A)).toEqual([]);
  });

  it("with no parameters every company ticks in turn; one whose lease is held is skipped and reported, the others still tick", async () => {
    const held = await acquireTickLock(120, companyLock(A));
    const lastB = (await clock(B))!.last_tick!;
    try {
      const out = await tickEveryone(adapters);
      expect(out.busy).toContain("tka");
      const mine = out.companies.filter((x) => x.company === A || x.company === B);
      expect(mine.map((x) => [x.slug, x.busy])).toEqual([["tka", true], ["tkb", false]]);
      expect(out.companies.some((x) => x.company === Z)).toBe(false);
      expect(out.engine.busy).toBe(false);
      expect((await clock(B))!.last_tick! > lastB).toBe(true);
    } finally { await releaseTickLock(held!, companyLock(A)); }
  }, 120_000);

  it("the scheduler's command fires one request per active company plus one for the engine", async () => {
    const cmd = tickCommand("https://x.test", "s3cret");
    expect(cmd.match(/net\.http_get/g)).toHaveLength(1);   // one statement, one call per row
    expect(cmd).toMatch(/timeout_milliseconds := 310000/);
    const c = await db().connect();
    try {
      if ((await c.query("select 1 from pg_namespace where nspname='net'")).rowCount) return;   // a real pg_net here: do not stub over it
      await c.query("begin");
      await c.query("create schema net");
      await c.query("create table net.calls (url text, headers jsonb, timeout_ms int)");
      await c.query("create function net.http_get(url text, headers jsonb, timeout_milliseconds int) returns bigint language sql as $$ insert into net.calls values (url, headers, timeout_milliseconds) returning 1::bigint $$");
      await c.query(cmd);
      const calls = (await c.query<{ url: string; headers: { Authorization: string }; timeout_ms: number }>("select * from net.calls")).rows;
      const ticking = Number((await c.query(`select count(*) from companies co where ${runningSql()}`)).rows[0].count);
      expect(calls).toHaveLength(ticking + 1);
      const urls = calls.map((r) => r.url);
      expect(urls.filter((u) => u === "https://x.test/api/tick?scope=engine")).toHaveLength(1);
      expect(urls).toContain(`https://x.test/api/tick?company=${A}`); expect(urls).toContain(`https://x.test/api/tick?company=${B}`);
      expect(urls).not.toContain(`https://x.test/api/tick?company=${Z}`);
      expect(new Set(calls.map((r) => r.headers.Authorization))).toEqual(new Set(["Bearer s3cret"]));
      expect(calls.every((r) => r.timeout_ms >= 300_000)).toBe(true);
      // of our three companies, exactly the two active ones (and the engine): 3 requests
      expect(urls.filter((u) => u.endsWith("scope=engine") || [A, B, Z].some((id) => u.endsWith(id)))).toHaveLength(3);
    } finally { await c.query("rollback").catch(() => {}); c.release(); }
  });

  it("D193: with the key in Vault, the job's command holds no secret and reads it when it runs", async () => {
    const cmd = tickCommand("https://x.test", "s3cret", undefined, "vault");
    expect(cmd).not.toContain("s3cret");
    expect(cmd).toContain("vault.decrypted_secrets");
    const c = await db().connect();
    try {
      if ((await c.query("select 1 from pg_namespace where nspname in ('net','vault')")).rowCount) return;   // a real pg_net or Vault here: do not stub over them
      await c.query("begin");
      await c.query("create schema net"); await c.query("create schema vault");
      await c.query("create table net.calls (url text, headers jsonb, timeout_ms int)");
      await c.query("create function net.http_get(url text, headers jsonb, timeout_milliseconds int) returns bigint language sql as $$ insert into net.calls values (url, headers, timeout_milliseconds) returning 1::bigint $$");
      await c.query("create view vault.decrypted_secrets as select 'bb_operator_key'::text as name, 'from-vault'::text as decrypted_secret");
      await c.query(cmd);
      const auth = new Set((await c.query<{ a: string }>("select headers->>'Authorization' as a from net.calls")).rows.map((r) => r.a));
      expect(auth).toEqual(new Set(["Bearer from-vault"]));
    } finally { await c.query("rollback").catch(() => {}); c.release(); }
  });
});
