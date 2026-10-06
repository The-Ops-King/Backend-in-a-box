import "./_env";
import { liveAdapters } from "@/adapters";
import { pollAll } from "@/engine/poll";
import { tick } from "@/engine/runner";
import { db } from "@/db/client";
(async () => {
  const poll = await pollAll(liveAdapters); console.log("poll", JSON.stringify(poll));
  const runs = await tick(liveAdapters); console.log("tick", JSON.stringify(runs));
  await db().end();
})().catch((e) => { console.error(e); process.exit(1); });
