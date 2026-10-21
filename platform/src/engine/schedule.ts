import type { PoolClient } from "pg";
import { asOperator, many, one } from "@/db/client";
import { runningSql } from "./running";

export const TICK_JOB = "bb-tick", DOCUMENTS_JOB = "bb-documents";
export const WATCHDOG_JOB = "bb-watchdog";

/** pg_net's wait for an answer: past the tick route's own 300 s, so a long tick is never cut off from the caller's side. */
export const TICK_TIMEOUT_MS = 310_000;

/**
 * The job's command (D98): ONE statement that fires one request per ticking company (`/api/tick?company=<id>`) and one for the
 * engine (`?scope=engine`). pg_net sends them side by side, so no company waits for another, and the company list is read
 * when the job runs, so a client added later ticks the next minute with no reinstall. Dollar-quoted so the JSON needs no
 * escaping; the tag is unusual enough never to appear in a URL or secret.
 */
export function tickCommand(tickUrl: string, secret: string, timeoutMs = TICK_TIMEOUT_MS, keyIn: "command" | "vault" = "command"): string {
  const headers = keyIn === "vault"
    ? `jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = $bbq$${OPERATOR_KEY_NAME}$bbq$))`
    : `$bbq$${JSON.stringify({ Authorization: `Bearer ${secret}` })}$bbq$::jsonb`;
  return `select net.http_get(url := $bbq$${tickUrl}/api/tick?$bbq$ || t.q, headers := ${headers}, timeout_milliseconds := ${Math.max(300_000, Math.floor(timeoutMs))}) `
    + `from (select 'scope=engine' as q union all select 'company=' || id::text from companies co where ${runningSql()}) t`;
}

/**
 * D202: every ten seconds, but a request only for an offer waiting on a signature (bb_documents_waiting: a payment or an agreement
 * sent in the last 30 minutes and nothing signed yet; 15 until 0006), so forty quiet offers cost no call at all. That offer's GHL documents are
 * read again and what they announce runs at once; after the window the minute poll is the only reader again.
 */
export function documentsCommand(tickUrl: string, secret: string, keyIn: "command" | "vault" = "command"): string {
  const headers = keyIn === "vault"
    ? `jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = $bbq$${OPERATOR_KEY_NAME}$bbq$))`
    : `$bbq$${JSON.stringify({ Authorization: `Bearer ${secret}` })}$bbq$::jsonb`;
  return `select net.http_get(url := $bbq$${tickUrl}/api/tick?scope=documents&company=$bbq$ || w.company_id::text, headers := ${headers}, timeout_milliseconds := 60000) from bb_documents_waiting() w`;
}

/** The Vault secret the tick job reads its key from (D200). */
export const OPERATOR_KEY_NAME = "bb_operator_key", WATCHDOG_URL_NAME = "bb_watchdog_url";

/**
 * The minute scheduler lives in the database: Supabase ships pg_cron + pg_net, so a cron job inside Postgres calls
 * /api/tick every minute. No third account, no Vercel Pro, and it fires on time where GitHub's five-minute schedule did not.
 * D200 (audit risk 9): where Supabase Vault is installed the key is kept there and read when the job runs, so cron.job's command
 * holds no secret (and a changed key needs only the secret replaced); a database without Vault keeps it in the command as before.
 */
export async function installTickSchedule(tickUrl: string, secret: string, everyMinutes = 1, timeoutMs = TICK_TIMEOUT_MS): Promise<{ jobid: number; keyIn: "vault" | "command" }> {
  if (!/^https:\/\/[^/\s'"]+$/.test(tickUrl)) throw new Error(`tickUrl must be an https origin without a path: ${tickUrl}`);
  if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 59) throw new Error("everyMinutes must be 1–59");
  const schedule = everyMinutes === 1 ? "* * * * *" : `*/${everyMinutes} * * * *`;
  return asOperator(async (c) => {
    await c.query("create extension if not exists pg_cron");
    await c.query("create extension if not exists pg_net");
    const keyIn = (await keepInVault(c, OPERATOR_KEY_NAME, secret, "backend-in-a-box operator key, read by the tick job (D200)")) ? "vault" : "command";
    const r = await one<{ jobid: number }>(c, "select cron.schedule($1, $2, $3) as jobid", [TICK_JOB, schedule, tickCommand(tickUrl, secret, timeoutMs, keyIn)]);   // same name = replace
    await c.query("select cron.schedule($1, '10 seconds', $2)", [DOCUMENTS_JOB, documentsCommand(tickUrl, secret, keyIn)]);   // D202
    return { jobid: Number(r!.jobid), keyIn };
  });
}

async function keepInVault(c: PoolClient, name: string, secret: string, description: string): Promise<boolean> {
  if (!(await one(c, "select 1 from pg_extension where extname='supabase_vault'"))) return false;
  const have = await one<{ id: string }>(c, "select id from vault.secrets where name=$1", [name]);
  if (have) await c.query("select vault.update_secret($1, $2)", [have.id, secret]);
  else await c.query("select vault.create_secret($1, $2, $3)", [secret, name, description]);
  return true;
}

/**
 * The watchdog also lives in the database, so it keeps running when the app or its scheduler job does not: every five
 * minutes it reads the engine's last tick and, if that is older than `staleMinutes`, POSTs to the operator's webhook
 * straight from Postgres. The one outage it cannot report is the database itself being down, which takes everything
 * else down with it anyway.
 */
export async function installWatchdog(alertUrl: string, staleMinutes = 5): Promise<{ jobid: number; urlIn: "vault" | "command" }> {
  if (!/^https:\/\/[^\s'"$]+$/.test(alertUrl)) throw new Error(`alertUrl must be an https URL: ${alertUrl}`);
  const body = `jsonb_build_object('text', 'backend-in-a-box: no engine tick for ' || extract(epoch from (now() - (value->>'last_tick')::timestamptz))::int / 60 || ' minutes (last ' || (value->>'last_tick') || ')', 'source', 'watchdog', 'at', now())`;
  return asOperator(async (c) => {
    await c.query("create extension if not exists pg_cron"); await c.query("create extension if not exists pg_net");
    // D200: the alert URL is a secret too (anyone holding a Slack webhook can post with it): kept in Vault where there is one
    const urlIn = (await keepInVault(c, WATCHDOG_URL_NAME, alertUrl, "backend-in-a-box watchdog alert URL (D200)")) ? "vault" : "command";
    const url = urlIn === "vault" ? `(select decrypted_secret from vault.decrypted_secrets where name = $bbq$${WATCHDOG_URL_NAME}$bbq$)` : `$bbq$${alertUrl}$bbq$`;
    const command = `select net.http_post(url := ${url}, body := ${body}, headers := '{"Content-Type":"application/json"}'::jsonb) from engine_state where key='scheduler' and (value->>'last_tick')::timestamptz < now() - interval '${Math.max(1, Math.floor(staleMinutes))} minutes'`;
    const r = await one<{ jobid: number }>(c, "select cron.schedule($1, $2, $3) as jobid", [WATCHDOG_JOB, "*/5 * * * *", command]);
    return { jobid: Number(r!.jobid), urlIn };
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
  documents?: { jobid: number; schedule: string; active: boolean; recentRuns: { status: string; return_message: string | null; start_time: Date }[] };
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
    // D202: the ten-second documents job, and how its last runs went (a failing one would otherwise be silent)
    const dj = await one<{ jobid: number; schedule: string; active: boolean }>(c, "select jobid, schedule, active from cron.job where jobname=$1", [DOCUMENTS_JOB]);
    const documents = dj ? { jobid: Number(dj.jobid), schedule: dj.schedule, active: dj.active, recentRuns: await many<ScheduleStatus["recentRuns"][number]>(c, "select status, return_message, start_time from cron.job_run_details where jobid=$1 order by start_time desc limit 5", [dj.jobid]) } : undefined;
    return { installed: true, job: { ...job, jobid: Number(job.jobid), command: job.command.replace(/Bearer [^"\\]+/, "Bearer ***") }, recentRuns, documents,
      watchdog: wd ? { jobid: Number(wd.jobid), schedule: wd.schedule, active: wd.active, alertUrl: /\$bbq\$(https:[^$]+)\$bbq\$/.exec(wd.command)?.[1] ?? (wd.command.includes(WATCHDOG_URL_NAME) ? "(in Vault)" : null) } : undefined };
  });
}

async function have_(c: PoolClient) {
  const rows = await many<{ extname: string }>(c, "select extname from pg_extension where extname = 'pg_cron'");
  const s = new Set(rows.map((r) => r.extname));
  return { cron: s.has("pg_cron") };
}
