import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "./client";
import { migrate } from "./migrate";
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
});
