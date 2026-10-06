import "./_env";
import { migrate } from "@/db/migrate";
import { db } from "@/db/client";
(async () => {
  const r = await migrate();
  // engine-internal state + columns the engine needs beyond schema.sql (documented in 02-data-model §14 follow-ups)
  await db().query(`create table if not exists engine_state (key text primary key, value jsonb not null default '{}', updated_at timestamptz not null default now())`);
  console.log(`schema ${r.applied ? "applied" : "already present"}; RLS forced on ${r.rlsTables.length} tenant tables`);
  await db().end();
})().catch((e) => { console.error(e); process.exit(1); });
