import "./_env";
import { liveAdapters } from "@/adapters";
import { tickEveryone } from "@/engine/ticks";
import { db } from "@/db/client";
// what a call to /api/tick with no parameters does (D98): every company in turn under its own lease, then the engine's minute
(async () => {
  const out = await tickEveryone(liveAdapters);
  for (const co of out.companies) console.log(co.slug ?? co.company, JSON.stringify(co));
  console.log("engine", JSON.stringify(out.engine));
  if (out.busy.length) console.log("busy (another tick holds their lease):", out.busy.join(", "));
  await db().end();
})().catch((e) => { console.error(e); process.exit(1); });
