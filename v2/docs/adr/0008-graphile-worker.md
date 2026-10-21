# 0008. Timers, wakes and deliveries are graphile-worker jobs

Date: 2026-10-21. Claude's recommendation, for Tyler to confirm; the blueprint left graphile-worker or pg-boss open.

**Decision.** The always-on worker runs graphile-worker (pinned at 0.17.3) on the same Postgres.
- A run that parks writes a `wake_run` job for its exact wake time; an outbox row writes a `dispatch` job.
- Each job is written by `graphile_worker.add_job(...)` in the same transaction as the change that needs it, so the
  change and its job commit together or not at all.
- A job's key is the row it is for (`run:<id>`, `outbox:<id>`) with `replace`: a run has one pending wake, and moving
  the wake replaces it.
- A job carries only the id. The row is the truth: a job that fires early, late or twice looks at the row again and
  does nothing unless something is due.

**Why graphile-worker over pg-boss.**
- Enqueueing is a SQL function, so it joins the engine's own Drizzle transaction with one statement. pg-boss can do
  this only by handing it a database adapter per call.
- `job_key` with replace mode is exactly a movable timer. pg-boss's singleton keys throttle; they do not reschedule.
- It wakes on LISTEN/NOTIFY, so a due job starts in milliseconds without a polling tick (ADR 0003).
- It is small and Postgres-only, with no service of its own to run.

**Consequences.**
- `pnpm migrate` also brings graphile-worker's own schema (`graphile_worker`) up to date.
- Tests and the simulator do not need the queue: `Engine.runDue()` does everything due now, deterministically, and
  the job handlers call the same `wake` and `deliver`.
- When the worker starts, rows left `sending` by a worker that stopped mid-call are marked `unknown` and never re-sent.
- The worker's entry point, with real ports, comes with the first connectors (Phase 4).
