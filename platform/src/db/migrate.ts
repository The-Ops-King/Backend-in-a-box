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
    // D51: which mode a run was born in; the column arriving on a database that already has runs stamps them with their company's mode today (every run so far was shadow-born where the company is still in shadow)
    const bornIn = await c.query("select 1 from information_schema.columns where table_name='runs' and column_name='born_in'");
    if (bornIn.rowCount === 0) {
      await c.query(`alter table runs add column born_in text not null default 'live'`);
      await c.query(`update runs r set born_in=co.mode from companies co where co.id=r.company_id`);
    }
    // D52: the mode ladder; the check constraints follow the list in one place
    await c.query(`update companies set mode='test' where mode='rehearsal'`); await c.query(`update runs set born_in='test' where born_in='rehearsal'`);   // the rung existed for an hour (D52 addendum)
    await c.query(`alter table companies drop constraint if exists companies_mode_check`);
    await c.query(`alter table companies add constraint companies_mode_check check (mode in ('shadow','test','live'))`);
    await c.query(`alter table runs drop constraint if exists runs_born_in_check`);
    await c.query(`alter table runs add constraint runs_born_in_check check (born_in in ('shadow','test','live'))`);
    await c.query(`alter table companies add column if not exists reply_retention_days int not null default 7`);
    await c.query(`alter table companies add column if not exists sends_retention_days int not null default 30`);
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
    await c.query(`alter table companies add column if not exists reached_seconds int not null default 60`);   // D29: speed-to-lead "reached" threshold
    await c.query(`alter table contacts add column if not exists ghl_added_at timestamptz`);
    await c.query(`insert into event_types values ('payment.refunded','payment'), ('payment.unlinked','payment'), ('payment.linked','payment') on conflict do nothing`);
    await c.query(`create table if not exists webhook_deliveries (company_id uuid not null references companies(id), provider text not null, delivery_id text not null, received_at timestamptz not null default now(), primary key (company_id, provider, delivery_id))`);
    await c.query(`create table if not exists crm_records (id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id), object_key text not null, record_key text not null, ghl_record_id text, contact_id uuid references contacts(id), properties jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (company_id, object_key, record_key))`);
    // call recordings (D22): same ledger shape as payments
    await c.query(`insert into event_types values ('recording.received','call'), ('recording.unlinked','call'), ('recording.linked','call'), ('call.analyzed','call') on conflict do nothing`);
    await c.query(`insert into event_types values ('call.logged','call') on conflict do nothing`);   // D28: phone calls the CRM's dialer logged
    await c.query(`insert into event_types values ('agreement.sent','agreement'), ('agreement.signed','agreement') on conflict do nothing`);   // D30
    await c.query(`alter table contacts add column if not exists assigned_ghl_user_id text`);
    await c.query(`alter table runs add column if not exists pending_events jsonb not null default '[]'`);
    // runs.trigger_id is history: a template upgrade that drops a trigger node must not be blocked by the runs it once started
    await c.query(`alter table runs drop constraint if exists runs_trigger_id_fkey`);
    await c.query(`alter table runs add constraint runs_trigger_id_fkey foreign key (trigger_id) references workflow_triggers(id) on delete set null`);
    await ownsOrAbsent(c, "agreements", "signed_at");
    await c.query(`create table if not exists agreements (id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade, contact_id uuid references contacts(id), external_id text not null, name text, status text not null, sent_at timestamptz not null, signed_at timestamptz, sent_by text, raw jsonb not null default '{}', updated_at timestamptz not null default now(), unique (company_id, external_id))`);
    await c.query(`create index if not exists agreements_company_id_contact_id_idx on agreements (company_id, contact_id)`);
    // D29: daily rollups, wrap-up schedules and the generated wrap-ups. The database is shared with other apps (a foreign `reports`
    // table exists in production), so each name is checked first: a same-named table that is not ours fails loudly instead of
    // being half-used by `create table if not exists`.
    // the first D29 deploy created two tables under the old names before failing on the foreign "reports"; drop them only if they are ours
    for (const [t, col] of [["metrics_daily", "dimension"], ["report_schedules", "last_period_start"]] as const)
      if ((await c.query("select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2", [t, col])).rowCount) await c.query(`drop table ${t}`);
    for (const [t, col] of [["rollups_daily", "dimension"], ["wrapups", "period_start"]] as const) await ownsOrAbsent(c, t, col);
    await c.query(`create table if not exists rollups_daily (company_id uuid not null references companies(id) on delete cascade, day date not null, dimension text not null, dimension_id text not null default '', metric text not null, value numeric not null default 0, computed_at timestamptz not null default now(), primary key (company_id, day, dimension, dimension_id, metric))`);
    await c.query(`create table if not exists wrapups (id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade, kind text not null, period_start date not null, period_end date not null, generated_at timestamptz not null default now(), on_demand boolean not null default false, body text not null, numbers jsonb not null default '{}', send_id uuid references sends(id) on delete set null)`);
    await c.query(`create index if not exists wrapups_company_id_generated_at_idx on wrapups (company_id, generated_at)`);
    // D33: alerts + the hourly sweep
    for (const [t, col] of [["alerts", "resolved_announced"], ["health_checks", "last_result"]] as const) await ownsOrAbsent(c, t, col);
    await c.query(`create table if not exists alerts (id uuid primary key default gen_random_uuid(), company_id uuid references companies(id) on delete cascade, key text not null, level text not null check (level in ('error','warning')), source text not null check (source in ('step','poll','health','engine')), text text not null, detail jsonb not null default '{}', href text, first_seen timestamptz not null default now(), last_seen timestamptz not null default now(), announced_at timestamptz, announce_count int not null default 0, slack_channel text, slack_ts text, resolved_at timestamptz, resolved_announced boolean not null default false)`);
    await c.query(`create unique index if not exists alerts_open_one on alerts (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), key) where resolved_at is null`);
    await c.query(`create index if not exists alerts_company_id_resolved_at_last_seen_idx on alerts (company_id, resolved_at, last_seen)`);
    await c.query(`create table if not exists health_checks (company_id uuid primary key references companies(id) on delete cascade, enabled boolean not null default true, every_minutes int not null default 60 check (every_minutes between 5 and 1440), channel text, as_name text, as_icon text, checks jsonb not null default '{}', last_run_at timestamptz, last_result jsonb not null default '[]')`);
    // D34: the closer's end-of-day report
    await c.query(`alter table users add column if not exists report_token text unique`);
    await c.query(`alter table users drop constraint if exists users_role_check`);
    await c.query(`alter table users add constraint users_role_check check (role in ('operator','owner','manager','closer','setter','staff'))`);
    await c.query(`insert into core_categories (domain, value, label, sort) values ('call_outcome','deposit','Deposit',4) on conflict (domain, value) do nothing`);
    await c.query(`insert into company_terms (company_id, domain, name, category, is_default, sort) select co.id, 'call_outcome', 'Deposit', 'deposit', true, 4 from companies co where exists (select 1 from company_terms t where t.company_id=co.id and t.domain='call_outcome' and t.category='closed') and not exists (select 1 from company_terms t where t.company_id=co.id and t.domain='call_outcome' and t.category='deposit') on conflict (company_id, domain, name) do nothing`);
    await ownsOrAbsent(c, "eod_reports", "prefill");
    // D35: everything on a clock is a workflow. Runs may be about the company or a person; schedule and eod.filed start them.
    await c.query(`alter table runs alter column contact_id drop not null`);
    await c.query(`alter table runs add column if not exists user_id uuid references users(id)`);
    await c.query(`insert into event_types values ('schedule','clock'), ('eod.filed','report') on conflict do nothing`);
    // D45: a team member's reaction on a post the engine remembered is an event a workflow can start from
    await c.query(`alter table slack_connections add column if not exists bot_user_id text`);
    // D46 column, unused since D54 (the end-of-day form presumes a no-show from the call time alone); left in place, nothing reads it
    await c.query(`alter table appointments add column if not exists presumed_outcome text`);
    await c.query(`insert into event_types values ('slack.reaction','slack') on conflict do nothing`);
    // D48: the three call decisions Jev makes (what kind of recording, what kind of setter call, how the sales call ended)
    await c.query(`insert into core_categories (domain, value, label, sort) values
      ('recording_kind','sales_call','Sales call',1), ('recording_kind','internal','Internal',2), ('recording_kind','other','Other',3),
      ('setter_call_type','setting','Setting call',1), ('setter_call_type','confirmation','Confirmation call',2), ('setter_call_type','other','Other',3),
      ('sales_call_disposition','closed_won','Closed won',1), ('sales_call_disposition','close_pending','Close pending',2), ('sales_call_disposition','follow_up','Follow-up',3), ('sales_call_disposition','lost','Lost',4), ('sales_call_disposition','dq','Disqualified',5), ('sales_call_disposition','financing_denied','Financing denied',6), ('sales_call_disposition','unclear','Unclear',7)
      on conflict (domain, value) do nothing`);
    await c.query(`alter table sends drop constraint if exists sends_channel_check`);
    await c.query(`alter table sends add constraint sends_channel_check check (channel in ('sms','email','slack','webhook'))`);
    await ownsOrAbsent(c, "slack_posts", "tag");
    await c.query(`create table if not exists slack_posts (id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade, tag text not null, channel text not null, ts text not null, run_id uuid references runs(id) on delete set null, posted_at timestamptz not null default now(), unique (company_id, tag))`);
    await c.query(`drop table if exists wrapup_schedules`);
    for (const col of ["enabled", "every_minutes", "checks", "min_slots", "slots_days"]) await c.query(`alter table health_checks drop column if exists ${col}`);
    await c.query(`alter table companies drop column if exists eod_enabled`);
    await c.query(`alter table companies drop column if exists eod_at`);
    // D36: workflows sit on the journey
    for (const t of ["workflow_templates", "workflows"]) { await c.query(`alter table ${t} add column if not exists stage text`); await c.query(`alter table ${t} add column if not exists sort int not null default 0`); await c.query(`alter table ${t} add column if not exists origin text`); }

    await c.query(`create table if not exists eod_reports (id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade, user_id uuid not null references users(id) on delete cascade, day date not null, prefill jsonb, answers jsonb, changes jsonb not null default '[]', reminded_at timestamptz, dm_channel text, dm_ts text, submitted_at timestamptz, unique (company_id, user_id, day))`);
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
    await c.query(`alter table calendars add column if not exists config jsonb not null default '{}'`);
    await c.query(`alter table appointments add column if not exists answers jsonb not null default '{}'`);
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

/** A table we are about to `create if not exists` must be ours (has our sentinel column) or absent; anything else belongs to another app. */
async function ownsOrAbsent(c: import("pg").PoolClient, table: string, sentinelColumn: string): Promise<void> {
  const t = await c.query("select 1 from information_schema.tables where table_schema='public' and table_name=$1", [table]);
  if (t.rowCount === 0) return;
  const col = await c.query("select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2", [table, sentinelColumn]);
  if (col.rowCount === 0) throw new Error(`table "${table}" exists in this database but is not the engine's (no column "${sentinelColumn}"): pick another name or move the engine to its own schema`);
}

/** Table names declared in engine/schema.sql plus engine-internal additions. */
export function ownTables(): string[] {
  const names = [...SCHEMA.matchAll(/create table\s+(?:if not exists\s+)?([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
  return [...new Set([...names, "engine_state"])];
}
