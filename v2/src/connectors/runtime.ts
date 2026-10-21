import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { PgStore } from "@/engine/pg-store";
import { Hub } from "./framework/hub";
import { realHttp } from "./framework/http";
import { PgConnectorState } from "./framework/pg-state";
import type { Enqueue } from "./framework/types";

/**
 * graphile-worker's add_job for a connector's job. A job carries only ids; `jobKey` with replace makes a movable timer
 * (the next agreement check of a location, the next poll), as the engine's own jobs do (ADR 0008).
 */
export const graphileConnectorEnqueue = (d: ReturnType<typeof db>): Enqueue => async (task, payload, opts) => {
  await d.execute(sql`select graphile_worker.add_job(${task}, ${JSON.stringify(payload)}::json, run_at => ${(opts?.runAt ?? new Date()).toISOString()}::timestamptz, job_key => ${opts?.jobKey ?? null}, job_key_mode => 'replace')`);
};

/**
 * The connectors as the deployed doors run them: the platform database, the real HTTP layer, jobs into graphile-worker.
 * A door only verifies, records and queues; it never reads a delivery itself, so this hub has no engine to give facts
 * to (the worker's has).
 */
let hub: Hub | undefined;
export function defaultHub(): Hub {
  if (hub) return hub;
  const d = db();
  hub = new Hub({
    state: new PgConnectorState(d), store: new PgStore(d, "graphile"), http: realHttp(), enqueue: graphileConnectorEnqueue(d),
    env: { ghlClientId: process.env.GHL_CLIENT_ID, ghlClientSecret: process.env.GHL_CLIENT_SECRET, ghlWebhookPublicKey: process.env.GHL_WEBHOOK_PUBLIC_KEY },
  });
  return hub;
}
