import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

/** A test database brought up to the current migrations, then emptied, so every suite starts clean. */
export async function freshDb() {
  await migrate(db(), { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
  await db().execute(sql`truncate inbox, ghl_connections restart identity`);
}
