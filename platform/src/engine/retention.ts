import type { PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { asOperator, many } from "@/db/client";
import { KEPT_KEYS, persistedContext } from "./context";
import { sweepHeldTranscripts } from "./transcripts";

/**
 * D38: the hub keeps what the engine needs, not an archive. Per company: an inbound reply's row goes after
 * reply_retention_days (the "they replied" event stays), and the engine's own sends go after sends_retention_days once
 * their run is over (a live run keeps its sends: idempotency and the wait-for-reply boundary read them). D87: a call's transcript
 * or summary still held `calls.transcript_hold_hours` after the last run about it ended is cleared (transcripts.ts).
 */
export async function purgeOld(c: PoolClient, now = new Date()): Promise<{ replies: number; sends: number; transcripts: number }> {
  let replies = 0, sends = 0;
  for (const co of await many<{ id: string; reply_retention_days: number; sends_retention_days: number }>(c, "select id, reply_retention_days, sends_retention_days from companies")) {
    const r = await c.query("delete from messages where company_id=$1 and occurred_at < $2::timestamptz - make_interval(days => $3::int)", [co.id, now, co.reply_retention_days]);
    replies += r.rowCount ?? 0;
    // rows that point at a send about to go: unlink first (a database from before the column lacks it; skip then)
    for (const t of ["agreements", "messages"]) {
      const has = await c.query("select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name='send_id'", [t]);
      if (has.rowCount) await c.query(`update ${t} set send_id=null where company_id=$1 and send_id in (select id from sends where company_id=$1 and coalesce(sent_at, scheduled_for) < $2::timestamptz - make_interval(days => $3::int))`, [co.id, now, co.sends_retention_days]);
    }
    const s = await c.query(`delete from sends s where s.company_id=$1 and coalesce(s.sent_at, s.scheduled_for) < $2::timestamptz - make_interval(days => $3::int)
      and (s.run_id is null or not exists (select 1 from runs r where r.id=s.run_id and r.status in ('active','waiting')))`, [co.id, now, co.sends_retention_days]);
    sends += s.rowCount ?? 0;
  }
  // D87: a transcript a webhook delivered is held only while runs read it; anything still held well after its runs ended goes here
  const transcripts = await sweepHeldTranscripts(c, now);
  return { replies, sends, transcripts };
}

/** scanned: rows with something to drop; changed: rows rewritten (or, dry, that would be); bytes as JSON text. */
export type SlimReport = { dryRun: boolean; scanned: number; changed: number; bytes_before: number; bytes_after: number; done: boolean; next: string | null };

/**
 * D84, once: rewrites every run's saved context to what a run now keeps (persistedContext), dropping the contact, appointment,
 * recording and other copies runs used to save. A batch per transaction, compare-and-set (a run a tick saved meanwhile is left for
 * the next pass), and a row already slim is not touched, so it is safe to re-run. `dryRun` counts the rows and bytes (as JSON text)
 * it would change without writing. Stops after `budgetMs` and returns `next` to continue from.
 */
export async function slimRunContexts(opts: { dryRun?: boolean; batchSize?: number; after?: string | null; budgetMs?: number; companyId?: string } = {}): Promise<SlimReport> {
  const dryRun = opts.dryRun ?? false, size = Math.min(5000, Math.max(1, opts.batchSize ?? 500)), stopAt = Date.now() + (opts.budgetMs ?? 240_000);
  const r: SlimReport = { dryRun, scanned: 0, changed: 0, bytes_before: 0, bytes_after: 0, done: false, next: opts.after ?? null };
  for (;;) {
    const rows = await asOperator(async (c) => {
      // only rows with something to drop: a key past the kept ones, or a contact that is more (or less) than its read stamp
      const batch = await many<{ id: string; context: Record<string, unknown> }>(c, `select id, context from runs where ($1::uuid is null or id > $1) and ($4::uuid is null or company_id=$4)
        and (exists (select 1 from jsonb_object_keys(context) k where k <> all($2::text[]))
          or (context ? 'contact' and (jsonb_typeof(context->'contact') <> 'object' or context->'contact' = '{}'::jsonb or (context->'contact') - 'fetched_at' - 'stale' <> '{}'::jsonb
            or context->'contact'->'fetched_at' = 'null'::jsonb or context->'contact'->'stale' = 'null'::jsonb)))
        order by id limit $3`, [r.next, [...KEPT_KEYS, "contact"], size, opts.companyId ?? null]);
      for (const row of batch) {
        const slim = persistedContext(row.context);
        if (isDeepStrictEqual(slim, row.context)) continue;
        if (!dryRun && !(await c.query("update runs set context=$2 where id=$1 and context=$3::jsonb", [row.id, slim, row.context])).rowCount) continue;
        r.changed++; r.bytes_before += Buffer.byteLength(JSON.stringify(row.context)); r.bytes_after += Buffer.byteLength(JSON.stringify(slim));
      }
      return batch;
    });
    r.scanned += rows.length;
    if (rows.length) r.next = rows[rows.length - 1].id;
    if (rows.length < size) { r.done = true; r.next = null; break; }
    if (Date.now() >= stopAt) break;
  }
  return r;
}
