/** The read-only query door (D64): the guard, then the door itself against the database (scope, read-only, timeout, hidden columns, the audit row). */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { checkQuery, QUERY_LIMIT_DEFAULT, QUERY_LIMIT_MAX, runQuery } from "./query";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");

describe("query guard", () => {
  it("allows one SELECT or WITH, comments stripped, with the default limit", () => {
    expect(checkQuery("select 1")).toMatchObject({ ok: true, limit: QUERY_LIMIT_DEFAULT });
    expect(checkQuery("  -- who dialled\n/* block */ WITH x AS (select 1 as a) select * from x")).toMatchObject({ ok: true });
  });
  it("refuses anything that is not a select, a second statement, and the denied names", () => {
    expect(checkQuery("update contacts set tags='{}'")).toMatchObject({ ok: false, error: expect.stringMatching(/only a SELECT/) });
    expect(checkQuery("delete from contacts")).toMatchObject({ ok: false });
    expect(checkQuery("select 1; delete from contacts")).toMatchObject({ ok: false, error: expect.stringMatching(/semicolon/) });
    expect(checkQuery("select '--'; drop table contacts")).toMatchObject({ ok: false, error: expect.stringMatching(/semicolon/) });
    expect(checkQuery("select key, value from bindings")).toMatchObject({ ok: false, error: expect.stringMatching(/bindings/) });
    expect(checkQuery("select * from slack_connections")).toMatchObject({ ok: false });
    expect(checkQuery("select set_config('app.role','operator',true)")).toMatchObject({ ok: false, error: expect.stringMatching(/set_config/) });
    expect(checkQuery("select pg_read_file('/etc/passwd')")).toMatchObject({ ok: false });
    expect(checkQuery("")).toMatchObject({ ok: false }); expect(checkQuery(undefined)).toMatchObject({ ok: false }); expect(checkQuery("/* only a comment */")).toMatchObject({ ok: false });
  });
  it("audit_log stays readable; a column merely named like a denied table is fine", () => {
    expect(checkQuery("select action, after from audit_log")).toMatchObject({ ok: true });
  });
  it("caps the limit", () => {
    expect(checkQuery("select 1", 50)).toMatchObject({ ok: true, limit: 50 });
    expect(checkQuery("select 1", 99_999)).toMatchObject({ ok: true, limit: QUERY_LIMIT_MAX });
    expect(checkQuery("select 1", 0)).toMatchObject({ ok: false }); expect(checkQuery("select 1", "ten")).toMatchObject({ ok: false }); expect(checkQuery("select 1", 2.5)).toMatchObject({ ok: false });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("query door", () => {
  let mine: string, theirs: string;
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      for (const slug of ["query", "query2"]) { const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (co) { for (const t of ["audit_log", "contacts"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); } }
      mine = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('Q','query','America/Phoenix') returning id"))!.id;
      theirs = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('Q2','query2','America/Phoenix') returning id"))!.id;
      await c.query("insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'Q1','Mine'),($1,'Q2','Mine too'),($2,'Q3','Theirs')", [mine, theirs]);
    });
  });
  const q = (sql: string, limit = QUERY_LIMIT_DEFAULT) => runQuery(mine, { sql, limit });

  it("answers inside the company's scope: the other company's rows do not exist", async () => {
    const r = await q("select first_name from contacts order by 1");
    expect(r.columns).toEqual(["first_name"]); expect(r.rows).toEqual([["Mine"], ["Mine too"]]); expect(r.row_count).toBe(2); expect(r.truncated).toBe(false); expect(r.ms).toBeGreaterThanOrEqual(0);
    expect((await q("select count(*)::int as n from contacts where company_id=$1".replace("$1", `'${theirs}'`))).rows).toEqual([[0]]);
  });
  it("runs as the door role, read-only, with the timeout set; caps rows and says so; the ciphertext tables are not even granted", async () => {
    expect((await q("select current_user::text as who, current_setting('transaction_read_only') as ro, current_setting('statement_timeout') as t")).rows).toEqual([["query_door", "on", "5s"]]);
    expect((await q("select has_table_privilege('query_door', 'bindings', 'select') as b, has_table_privilege('query_door', 'slack_connections', 'select') as s, has_table_privilege('query_door', 'audit_log', 'select') as a")).rows).toEqual([[false, false, true]]);
    const r = await q("select g from generate_series(1,5) g", 2);
    expect(r.rows).toEqual([[1], [2]]); expect(r.row_count).toBe(2); expect(r.truncated).toBe(true);
    await expect(q("select pg_sleep(7)")).rejects.toThrow(/statement timeout/);
  });
  it("hides capability columns, renders bytes and dates as text", async () => {
    const r = await q("select 'x' as report_token, 'y'::bytea as b, now() as at, 1 as a");
    expect(r.columns).toEqual(["b", "at", "a"]); expect(r.rows[0][0]).toBe("<1 bytes>"); expect(String(r.rows[0][1])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("writes every run to audit_log, failures too", async () => {
    await q("select 1 as one");
    await expect(q("select nope from contacts")).rejects.toThrow(/nope/);
    const rows = await asOperator((c) => c.query<{ action: string; after: Record<string, unknown> }>("select action, after from audit_log where company_id=$1 and action like 'query.%' order by id", [mine]));
    const ran = rows.rows.filter((r) => r.action === "query.ran"), failed = rows.rows.filter((r) => r.action === "query.failed");
    expect(ran.some((r) => r.after.sql === "select 1 as one" && r.after.row_count === 1)).toBe(true);
    expect(failed.some((r) => String(r.after.sql).includes("nope") && /nope/.test(String(r.after.error)))).toBe(true);
  });
});
