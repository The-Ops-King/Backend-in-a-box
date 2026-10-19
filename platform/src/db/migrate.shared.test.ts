import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "./client";
import { migrate, migrator } from "./migrate";
/** The production database is a shared Supabase project: migrate must never touch another app's tables. */
describe("migrate on a shared database", () => {
  beforeAll(async () => {
    await db().query(`create table if not exists other_app_items (id serial primary key, company_id uuid, body text)`);
    // simulate the damage the first version did to a foreign table
    await db().query(`alter table other_app_items enable row level security`);
    await db().query(`alter table other_app_items force row level security`);
    await db().query(`drop policy if exists tenant_isolation on other_app_items`);
    await db().query(`create policy tenant_isolation on other_app_items for all using (true)`);
  });
  afterAll(async () => { await db().query(`drop table if exists other_app_items`); });
  it("leaves foreign tables out of the tenant set and removes a stray policy + FORCE without disabling RLS", async () => {
    const r = await migrate();
    expect(r.rlsTables).not.toContain("other_app_items");
    expect(r.rlsTables).toContain("contacts");
    expect(r.repaired).toEqual(["other_app_items"]);
    const pol = await db().query(`select 1 from pg_policies where tablename='other_app_items' and policyname='tenant_isolation'`);
    expect(pol.rowCount).toBe(0);
    const cls = await db().query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`select relrowsecurity, relforcerowsecurity from pg_class where relname='other_app_items'`);
    expect(cls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: false });
    const again = await migrate();
    expect(again.repaired).toEqual([]);
  });
  it("D151: a preview deployment does not migrate the database it shares with production", async () => {
    const was = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "preview";
    try { expect(await migrate()).toMatchObject({ applied: false, rlsTables: [], skipped: expect.stringContaining("preview") }); }
    finally { if (was === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = was; }
  });
});

describe("migrator (D151): short transactions that give way to the live engine", () => {
  const T = "migrator_probe";
  beforeAll(async () => { await db().query(`drop table if exists ${T}`); await db().query(`create table ${T} (id int, v text, constraint ${T}_v_check check (v in ('a','b')))`); });
  afterAll(async () => { await db().query(`drop table if exists ${T}`); });

  it("a statement that cannot get its lock gives up after a few seconds and is tried again, not queued ahead of everyone", async () => {
    const holder = await db().connect(), conn = await db().connect();
    const pauses: number[] = [];
    try {
      await holder.query("begin"); await holder.query(`lock table ${T} in access exclusive mode`);
      setTimeout(() => { void holder.query("commit"); }, 4_500);
      await migrator(conn, async (ms) => { pauses.push(ms); }).query(`alter table ${T} add column if not exists w text`);
      expect(pauses.length).toBeGreaterThanOrEqual(1);
      expect((await db().query("select 1 from information_schema.columns where table_name=$1 and column_name='w'", [T])).rowCount).toBe(1);
    } finally { holder.release(); conn.release(); }
  }, 30_000);

  it("a group is all or nothing: a constraint is never left dropped", async () => {
    const conn = await db().connect();
    try {
      await expect(migrator(conn).tx(async (c) => {
        await c.query(`alter table ${T} drop constraint if exists ${T}_v_check`);
        await c.query(`alter table ${T} add constraint ${T}_v_check check (nope in ('a'))`);
      })).rejects.toThrow(/nope/);
      expect((await db().query("select 1 from pg_constraint where conname=$1", [`${T}_v_check`])).rowCount).toBe(1);
    } finally { conn.release(); }
  });
});
