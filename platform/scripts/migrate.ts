import "./_env";
import { migrate } from "@/db/migrate";
import { db } from "@/db/client";
(async () => {
  const r = await migrate();
  // engine-internal state + columns the engine needs beyond schema.sql (documented in 02-data-model §14 follow-ups)
  console.log(`schema ${r.applied ? "applied" : "already present"}; RLS forced on ${r.rlsTables.length} tenant tables`);
  await db().end();
})().catch((e) => { console.error(e); process.exit(1); });
