import { afterAll, describe, expect, it } from "vitest";
import { closeDb, pgPool } from "./client";
import { MIGRATION_LOCK, migrateAll } from "./migrator";

afterAll(async () => { await closeDb(); });

describe.skipIf(!process.env.DATABASE_URL)("the migrator (the app's pnpm migrate and the worker's start)", () => {
  it("waits while another process holds the migration lock, then finds nothing left to do", async () => {
    await migrateAll(pgPool());
    const other = await pgPool().connect();
    try {
      await other.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
      let done = false;
      const waiting = migrateAll(pgPool()).then(() => { done = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false);
      await other.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
      await waiting;
      expect(done).toBe(true);
    } finally { other.release(); }
  });
  it("two at once (the app and the worker deployed together) both finish, and leave the lock free", async () => {
    await Promise.all([migrateAll(pgPool()), migrateAll(pgPool())]);
    const { rows } = await pgPool().query("select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1", [MIGRATION_LOCK]);
    expect(rows[0].n).toBe(0);
  });
});
