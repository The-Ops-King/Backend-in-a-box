import { sql } from "drizzle-orm";
import type { Engine } from "@/engine/engine";
import type { VendorReads } from "@/engine/reads";
import { SlackApi, type SlackFetch } from "./api";
import { type Db, platformSettingsOf } from "./data";
import type { SlackEnv } from "./env";
import { type OutDeps, deliverDueSlack } from "./outbox";
import { type PlatformSlackPort, createSlackPort } from "./port";
import type { BotModel } from "./bot";

/**
 * Everything the Slack app's doors and jobs work with, given, never global: the database, the app's config, Slack's
 * Web API (a fake fetch in tests), the platform Slack port, the engine (facts in, answers in, a hand on a run), the
 * clock, how a job is queued, the bot's model (a fake in tests) and what only a vendor answers.
 */
export type SlackApp = {
  db: Db;
  env: SlackEnv;
  api: SlackApi;
  port: PlatformSlackPort;
  engine: Engine;
  now: () => Date;
  /** Queues a job for the worker (graphile-worker's add_job in production; tests run them at once). */
  enqueue: (task: SlackTask, payload: Record<string, unknown>) => Promise<void>;
  bot?: BotModel;
  reads?: VendorReads;
  random?: () => number;
};

export type SlackTask = "slack_inbox" | "slack_outbox" | "slack_alerts";

export function createSlackPortFor(x: { db: Db; env: SlackEnv; fetch?: SlackFetch; now?: () => Date; sleep?: (ms: number) => Promise<void>; maxWaitMs?: number }): { api: SlackApi; port: PlatformSlackPort } {
  const api = new SlackApi(x.fetch);
  return { api, port: createSlackPort({ db: x.db, api, env: x.env, now: x.now ?? (() => new Date()), ...(x.sleep ? { sleep: x.sleep } : {}), ...(x.maxWaitMs !== undefined ? { maxWaitMs: x.maxWaitMs } : {}) }) };
}

/** graphile-worker's add_job, in its own statement: the job carries only an id; the row it names is the truth. */
export const graphileEnqueue = (db: Db) => async (task: SlackTask, payload: Record<string, unknown>) => {
  await db.execute(sql`select graphile_worker.add_job(${task}, ${JSON.stringify(payload)}::json)`);
};

/** The operator's own channel (platform setting slack.operator_channel: { team_id, channel }): where what belongs to no offer goes. */
export async function operatorChannel(app: Pick<SlackApp, "db">): Promise<{ teamId: string; channel: string } | undefined> {
  const v = (await platformSettingsOf(app.db))["slack.operator_channel"] as { team_id?: string; channel?: string } | undefined;
  return v?.team_id && v.channel ? { teamId: v.team_id, channel: v.channel } : undefined;
}

export const outDeps = (app: SlackApp): OutDeps => ({ db: app.db, port: app.port, now: app.now, ...(app.random ? { random: app.random } : {}), operatorChannel: () => operatorChannel(app) });

/** Delivers the platform's own Slack rows due now. */
export const flushSlack = (app: SlackApp) => deliverDueSlack(outDeps(app));
