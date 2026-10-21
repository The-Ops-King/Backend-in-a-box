import { run, runMigrations } from "graphile-worker";
import { db, pgPool } from "@/db/client";
import { Engine } from "@/engine/engine";
import { taskList } from "@/engine/jobs";
import { PgStore } from "@/engine/pg-store";
import { PortError, type HttpPort } from "@/engine/ports";
import { createSlackPortFor, graphileEnqueue } from "@/slack/app";
import { slackEnv } from "@/slack/env";
import { slackTaskList } from "@/slack/http";
import { connectorPorts, connectorTaskList, processDelivery, startConnection } from "@/connectors/registry";
import { connectorReads } from "@/connectors/framework/transcripts";
import { sweepInbox } from "@/connectors/doors";
import { defaultHub } from "@/connectors/runtime";

/**
 * The always-on worker (ADR 0008), with real ports: the engine's jobs (wakes, deliveries, schedules), the Slack app's,
 * and the connectors' (the inbox normalizer, GHL's token refresh, agreement checks and private-token poll, Calendly's
 * free-plan poll, transcripts, the nightly reconcile). `pnpm worker`. Not in railway.json yet: it is a second Railway
 * service with the same variables, started with this command, when the first offer moves.
 */

const d = db();
const hub = defaultHub();
const env = slackEnv();
const { api, port: slack } = createSlackPortFor({ db: d, env });
const http: HttpPort = { request: async () => { throw new PortError("permanent", "outbound http.request is not built yet"); } };
const engine = new Engine({ store: new PgStore(d, "graphile"), ports: connectorPorts(hub, { slack, http }), reads: connectorReads(hub) });
hub.setIngest(async (f) => ({ duplicate: (await engine.ingest(f)).duplicate }));
const slackApp = { db: d, env, api, port: slack, engine, now: () => new Date(), enqueue: graphileEnqueue(d) };

await runMigrations({ pgPool: pgPool() });
await engine.reap();
await sweepInbox(hub, (id) => processDelivery(hub, id));
for (const provider of ["ghl", "whop", "fathom", "calendly"] as const) for (const c of await hub.state.connectionsOf(provider)) if (c.status === "connected") await startConnection(hub, c);
await run({ pgPool: pgPool(), concurrency: 4, noHandleSignals: false, taskList: { ...taskList(engine), ...slackTaskList(slackApp), ...connectorTaskList(hub) } });
