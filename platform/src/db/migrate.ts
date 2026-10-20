import { asOperator, db } from "./client";
import { acquireTickLock, releaseTickLock, renewTickLock } from "@/engine/lock";
import { SCHEMA } from "./schema.sql";
import { migrator } from "./migrator";
import { MIGRATIONS } from "./migrations";
export { migrator, type Migrator } from "./migrator";
import { backfillBookingCard } from "@/engine/booking-card";

/**
 * One migration at a time: a lease row like the ticks' (lock.ts), renewed every minute while its migration runs, so a build that dies
 * frees it within MIGRATE_LEASE_SECONDS and a waiting one, which waits longer than that, always gets it.
 */
const MIGRATE_LOCK = "migrate_lock", MIGRATE_LEASE_SECONDS = 180, MIGRATE_RENEW_MS = 60_000, MIGRATE_WAIT_MS = 5 * 60_000;
async function takeMigrateLease(): Promise<string> {
  const until = Date.now() + MIGRATE_WAIT_MS;
  for (;;) {
    const owner = await acquireTickLock(MIGRATE_LEASE_SECONDS, MIGRATE_LOCK);
    if (owner) return owner;
    if (Date.now() > until) throw new Error("another migration has held the migrate lease for over 5 minutes");
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

/**
 * Applies engine/schema.sql to an empty database, then each numbered migration not yet recorded (migrations.ts, D200), then makes sure
 * every tenant table has its row-level security: a deploy with nothing new changes nothing and takes no table lock.
 */
export async function migrate(): Promise<{ applied: boolean; ran: string[]; rlsTables: string[]; rlsFixed: string[]; repaired: string[]; bookingCard: string[]; skipped?: string }> {
  // D151 (audit 2026-10-19): a preview build shares the production database, so only a production deployment migrates it; a
  // preview runs against the schema production has
  const env = process.env.VERCEL_ENV;
  if (env && env !== "production") return { applied: false, ran: [], rlsTables: [], rlsFixed: [], repaired: [], bookingCard: [], skipped: `${env} deployment: the database is production's, migrated only by a production deployment` };
  const conn = await db().connect();
  const c = migrator(conn);
  let lease: string | null = null, renewal: ReturnType<typeof setInterval> | undefined;
  try {
    // one migration at a time (two deploys can build at once): a lease row, pooler-safe, freed by expiry if a build dies
    await c.query(`create table if not exists engine_state (key text primary key, value jsonb not null default '{}', updated_at timestamptz not null default now())`);
    lease = await takeMigrateLease();
    const held = lease;
    renewal = setInterval(() => { void renewTickLock(held, MIGRATE_LOCK, MIGRATE_LEASE_SECONDS).catch(() => {}); }, MIGRATE_RENEW_MS);
    renewal.unref?.();
    const exists = await c.query("select 1 from information_schema.tables where table_name='companies' and table_schema='public'");
    let applied = false;
    if (exists.rowCount === 0) { await c.query(SCHEMA); applied = true; }   // embedded: works inside a serverless bundle, no filesystem path
    await c.query(`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
    const recorded = new Set((await c.query<{ id: string }>("select id from schema_migrations")).rows.map((r) => r.id));
    const ran: string[] = [];
    for (const m of MIGRATIONS) {
      if (recorded.has(m.id)) continue;
      await m.run(c);
      await c.query("insert into schema_migrations (id) values ($1) on conflict do nothing", [m.id]);
      ran.push(m.id);
    }
    // Only OUR tables get the tenant policy. The database may be shared with other apps (a Supabase project is one
    // schema for everything), so "every table with a company_id column" is the wrong set.
    const ours = new Set(ownTables());
    const withCompanyId = await c.query<{ table_name: string }>(
      "select table_name from information_schema.columns where table_schema='public' and column_name='company_id' order by 1",
    );
    const tenantTables = withCompanyId.rows.map((r) => r.table_name).filter((t) => ours.has(t));
    // D200: only a table missing its RLS, its FORCE or its policy is touched (every deploy used to rebuild all of them, 148 table locks)
    const lacking = await c.query<{ t: string }>(`select cl.relname as t from pg_class cl join pg_namespace n on n.oid=cl.relnamespace where n.nspname='public' and cl.relname = any($1::text[])
      and not (cl.relrowsecurity and cl.relforcerowsecurity and exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=cl.relname and p.policyname='tenant_isolation'))`, [tenantTables]);
    const rlsFixed = lacking.rows.map((r) => r.t);
    for (const table_name of rlsFixed) {
      await c.tx(async (c) => {
        await c.query(`alter table ${table_name} enable row level security`);
        await c.query(`alter table ${table_name} force row level security`);
        await c.query(`drop policy if exists tenant_isolation on ${table_name}`);
        await c.query(`create policy tenant_isolation on ${table_name} for all
          using (company_id = nullif(current_setting('app.company_id', true), '')::uuid
                 or current_setting('app.role', true) = 'operator')
          with check (company_id = nullif(current_setting('app.company_id', true), '')::uuid
                 or current_setting('app.role', true) = 'operator')`);
      });
    }
    // Repair: an earlier version applied the policy + FORCE to foreign tables. Remove exactly what we added and leave
    // the table's own RLS setting alone (we cannot know whether it was enabled before us; disabling could expose data).
    const strayPolicies = await c.query<{ tablename: string }>(
      "select tablename from pg_policies where schemaname='public' and policyname='tenant_isolation'",
    );
    const repaired: string[] = [];
    for (const { tablename } of strayPolicies.rows) {
      if (ours.has(tablename)) continue;
      await c.tx(async (c) => {
        await c.query(`drop policy if exists tenant_isolation on ${tablename}`);
        await c.query(`alter table ${tablename} no force row level security`);
      });
      repaired.push(tablename);
    }
    // D104: Call booked's card no longer carries Hair's intake questions; a company that bound them keeps them as its own setting.
    // As the operator: bindings are under FORCE RLS, where this unscoped connection would see no rows.
    const bookingCard = await asOperator((o) => backfillBookingCard(o));
    return { applied, ran, rlsTables: tenantTables, rlsFixed, repaired, bookingCard };
  } finally {
    clearInterval(renewal);
    if (lease) await releaseTickLock(lease, MIGRATE_LOCK).catch(() => {});
    conn.release();
  }
}


/** Table names declared in engine/schema.sql plus engine-internal additions. */
export function ownTables(): string[] {
  const names = [...SCHEMA.matchAll(/create table\s+(?:if not exists\s+)?([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
  return [...new Set([...names, "engine_state"])];
}
