import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | undefined;
/**
 * Supabase's pooler serves two modes on one host: session on 5432 (one server connection per client, capped at the
 * project's pool_size, shared by every app in the project) and transaction on 6543 (many clients, a connection only
 * for the duration of a transaction). Serverless can only live on the second: every warm instance brings its own
 * pool, and three deploys in ten minutes exhausted session mode in production. The engine is transaction-pooler
 * safe by construction (begin/commit around every query, transaction-local set_config, no session locks, no named
 * prepared statements), so a session-mode pooler URL is normalised to transaction mode. Direct connections
 * (db.<ref>.supabase.co) and non-Supabase URLs pass through untouched. DB_POOLER_MODE=session opts out.
 */
export function normalizeDatabaseUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.DB_POOLER_MODE === "session") return url;
  try {
    const u = new URL(url);
    if (u.hostname.endsWith(".pooler.supabase.com") && (u.port === "5432" || u.port === "")) { u.port = "6543"; return u.toString(); }
  } catch { /* not a URL we understand; let pg report it */ }
  return url;
}

export function db(): Pool {
  if (!pool) {
    const raw = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;   // either name; Supabase gives a plain Postgres URL
    if (!raw) throw new Error("DATABASE_URL (or SUPABASE_DB_URL) is not set");
    const url = normalizeDatabaseUrl(raw);
    // Serverless: every warm instance owns a pool, and Supabase's session-mode pooler caps the whole project at 15
    // clients. Keep each instance small and let idle connections go fast so instances do not hoard the budget.
    pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 10_000 });
  }
  return pool;
}

export type Scope = { companyId: string; role?: string } | { role: "operator"; companyId?: undefined };

/** Every query runs inside a scope. RLS reads app.company_id / app.role; FORCE RLS means the owner is not exempt. */
export async function withScope<T>(scope: Scope, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.company_id', $1, true), set_config('app.role', $2, true)", [
      scope.companyId ?? "",
      scope.role ?? (scope.companyId ? "company" : "operator"),
    ]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export const asOperator = <T>(fn: (c: PoolClient) => Promise<T>) => withScope({ role: "operator" }, fn);
export const asCompany = <T>(companyId: string, fn: (c: PoolClient) => Promise<T>) => withScope({ companyId }, fn);

export async function one<R extends QueryResultRow>(c: PoolClient, sql: string, params: unknown[] = []): Promise<R | undefined> {
  const r = await c.query<R>(sql, params);
  return r.rows[0];
}
export async function many<R extends QueryResultRow>(c: PoolClient, sql: string, params: unknown[] = []): Promise<R[]> {
  return (await c.query<R>(sql, params)).rows;
}
