import { db } from "@/db/client";
import { Engine } from "@/engine/engine";
import { PgStore } from "@/engine/pg-store";
import { PortError, type Ports } from "@/engine/ports";
import { type SlackApp, createSlackPortFor, graphileEnqueue } from "./app";
import { slackEnv } from "./env";

/**
 * The Slack app as the deployed doors run it: the platform database, the app's config from the environment, Slack's
 * real Web API, the engine on Postgres writing its jobs into graphile-worker. The other vendors' ports are not here
 * (no connector is built yet); the doors never deliver, they only record and queue.
 */
let app: SlackApp | undefined;

export function defaultSlackApp(): SlackApp {
  if (app) return app;
  const env = slackEnv(), d = db();
  const { api, port } = createSlackPortFor({ db: d, env });
  const missing = (name: string) => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : async () => { throw new PortError("auth", `no ${name} connector here`); }) });
  const ports = { crm: missing("crm"), messaging: missing("messaging"), scheduling: missing("scheduling"), esign: missing("esign"), ai: missing("ai"), http: missing("http"), slack: port } as unknown as Ports;
  const engine = new Engine({ store: new PgStore(d, "graphile"), ports });
  app = { db: d, env, api, port, engine, now: () => new Date(), enqueue: graphileEnqueue(d) };
  return app;
}
