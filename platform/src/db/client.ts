import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | undefined;
export function db(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString: url, max: 5 });
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
