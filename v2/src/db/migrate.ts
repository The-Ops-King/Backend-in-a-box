import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "./client";

/** Runs every migration in drizzle/ not yet recorded, once each, in order. Run by the deploy before the app starts. */
const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
await migrate(db(), { migrationsFolder: folder });
await closeDb();
console.log("migrations: up to date");
