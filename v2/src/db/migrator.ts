import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { runMigrations } from "graphile-worker";
import type { Pool } from "pg";

/** The session lock every migrator takes, so the app's start and the worker's never migrate at once. */
export const MIGRATION_LOCK = 4_242_008;

const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Brings the database up to date: every migration in drizzle/ not yet recorded, once each, in order, then
 * graphile-worker's own schema. Under a Postgres advisory lock held for the whole run: a second process (the worker
 * starting beside the app) waits for the first, then finds nothing left to do. Neither migrator locks by itself, and
 * two at once would both try the same migration.
 */
export async function migrateAll(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    try {
      await migrate(drizzle(client), { migrationsFolder: folder });
      await runMigrations({ pgPool: pool });
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    }
  } finally {
    client.release();
  }
}
