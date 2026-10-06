import { db } from "./client";
import { SCHEMA } from "./schema.sql";

/** Applies engine/schema.sql (idempotently: skips if `companies` exists) then forces RLS on every tenant table. */
export async function migrate(): Promise<{ applied: boolean; rlsTables: string[] }> {
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
    const tenantTables = await c.query<{ table_name: string }>(
      "select table_name from information_schema.columns where table_schema='public' and column_name='company_id' order by 1",
    );
    for (const { table_name } of tenantTables.rows) {
      await c.query(`alter table ${table_name} enable row level security`);
      await c.query(`alter table ${table_name} force row level security`);
      await c.query(`drop policy if exists tenant_isolation on ${table_name}`);
      await c.query(`create policy tenant_isolation on ${table_name} for all
        using (company_id = nullif(current_setting('app.company_id', true), '')::uuid
               or current_setting('app.role', true) = 'operator')
        with check (company_id = nullif(current_setting('app.company_id', true), '')::uuid
               or current_setting('app.role', true) = 'operator')`);
    }
    return { applied, rlsTables: tenantTables.rows.map((r) => r.table_name) };
  } finally {
    c.release();
  }
}
