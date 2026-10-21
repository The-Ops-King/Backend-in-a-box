import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { runMigrations } from "graphile-worker";
import { closeDb, db, pgPool } from "./client";

/** Runs every migration in drizzle/ not yet recorded, once each, in order. Run by the deploy before the app starts. */
const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
await migrate(db(), { migrationsFolder: folder });
// the job queue's own schema (graphile_worker), which the library migrates itself
await runMigrations({ pgPool: pgPool() });
await closeDb();
console.log("migrations: up to date");
