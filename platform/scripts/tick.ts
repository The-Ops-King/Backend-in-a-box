import "./_env";
import { liveAdapters } from "@/adapters";
import { pollAll } from "@/engine/poll";
import { tick } from "@/engine/runner";
import { withTickLock } from "@/engine/lock";
import { db } from "@/db/client";
(async () => {
  const out = await withTickLock(async () => {
    const poll = await pollAll(liveAdapters); console.log("poll", JSON.stringify(poll));
    const runs = await tick(liveAdapters); console.log("tick", JSON.stringify(runs));
  });
  if (out.busy) console.log("busy: another tick holds the lease");
  await db().end();
})().catch((e) => { console.error(e); process.exit(1); });
