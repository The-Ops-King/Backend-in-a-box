import { db } from "./client";
import { SCHEMA } from "./schema.sql";

/** Applies engine/schema.sql (idempotently: skips if `companies` exists) then forces RLS on every tenant table. */
export async function migrate(): Promise<{ applied: boolean; rlsTables: string[]; repaired: string[] }> {
  const c = await db().connect();
  try {
    const exists = await c.query("select 1 from information_schema.tables where table_name='companies' and table_schema='public'");
    let applied = false;
    if (exists.rowCount === 0) { await c.query(SCHEMA); applied = true; }   // embedded: works inside a serverless bundle, no filesystem path
    // engine-internal additions beyond schema.sql; idempotent so an already-migrated database picks them up
    await c.query(`create table if not exists engine_state (key text primary key, value jsonb not null default '{}', updated_at timestamptz not null default now())`);
    await c.query(`alter table companies add column if not exists sms_enabled boolean not null default true`);
    await c.query(`alter table companies add column if not exists mode text not null default 'shadow'`);
    await c.query(`alter table runs add column if not exists wake_on_reply boolean not null default false`);
    await c.query(`alter table companies drop constraint if exists companies_mode_check`);
    await c.query(`alter table companies add constraint companies_mode_check check (mode in ('shadow','live'))`);
    await c.query(`alter table sends drop constraint if exists sends_status_check`);
    await c.query(`alter table sends add constraint sends_status_check check (status in ('queued','sent','failed','suppressed','shadow'))`);
    // appointments ↔ form_submissions reference each other; the disposition pointer must not block deleting a submission
    await c.query(`alter table appointments drop constraint if exists appointments_disposition_fk`);
    await c.query(`alter table appointments add constraint appointments_disposition_fk foreign key (disposition_id) references form_submissions(id) on delete set null`);
    // Only OUR tables get the tenant policy. The database may be shared with other apps (a Supabase project is one
    // schema for everything), so "every table with a company_id column" is the wrong set.
    const ours = new Set(ownTables());
    const withCompanyId = await c.query<{ table_name: string }>(
      "select table_name from information_schema.columns where table_schema='public' and column_name='company_id' order by 1",
    );
    const tenantTables = withCompanyId.rows.map((r) => r.table_name).filter((t) => ours.has(t));
    for (const table_name of tenantTables) {
      await c.query(`alter table ${table_name} enable row level security`);
      await c.query(`alter table ${table_name} force row level security`);
      await c.query(`drop policy if exists tenant_isolation on ${table_name}`);
      await c.query(`create policy tenant_isolation on ${table_name} for all
        using (company_id = nullif(current_setting('app.company_id', true), '')::uuid
               or current_setting('app.role', true) = 'operator')
        with check (company_id = nullif(current_setting('app.company_id', true), '')::uuid
               or current_setting('app.role', true) = 'operator')`);
    }
    // Repair: an earlier version applied the policy + FORCE to foreign tables. Remove exactly what we added and leave
    // the table's own RLS setting alone (we cannot know whether it was enabled before us; disabling could expose data).
    const strayPolicies = await c.query<{ tablename: string }>(
      "select tablename from pg_policies where schemaname='public' and policyname='tenant_isolation'",
    );
    const repaired: string[] = [];
    for (const { tablename } of strayPolicies.rows) {
      if (ours.has(tablename)) continue;
      await c.query(`drop policy if exists tenant_isolation on ${tablename}`);
      await c.query(`alter table ${tablename} no force row level security`);
      repaired.push(tablename);
    }
    return { applied, rlsTables: tenantTables, repaired };
  } finally {
    c.release();
  }
}

/** Table names declared in engine/schema.sql plus engine-internal additions. */
export function ownTables(): string[] {
  const names = [...SCHEMA.matchAll(/create table\s+(?:if not exists\s+)?([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
  return [...new Set([...names, "engine_state"])];
}
