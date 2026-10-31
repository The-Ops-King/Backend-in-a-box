import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { loadCompany } from "./context";
import { callOutcome, finishPhoneCall, UNFINISHED_CALL, type RecordingRow } from "./recordings";

/**
 * D275: the calls the poll first saw while they were still ringing and then never read again (before D275 they settled as
 * "ringing", 0 seconds, for ever). Each is read from GHL again and its row corrected: final status, length, end, and for a
 * connected call whether GHL has a transcript. Silent: no event, no workflow, no post (a call from last week is not news);
 * a replay through one workflow is a separate, deliberate step. Dry run first. Audited.
 */
export type CallRepair = { id: string; contact: string | null; started_at: Date; was: string; now: string; duration_sec: number; transcript?: boolean };
export async function repairUnfinishedCalls(c: PoolClient, adapters: Adapters, a: { company: string; why: string; dryRun?: boolean; limit?: number }):
  Promise<{ ok: true; dryRun: boolean; repaired: CallRepair[]; still_unfinished: number; unread: number; left: number } | { ok: false; status: number; error: string }> {
  if (!a.why?.trim()) return { ok: false, status: 400, error: "why is required" };
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [a.company]); if (!co) return { ok: false, status: 404, error: "no such company" };
  if (!adapters.read.callNow) return { ok: false, status: 500, error: "this CRM adapter cannot read one call" };
  const { adapterCompany: ac } = await loadCompany(c, co.id);
  const stuck = await many<RecordingRow & { who: string | null }>(c, `select r.*, nullif(trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')),'') as who from recordings r left join contacts ct on ct.id=r.contact_id
    where r.company_id=$1 and r.provider='ghl' and r.raw->>'call_status' = any($2::text[]) and r.raw->>'transcript_status' <> 'unfinished' order by r.started_at desc`, [co.id, [...UNFINISHED_CALL]]);
  const batch = stuck.slice(0, Math.max(1, Math.min(a.limit ?? 50, 200)));
  const repaired: CallRepair[] = []; let still = 0, unread = 0;
  for (const r of batch) {
    const now = await adapters.read.callNow(ac, r.external_id);
    if (!now) { unread++; continue; }
    const outcome = callOutcome(now.status);
    if (UNFINISHED_CALL.has(outcome)) { still++; continue; }
    const item: CallRepair = { id: r.id, contact: r.who, started_at: r.started_at, was: String(r.raw.call_status), now: outcome, duration_sec: now.durationSec ?? 0 };
    if (!a.dryRun) {
      const row = await finishPhoneCall(c, r, now, { settled: true });
      const connected = row.raw.call_status === "connected";
      const media = connected ? await adapters.read.callMedia(ac, row.external_id) : null;
      item.transcript = !!media?.transcript?.length;
      await c.query("update recordings set raw = raw || $2::jsonb where id=$1", [row.id, JSON.stringify({ transcript_status: item.transcript ? "ready" : "none", repaired: "D275" })]);
    }
    repaired.push(item);
  }
  if (!a.dryRun && repaired.length) await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'calls.repaired','company',$2,$3)", [co.id, co.id, { why: a.why, count: repaired.length, ids: repaired.map((x) => x.id) }]);
  return { ok: true, dryRun: a.dryRun !== false, repaired, still_unfinished: still, unread, left: stuck.length - batch.length };
}
