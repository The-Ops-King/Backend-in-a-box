import { asOperator, one, withScope } from "@/db/client";
import { ownTables } from "@/db/migrate";

/**
 * The read-only query door (D64): the operator's next question, asked in SQL, answered inside the company's row scope.
 * Safety is layered, none of it clever: one SELECT (or WITH) only, no semicolons, a short deny-list of names, the
 * statement wrapped as a subquery with a bound row cap (the extended protocol refuses a second statement), inside a
 * read-only transaction with a statement timeout, run as a role that is under the tenant RLS policy and has no grant on
 * the ciphertext tables, whatever the login user may bypass. Every run is written to audit_log.
 */
export const QUERY_LIMIT_DEFAULT = 200;
export const QUERY_LIMIT_MAX = 2000;
export const QUERY_TIMEOUT_MS = 5000;
/** The role the statement runs as: no login, no RLS bypass, SELECT on our tables except the two below. Created on first use. */
export const QUERY_ROLE = "query_door";
/** Tables that hold ciphertext or Slack credentials: no grant for the role, and refused by name before that. */
export const QUERY_DENY_TABLES = ["bindings", "slack_connections"];
/** Functions that could read files, flip the scope or reach out. */
export const QUERY_DENY = [...QUERY_DENY_TABLES, "set_config", "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file", "lo_import", "lo_export", "dblink", "pg_terminate_backend", "pg_cancel_backend"];
/** Columns dropped from every result: a value that is a standing capability, not a fact about the business. */
export const QUERY_HIDE_COLUMNS = ["report_token", "bot_token", "token_jti"];

export type QueryCheck = { ok: true; sql: string; limit: number } | { ok: false; error: string };

/** Comments out, so the first keyword and the deny-list see the statement itself. */
export const stripSqlComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

export function checkQuery(sql: unknown, limit?: unknown): QueryCheck {
  if (typeof sql !== "string" || !sql.trim()) return { ok: false, error: "sql is required" };
  if (sql.includes(";")) return { ok: false, error: "one statement, no semicolons" };
  const text = stripSqlComments(sql).trim();
  const first = /^([a-z]+)/i.exec(text)?.[1]?.toLowerCase();
  if (first !== "select" && first !== "with") return { ok: false, error: "only a SELECT (or WITH … SELECT) is allowed" };
  const names = new Set((text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []));
  const hit = QUERY_DENY.find((d) => names.has(d));
  if (hit) return { ok: false, error: `${hit} is not readable through this door` };
  let n = QUERY_LIMIT_DEFAULT;
  if (limit !== undefined && limit !== null) {
    n = Number(limit);
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: "limit must be a whole number of rows" };
    if (n > QUERY_LIMIT_MAX) n = QUERY_LIMIT_MAX;
  }
  return { ok: true, sql: text, limit: n };
}

let roleReady: Promise<string | null> | undefined;
/** Makes sure the role exists with today's grants (a table added since gets its grant on the next cold start). Returns why it could not, or null. */
export function ensureQueryRole(): Promise<string | null> {
  return (roleReady ??= asOperator(async (c) => {
    try {
      if (!(await one(c, "select 1 from pg_roles where rolname=$1", [QUERY_ROLE]))) await c.query(`create role ${QUERY_ROLE} nologin nobypassrls`).catch((e) => { if ((e as { code?: string }).code !== "42710") throw e; });
      await c.query(`grant usage on schema public to ${QUERY_ROLE}`);
      const present = new Set((await c.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema='public'")).rows.map((r) => r.table_name));
      const tables = ownTables().filter((t) => present.has(t) && !QUERY_DENY_TABLES.includes(t));
      if (tables.length) await c.query(`grant select on ${tables.join(", ")} to ${QUERY_ROLE}`);
      await c.query(`revoke all on ${QUERY_DENY_TABLES.filter((t) => present.has(t)).join(", ")} from ${QUERY_ROLE}`);
      return null;
    } catch (e) { roleReady = undefined; return `the ${QUERY_ROLE} role could not be set up: ${String((e as Error).message)}`; }
  }));
}

export type QueryResult = { columns: string[]; rows: unknown[][]; row_count: number; ms: number; truncated: boolean };

const cell = (v: unknown): unknown => (Buffer.isBuffer(v) ? `<${v.length} bytes>` : v instanceof Date ? v.toISOString() : v);

/** Runs a checked statement for one company and writes the audit row. Throws on a SQL error (after logging it). */
export async function runQuery(companyId: string, q: { sql: string; limit: number }): Promise<QueryResult> {
  const t0 = Date.now();
  const why = await ensureQueryRole();
  if (why) throw new Error(why);
  try {
    const out = await withScope({ companyId }, async (c) => {
      await c.query("set local transaction_read_only = on");
      await c.query(`set local statement_timeout = ${QUERY_TIMEOUT_MS}`);
      await c.query(`set local role ${QUERY_ROLE}`);
      const r = await c.query({ text: `select * from (${q.sql}) as q limit $1`, values: [q.limit + 1], rowMode: "array" });
      const keep = r.fields.map((f, i) => [f.name, i] as const).filter(([name]) => !QUERY_HIDE_COLUMNS.includes(name));
      const rows = (r.rows as unknown[][]).slice(0, q.limit).map((row) => keep.map(([, i]) => cell(row[i])));
      return { columns: keep.map(([name]) => name), rows, row_count: rows.length, ms: Date.now() - t0, truncated: r.rows.length > q.limit };
    });
    await asOperator((c) => c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'query.ran','company',$2,$3)", [companyId, companyId, { sql: q.sql, limit: q.limit, row_count: out.row_count, truncated: out.truncated, ms: out.ms }]));
    return out;
  } catch (e) {
    const error = String((e as Error).message).slice(0, 500);
    await asOperator((c) => c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'query.failed','company',$2,$3)", [companyId, companyId, { sql: q.sql, limit: q.limit, error, ms: Date.now() - t0 }])).catch(() => {});
    throw e;
  }
}
