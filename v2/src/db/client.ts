import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

let pool: Pool | undefined;

/** One pool per process. DATABASE_URL is Railway's Postgres. */
export function pgPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  pool ??= new Pool({ connectionString: url, max: 5 });
  return pool;
}

export function db() {
  return drizzle(pgPool(), { schema });
}

export async function closeDb() { await pool?.end(); pool = undefined; }
