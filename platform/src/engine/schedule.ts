import type { PoolClient } from "pg";
import { asOperator, many, one } from "@/db/client";

export const TICK_JOB = "bb-tick";

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
  recentResponses: { status_code: number | null; timed_out: boolean | null; error_msg: string | null; created: Date }[];
};

export async function tickScheduleStatus(): Promise<ScheduleStatus> {
  return asOperator(async (c) => {
    const have = await have_(c);
    if (!have.cron) return { installed: false, recentRuns: [], recentResponses: [] };
    const job = await one<{ jobid: number; schedule: string; active: boolean; command: string }>(c, "select jobid, schedule, active, command from cron.job where jobname=$1", [TICK_JOB]);
    if (!job) return { installed: false, recentRuns: [], recentResponses: [] };
    const recentRuns = await many<ScheduleStatus["recentRuns"][number]>(c, "select status, return_message, start_time from cron.job_run_details where jobid=$1 order by start_time desc limit 5", [job.jobid]);
    const recentResponses = have.net
      ? await many<ScheduleStatus["recentResponses"][number]>(c, "select status_code, timed_out, error_msg, created from net._http_response order by created desc limit 5")
      : [];
    return { installed: true, job: { ...job, jobid: Number(job.jobid), command: job.command.replace(/Bearer [^"\\]+/, "Bearer ***") }, recentRuns, recentResponses };
  });
}

async function have_(c: PoolClient) {
  const rows = await many<{ extname: string }>(c, "select extname from pg_extension where extname in ('pg_cron','pg_net')");
  const s = new Set(rows.map((r) => r.extname));
  return { cron: s.has("pg_cron"), net: s.has("pg_net") };
}
