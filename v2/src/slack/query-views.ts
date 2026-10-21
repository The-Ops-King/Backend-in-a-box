import { COLUMNS, type ColType, PROJ_TABLES, snake } from "@/projections/tables";
import type { Db } from "./data";

/**
 * The bot's last resort: read-only SQL over one offer's views. The views are made for the one query, inside its own
 * transaction, from the offer's rows only (the projections, its facts, its runs and workflows, without offer_id); the
 * transaction is then made read-only, given a 5-second timeout and a search path of nothing but those views, and rolled
 * back after. The text is checked first: one SELECT, no schema-qualified names, no system catalogs, no quoted or escaped
 * identifiers, no comments, and only functions from a short list (so nothing can switch role or setting).
 */
export const QUERY_TIMEOUT_MS = 5000;
export const MAX_ROWS = 200;

const VIEW_OF: Record<string, { table: string; cols: string[] }> = {
  ...Object.fromEntries(PROJ_TABLES.map((t) => [t === "contacts_index" ? "contacts" : t, { table: t, cols: Object.keys(COLUMNS[t] as Record<string, ColType>).map(snake) }])),
  facts: { table: "events", cols: ["id", "type", "occurred_at", "contact_id", "appointment_id", "deal_id", "source", "payload"] },
  runs: { table: "runs", cols: ["id", "workflow_id", "status", "current_node", "contact_id", "appointment_id", "deal_id", "started_at", "finished_at", "end_reason"] },
  workflows: { table: "workflows", cols: ["id", "key", "name", "enabled", "delivery"] },
};
export const VIEWS = Object.keys(VIEW_OF).sort();

const FUNCTIONS = new Set(["count", "sum", "avg", "min", "max", "coalesce", "nullif", "greatest", "least", "round", "floor", "ceil", "abs", "lower", "upper", "length", "trim", "concat", "substring",
  "date_trunc", "date_part", "extract", "to_char", "now", "jsonb_array_length", "array_length", "cardinality", "unnest", "row_number", "rank", "dense_rank", "lag", "lead", "percentile_cont", "string_agg", "array_agg", "bool_or", "bool_and"]);
/** Words that may stand before a parenthesis without being a function call. */
const KEYWORDS = new Set(["as", "in", "exists", "any", "all", "over", "filter", "from", "join", "on", "and", "or", "not", "select", "where", "when", "then", "else", "by", "cast", "distinct", "having", "with", "lateral", "using", "within", "values", "between", "is"]);
const DENIED = /\b(pg_[a-z_]*|information_schema|public|graphile_worker|drizzle|set_config|current_setting|dblink|lo_[a-z_]+|copy|into|insert|update|delete|merge|create|alter|drop|grant|revoke|truncate|vacuum|analyze|call|do|execute|prepare|listen|notify|lock|reset|set|role|session_user|current_user)\b/i;

export function checkSql(text: string): { ok: true } | { ok: false; why: string } {
  const q = text.trim().replace(/;\s*$/, "");
  if (q.length > 4000) return { ok: false, why: "the query is too long" };
  if (/--|\/\*|\$\$|\bU&|"|\\/i.test(q)) return { ok: false, why: "no comments, quoted identifiers, dollar quotes or escapes" };
  if (!/^(select|with)\b/i.test(q)) return { ok: false, why: "only a SELECT (or WITH … SELECT)" };
  const bare = q.replace(/'(?:[^']|'')*'/g, "''");
  if (bare.includes(";")) return { ok: false, why: "one statement only" };
  const denied = DENIED.exec(bare);
  if (denied) return { ok: false, why: `"${denied[1]}" is not allowed` };
  for (const m of bare.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const w = m[1]!.toLowerCase();
    if (!FUNCTIONS.has(w) && !KEYWORDS.has(w)) return { ok: false, why: `the function ${w} is not allowed` };
  }
  if (/\b[A-Za-z_][A-Za-z0-9_]*\s*\.\s*[A-Za-z_][A-Za-z0-9_]*\s*\.\s*[A-Za-z_]/.test(bare)) return { ok: false, why: "no schema-qualified names" };
  return { ok: true };
}

export type QueryResult = { ok: true; rows: Record<string, unknown>[]; truncated: boolean } | { ok: false; why: string };

export async function queryViews(db: Db, offerId: string, text: string, timeoutMs = QUERY_TIMEOUT_MS): Promise<QueryResult> {
  const checked = checkSql(text);
  if (!checked.ok) return checked;
  const pool = (db as unknown as { $client: import("pg").Pool }).$client;
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const [view, v] of Object.entries(VIEW_OF)) {
      const id = /^[0-9a-f-]{36}$/i.test(offerId) ? offerId : "00000000-0000-0000-0000-000000000000";
      await client.query(`create temp view ${view} as select ${v.cols.map((c) => `"${c}"`).join(", ")} from public.${v.table} where offer_id = '${id}'::uuid`);
    }
    await client.query("set local transaction_read_only = on");
    await client.query(`set local statement_timeout = ${Math.max(100, Math.floor(timeoutMs))}`);
    await client.query("set local search_path = pg_temp");
    // the extended protocol: one statement, never several
    const r = await client.query({ text: text.trim().replace(/;\s*$/, ""), values: [], queryMode: "extended" } as never);
    const rows = (r as { rows: Record<string, unknown>[] }).rows;
    return { ok: true, rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { ok: false, why: code === "57014" ? `the query took longer than ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} seconds` : `${timeoutMs} ms`}` : `the query failed: ${(e as Error).message}` };
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

export const viewColumns = () => Object.fromEntries(Object.entries(VIEW_OF).map(([k, v]) => [k, v.cols]));
