import { closeDb, pgPool } from "./client";
import { migrateAll } from "./migrator";

/** `pnpm migrate`: the app service's start runs it before the app (railway.json); the worker runs the same at its start. */
await migrateAll(pgPool());
await closeDb();
console.log("migrations: up to date");
