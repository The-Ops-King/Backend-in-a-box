import { db } from "./client";
import { SCHEMA } from "./schema.sql";

/** Every event source the engine writes; one list so an added source cannot be missed by a later constraint rebuild. */
const APPOINTMENT_SOURCES = ["ghl", "calendly", "test"].map((s) => `'${s}'`).join(",");
const EVENT_SOURCES = ["form", "ghl_poll", "whop", "fathom", "zapier", "engine", "disposition", "command_center", "user", "test"].map((s) => `'${s}'`).join(",");

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
    // booking source generalisation (2026-10-06): columns lose their GHL prefix, calendars/appointments carry a source.
    // Renames are guarded so a database created from the current schema.sql passes straight through.
    await c.query(`do $$ begin
      if exists (select 1 from information_schema.columns where table_schema='public' and table_name='calendars' and column_name='ghl_calendar_id') then alter table calendars rename column ghl_calendar_id to external_id; end if;
      if exists (select 1 from information_schema.columns where table_schema='public' and table_name='appointments' and column_name='ghl_appointment_id') then alter table appointments rename column ghl_appointment_id to external_id; end if;
      if exists (select 1 from information_schema.columns where table_schema='public' and table_name='appointments' and column_name='ghl_status') then alter table appointments rename column ghl_status to status; end if;
      if exists (select 1 from information_schema.columns where table_schema='public' and table_name='appointments' and column_name='ghl_updated_at') then alter table appointments rename column ghl_updated_at to source_updated_at; end if;
    end $$`);
    for (const t of ["calendars", "appointments"]) {
      await c.query(`alter table ${t} add column if not exists source text not null default 'ghl'`);
      await c.query(`alter table ${t} drop constraint if exists ${t}_source_check`);
      await c.query(`alter table ${t} add constraint ${t}_source_check check (source in (${t === "appointments" ? APPOINTMENT_SOURCES : "'ghl','calendly'"}))`);   // calendars are only ever real; appointments may be staged by the harness
      await c.query(`alter table ${t} drop constraint if exists ${t}_company_id_${t === "calendars" ? "ghl_calendar_id" : "ghl_appointment_id"}_key`);
      await c.query(`alter table ${t} drop constraint if exists ${t}_company_id_source_external_id_key`);
      await c.query(`alter table ${t} add constraint ${t}_company_id_source_external_id_key unique (company_id, source, external_id)`);
    }
    for (const col of ["name", "ghl_pipeline_id", "ghl_stage_id"]) await c.query(`alter table opportunities drop column if exists ${col}`);   // short-lived 1:1 mirror, replaced by pipeline_cards
    await c.query(`create table if not exists pipeline_cards (
      id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id), opportunity_id uuid not null references opportunities(id), contact_id uuid not null references contacts(id),
      ghl_opportunity_id text, ghl_pipeline_id text not null, ghl_stage_id text not null, name text not null, status text not null default 'open',
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (company_id, ghl_opportunity_id))`);
    await c.query(`create index if not exists pipeline_cards_company_id_contact_id_ghl_pipeline_id_idx on pipeline_cards (company_id, contact_id, ghl_pipeline_id)`);
    await c.query(`alter table pipeline_cards add column if not exists assigned_user_id uuid references users(id)`);
    await c.query(`alter table calendars add column if not exists self_booked boolean`);
    await c.query(`alter table appointments add column if not exists set_by text`);
    await c.query(`alter table appointments add column if not exists reschedule_url text`);
    await c.query(`alter table appointments add column if not exists cancel_url text`);
    await c.query(`alter table appointments add column if not exists tracking jsonb not null default '{}'`);
    await c.query(`alter table appointments add column if not exists cancelled_by text`);
    await c.query(`alter table appointments add column if not exists cancel_reason text`);
    await c.query(`alter table calendars add column if not exists booking_url text`);
    await c.query(`alter table contacts drop constraint if exists contacts_timezone_source_check`);
    await c.query(`alter table contacts add constraint contacts_timezone_source_check check (timezone_source in ('ghl','booking','phone','company_default'))`);
    // payments ledger (D21): unlinked payments, identity columns, derived kind, provider; webhook idempotency; CRM record map
    await c.query(`alter table payments alter column contact_id drop not null`);
    await c.query(`alter table sends alter column contact_id drop not null`);   // team alerts have no contact
    for (const col of ["provider text not null default 'whop'", "kind text", "customer_email text", "customer_phone text", "whop_member_id text", "link_status text not null default 'linked'", "linked_by text"]) await c.query(`alter table payments add column if not exists ${col}`);
    await c.query(`alter table payments drop constraint if exists payments_kind_check`);
    await c.query(`alter table payments add constraint payments_kind_check check (kind in ('deposit','installment','balance','paid_in_full','refund','chargeback','failed'))`);
    await c.query(`alter table payments drop constraint if exists payments_link_status_check`);
    await c.query(`alter table payments add constraint payments_link_status_check check (link_status in ('linked','unlinked'))`);
    await c.query(`alter table payments drop constraint if exists payments_company_id_whop_payment_id_key`);
    await c.query(`alter table payments drop constraint if exists payments_company_id_provider_whop_payment_id_key`);
    await c.query(`alter table payments add constraint payments_company_id_provider_whop_payment_id_key unique (company_id, provider, whop_payment_id)`);
    await c.query(`create index if not exists payments_company_id_link_status_idx on payments (company_id, link_status)`);
    await c.query(`alter table companies add column if not exists contract_value_default numeric(12,2)`);
    await c.query(`insert into event_types values ('payment.refunded','payment'), ('payment.unlinked','payment'), ('payment.linked','payment') on conflict do nothing`);
    await c.query(`create table if not exists webhook_deliveries (company_id uuid not null references companies(id), provider text not null, delivery_id text not null, received_at timestamptz not null default now(), primary key (company_id, provider, delivery_id))`);
    await c.query(`create table if not exists crm_records (id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id), object_key text not null, record_key text not null, ghl_record_id text, contact_id uuid references contacts(id), properties jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (company_id, object_key, record_key))`);
    // call recordings (D22): same ledger shape as payments
    await c.query(`insert into event_types values ('recording.received','call'), ('recording.unlinked','call'), ('recording.linked','call'), ('call.analyzed','call') on conflict do nothing`);
    await c.query(`alter table events drop constraint if exists events_source_check`);
    await c.query(`alter table events add constraint events_source_check check (source in (${EVENT_SOURCES}))`);
    await c.query(`create table if not exists recordings (
      id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id), contact_id uuid references contacts(id), appointment_id uuid references appointments(id),
      provider text not null default 'fathom', external_id text not null, title text, started_at timestamptz not null, ended_at timestamptz, duration_min int, url text, share_url text,
      recorded_by_email text, recorded_by_name text, invitees jsonb not null default '[]', transcript jsonb, summary text, analysis jsonb not null default '{}',
      link_status text not null default 'unlinked' check (link_status in ('linked','unlinked')), linked_by text, unlinked_reason text, raw jsonb not null default '{}', received_at timestamptz not null default now(),
      unique (company_id, provider, external_id))`);
    await c.query(`create index if not exists recordings_company_id_link_status_idx on recordings (company_id, link_status)`);
    await c.query(`create index if not exists recordings_company_id_contact_id_idx on recordings (company_id, contact_id)`);
    // simulation harness (D23): synthetic appointments and events carry source 'test'; dark-hours policy per company
    await c.query(`alter table companies add column if not exists quiet_allow_transactional boolean not null default false`);
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
