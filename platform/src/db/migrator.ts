import type { PoolClient, QueryResult, QueryResultRow } from "pg";

/** Every event source the engine writes; one list so an added source cannot be missed by a later constraint rebuild. */
export const APPOINTMENT_SOURCES = ["ghl", "calendly", "test"].map((s) => `'${s}'`).join(",");
export const EVENT_SOURCES = ["form", "ghl_poll", "whop", "fathom", "zapier", "slack", "engine", "disposition", "command_center", "user", "test"].map((s) => `'${s}'`).join(",");

/**
 * D151: the migration runs against a database the live engine is using every minute, so it never holds a lock for long. Each
 * statement is its own transaction that gives up on a lock after a few seconds (and is tried again after a pause) rather than
 * queueing ahead of the engine's own queries, and on its last try waits for it; `tx` keeps a group on one table together (a constraint dropped and added again,
 * a once-only marker and its update), re-run whole on a retry. One big transaction deadlocked with a tick (2026-10-19).
 */
export type Migrator = {
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  tx<T>(fn: (c: Migrator) => Promise<T>): Promise<T>;
};
// a few short tries that step aside for the engine, then one that waits as long as it takes (the way every deploy used to): a busy
// engine can slow a migration down but never fail it
const LOCK_TRIES = 5, lockTimeout = (i: number) => (i < LOCK_TRIES ? "3s" : "0");
const lockedOut = (e: unknown) => ["55P03", "40P01"].includes((e as { code?: string }).code ?? "");   // lock_not_available, deadlock_detected
export function migrator(conn: PoolClient, pause = (ms: number) => new Promise((r) => setTimeout(r, ms))): Migrator {
  let inTx = false;
  const attempt = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let i = 1; ; i++) {
      await conn.query("begin");
      try {
        await conn.query("select set_config('lock_timeout', $1, true)", [lockTimeout(i)]);
        const out = await fn();
        await conn.query("commit");
        return out;
      } catch (e) {
        await conn.query("rollback").catch(() => {});
        if (!lockedOut(e) || i >= LOCK_TRIES + 3) throw e;   // past the short tries only a deadlock comes back here
        await pause(Math.min(500 * 2 ** (i - 1), 8_000));
      }
    }
  };
  // a statement with no parameters goes in one round trip with its own begin and commit (about 300 of them a deploy, over the
  // network to the database: four round trips each took a build's migration from under a minute to three)
  const single = async <R extends QueryResultRow>(sql: string): Promise<QueryResult<R>> => {
    for (let i = 1; ; i++) {
      try {
        const res = (await conn.query(`begin; select set_config('lock_timeout', '${lockTimeout(i)}', true); ${sql}; commit`)) as unknown as QueryResult<R>[];
        if (res[res.length - 1].command === "ROLLBACK") throw new Error(`migration statement rolled back: ${sql.slice(0, 120)}`);
        return res[2];
      } catch (e) {
        await conn.query("rollback").catch(() => {});
        if (!lockedOut(e) || i >= LOCK_TRIES + 3) throw e;   // past the short tries only a deadlock comes back here
        await pause(Math.min(500 * 2 ** (i - 1), 8_000));
      }
    }
  };
  const m: Migrator = {
    query: (sql, params) => (inTx ? conn.query(sql, params) : params?.length ? attempt(() => conn.query(sql, params)) : single(sql)),
    tx: async (fn) => {
      if (inTx) return fn(m);
      inTx = true;
      try { return await attempt(() => fn(m)); } finally { inTx = false; }
    },
  };
  return m;
}

/** A table we are about to `create if not exists` must be ours (has our sentinel column) or absent; anything else belongs to another app. */
export async function ownsOrAbsent(c: Migrator, table: string, sentinelColumn: string): Promise<void> {
  const t = await c.query("select 1 from information_schema.tables where table_schema='public' and table_name=$1", [table]);
  if (t.rowCount === 0) return;
  const col = await c.query("select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2", [table, sentinelColumn]);
  if (col.rowCount === 0) throw new Error(`table "${table}" exists in this database but is not the engine's (no column "${sentinelColumn}"): pick another name or move the engine to its own schema`);
}
