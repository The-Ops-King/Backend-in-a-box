import type { PoolClient } from "pg";
import { many } from "@/db/client";
import { sweepHeldTranscripts } from "./transcripts";

/**
 * D38: the hub keeps what the engine needs, not an archive. Per company: an inbound reply's row goes after
 * reply_retention_days (the "they replied" event stays), and the engine's own sends go after sends_retention_days once
 * their run is over (a live run keeps its sends: idempotency and the wait-for-reply boundary read them). D193: "over" is completed
 * or exited; a paused or failed run can be retried (hand.ts), and its send row is what stops the retried step sending twice. D87: a call's transcript
 * or summary still held `calls.transcript_hold_hours` after the last run about it ended is cleared (transcripts.ts).
 */
/** A send past retention whose run, if any, is over ($1 company, $2 now, $3 days). */
const GONE = `s.company_id=$1 and coalesce(s.sent_at, s.scheduled_for) < $2::timestamptz - make_interval(days => $3::int)
  and (s.run_id is null or not exists (select 1 from runs r where r.id=s.run_id and r.status in ('active','waiting','paused','failed')))`;

export async function purgeOld(c: PoolClient, now = new Date()): Promise<{ replies: number; sends: number; transcripts: number }> {
  let replies = 0, sends = 0;
  for (const co of await many<{ id: string; reply_retention_days: number; sends_retention_days: number }>(c, "select id, reply_retention_days, sends_retention_days from companies")) {
    const r = await c.query("delete from messages where company_id=$1 and occurred_at < $2::timestamptz - make_interval(days => $3::int)", [co.id, now, co.reply_retention_days]);
    replies += r.rowCount ?? 0;
    // rows that point at a send about to go: unlink first (a database from before the column lacks it; skip then)
    for (const t of ["agreements", "messages"]) {
      const has = await c.query("select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name='send_id'", [t]);
      if (has.rowCount) await c.query(`update ${t} set send_id=null where company_id=$1 and send_id in (select s.id from sends s where ${GONE})`, [co.id, now, co.sends_retention_days]);
    }
    const s = await c.query(`delete from sends s where ${GONE}`, [co.id, now, co.sends_retention_days]);
    sends += s.rowCount ?? 0;
  }
  // D87: a transcript a webhook delivered is held only while runs read it; anything still held well after its runs ended goes here
  const transcripts = await sweepHeldTranscripts(c, now);
  return { replies, sends, transcripts };
}
