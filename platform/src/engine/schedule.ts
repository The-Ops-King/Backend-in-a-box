import type { PoolClient } from "pg";
import { asOperator, many, one } from "@/db/client";

export const TICK_JOB = "bb-tick";
export const WATCHDOG_JOB = "bb-watchdog";

/**
 * The minute scheduler lives in the database: Supabase ships pg_cron + pg_net, so a cron job inside Postgres calls
 * /api/tick every minute. No third account, no Vercel Pro, and it fires on time where GitHub's five-minute schedule did not.
 * The bearer secret sits in cron.job's command text; anyone who can read that table already owns the database.
 */
export async function installTickSchedule(tickUrl: string, secret: string, everyMinutes = 1, timeoutMs = 120_000): Promise<{ jobid: number }> {
  if (!/^https:\/\/[^/\s'"]+$/.test(tickUrl)) throw new Error(`tickUrl must be an https origin without a path: ${tickUrl}`);
  if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 59) throw new Error("everyMinutes must be 1–59");
  const schedule = everyMinutes === 1 ? "* * * * *" : `*/${everyMinutes} * * * *`;
  const headers = JSON.stringify({ Authorization: `Bearer ${secret}` });
  // dollar-quoted so the JSON needs no escaping; the tag is unusual enough never to appear in a URL or secret
  const command = `select net.http_get(url := $bbq$${tickUrl}/api/tick$bbq$, headers := $bbq$${headers}$bbq$::jsonb, timeout_milliseconds := ${timeoutMs})`;
  return asOperator(async (c) => {
    await c.query("create extension if not exists pg_cron");
    await c.query("create extension if not exists pg_net");
    const r = await one<{ jobid: number }>(c, "select cron.schedule($1, $2, $3) as jobid", [TICK_JOB, schedule, command]);   // same name = replace
    return { jobid: Number(r!.jobid) };
  });
}

/**
 * The watchdog also lives in the database, so it keeps running when the app or its scheduler job does not: every five
 * minutes it reads the engine's last tick and, if that is older than `staleMinutes`, POSTs to the operator's webhook
 * straight from Postgres. The one outage it cannot report is the database itself being down, which takes everything
 * else down with it anyway.
 */
export async function installWatchdog(alertUrl: string, staleMinutes = 5): Promise<{ jobid: number }> {
  if (!/^https:\/\/[^\s'"$]+$/.test(alertUrl)) throw new Error(`alertUrl must be an https URL: ${alertUrl}`);
  const body = `jsonb_build_object('text', 'backend-in-a-box: no engine tick for ' || extract(epoch from (now() - (value->>'last_tick')::timestamptz))::int / 60 || ' minutes (last ' || (value->>'last_tick') || ')', 'source', 'watchdog', 'at', now())`;
  const command = `select net.http_post(url := $bbq$${alertUrl}$bbq$, body := ${body}, headers := '{"Content-Type":"application/json"}'::jsonb) from engine_state where key='scheduler' and (value->>'last_tick')::timestamptz < now() - interval '${Math.max(1, Math.floor(staleMinutes))} minutes'`;
  return asOperator(async (c) => {
    await c.query("create extension if not exists pg_cron"); await c.query("create extension if not exists pg_net");
    const r = await one<{ jobid: number }>(c, "select cron.schedule($1, $2, $3) as jobid", [WATCHDOG_JOB, "*/5 * * * *", command]);
    return { jobid: Number(r!.jobid) };
  });
}
export async function removeWatchdog(): Promise<boolean> {
  return asOperator(async (c) => { if (!(await one(c, "select 1 from cron.job where jobname=$1", [WATCHDOG_JOB]))) return false; await c.query("select cron.unschedule($1)", [WATCHDOG_JOB]); return true; });
}

export async function removeTickSchedule(): Promise<boolean> {
  return asOperator(async (c) => {
    const j = await one(c, "select 1 from cron.job where jobname=$1", [TICK_JOB]);
    if (!j) return false;
    await c.query("select cron.unschedule($1)", [TICK_JOB]);
    return true;
  });
}

export type ScheduleStatus = {
  installed: boolean;
  job?: { jobid: number; schedule: string; active: boolean; command: string };
  recentRuns: { status: string; return_message: string | null; start_time: Date }[];
  watchdog?: { jobid: number; schedule: string; active: boolean; alertUrl: string | null };
};

export async function tickScheduleStatus(): Promise<ScheduleStatus> {
  return asOperator(async (c) => {
    const have = await have_(c);
    if (!have.cron) return { installed: false, recentRuns: [] };
    const job = await one<{ jobid: number; schedule: string; active: boolean; command: string }>(c, "select jobid, schedule, active, command from cron.job where jobname=$1", [TICK_JOB]);
    if (!job) return { installed: false, recentRuns: [] };
    // net._http_response is database-wide and cannot be tied back to this job (a shared Supabase project has other
    // apps' pg_net traffic in it), so the HTTP outcome is read from /api/health's last_tick instead.
    const recentRuns = await many<ScheduleStatus["recentRuns"][number]>(c, "select status, return_message, start_time from cron.job_run_details where jobid=$1 order by start_time desc limit 5", [job.jobid]);
    const wd = await one<{ jobid: number; schedule: string; active: boolean; command: string }>(c, "select jobid, schedule, active, command from cron.job where jobname=$1", [WATCHDOG_JOB]);
    return { installed: true, job: { ...job, jobid: Number(job.jobid), command: job.command.replace(/Bearer [^"\\]+/, "Bearer ***") }, recentRuns,
      watchdog: wd ? { jobid: Number(wd.jobid), schedule: wd.schedule, active: wd.active, alertUrl: /\$bbq\$(https:[^$]+)\$bbq\$/.exec(wd.command)?.[1] ?? null } : undefined };
  });
}

async function have_(c: PoolClient) {
  const rows = await many<{ extname: string }>(c, "select extname from pg_extension where extname = 'pg_cron'");
  const s = new Set(rows.map((r) => r.extname));
  return { cron: s.has("pg_cron") };
}
