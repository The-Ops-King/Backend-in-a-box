import { type Runner, type TaskList, run, runMigrations, runOnce } from "graphile-worker";
import type { Pool } from "pg";
import type { Engine } from "./engine";

/**
 * The job runner: graphile-worker on the always-on worker (ADR 0008). The engine writes a job in the same transaction
 * as the change that needs it (PgStore with jobs "graphile"): a run to wake at its exact time, an outbox row to deliver.
 * A job carries only an id; the row it names is the truth, so a job that fires early, late or twice does nothing wrong:
 * `wake` and `deliver` look again at what is due.
 */

export const taskList = (engine: Engine): TaskList => ({
  wake_run: async (payload) => { await engine.wake(String((payload as { id: string }).id)); },
  dispatch: async (payload) => { await engine.deliver(Number((payload as { id: string }).id)); },
  fire_schedule: async (payload) => { const p = payload as { workflowId: string; node: string }; await engine.fireTimer(p.workflowId, p.node); },
});

/** Brings graphile-worker's own schema (graphile_worker) up to date. Run with the deploy's migrations. */
export const migrateJobs = (pgPool: Pool) => runMigrations({ pgPool });

/** Starts the worker: anything left mid-call is marked unknown first, then jobs run as they come due. */
export async function startWorker(x: { pgPool: Pool; engine: Engine; concurrency?: number }): Promise<Runner> {
  await migrateJobs(x.pgPool);
  await x.engine.reap();
  return run({ pgPool: x.pgPool, concurrency: x.concurrency ?? 4, noHandleSignals: false, taskList: taskList(x.engine) });
}

/** Runs every job due now, once, and returns: for tests of the job wiring. */
export const runJobsOnce = (x: { pgPool: Pool; engine: Engine }) => runOnce({ pgPool: x.pgPool, taskList: taskList(x.engine) });
