import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

let migrated = false;

/** The test database at the current migrations, with every engine table emptied, so each test starts clean. */
export async function freshEngineDb() {
  if (!migrated) { await migrate(db(), { migrationsFolder: path.resolve(__dirname, "../../drizzle") }); migrated = true; }
  await db().execute(sql`truncate alerts, slack_posts, outbox, run_steps, runs, events, settings, content, connections, operator_addresses, workflows, workflow_versions, offers restart identity cascade`);
}
