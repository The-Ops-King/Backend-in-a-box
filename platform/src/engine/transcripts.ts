import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import type { Node } from "./definition";
import { resolvePath } from "./template";
import { transcriptText, type RecordingRow } from "./recordings";
import { callSetting } from "./call-settings";

/**
 * D87: "For this application we'll never store the transcripts." A transcript is read from its source at the moment a step
 * needs it and dropped when the step is done:
 *
 * - a GHL dialer call: the CRM keeps it; `callMedia` reads it again (every retry reads it again too);
 * - a Fathom recording: the webhook delivered it once, so it is HELD on the recording row until the runs that read it are
 *   done (`releaseHeldTranscripts`, from the runner), kept while one of them is paused on a failing step, and cleared by the
 *   retention sweep (`sweepHeldTranscripts`) at the latest `calls.transcript_hold_hours` after the last of them ended. Once
 *   cleared, a step that needs it again reads it from Fathom's API (`secret.fathom_api_key`).
 *
 * A template reads `{{recording.transcript_text}}` (the run's call) or `{{vars.<lookup>.transcript_text}}` (every call in a
 * list a `lookup` answered, e.g. the parts of one conversation, each headed "Part n of N"). Neither is ever in the ledger:
 * the executor fills them just before the step runs and takes them out of the context after it (so a parked run never saves
 * one), and the classify event does not copy its input when the input is a transcript.
 */

type Deps = { c: PoolClient; adapters: Adapters; adapterCompany: Company; bindings: Record<string, string>; company: { timezone: string }; ctx: Record<string, unknown> };

/** One recording's transcript as text: held on the row (a once-only delivery), else read again from where it lives. "" when there is none. */
export async function transcriptFor(d: Pick<Deps, "adapters" | "adapterCompany" | "bindings">, r: Pick<RecordingRow, "provider" | "external_id" | "transcript">): Promise<string> {
  if (r.transcript?.length) return transcriptText(r.transcript);
  if (r.provider === "ghl") return transcriptText((await d.adapters.read.callMedia(d.adapterCompany, r.external_id))?.transcript ?? null);
  const key = d.bindings["secret.fathom_api_key"];
  if (r.provider === "fathom" && key && d.adapters.recorder) return transcriptText(await d.adapters.recorder.transcript(key, r.external_id));
  return "";
}

/** `x.transcript_text` paths a step's settings read, by the object they hang off (`recording`, `vars.convo`). */
export const transcriptRefs = (node: Node): string[] => [...new Set([...JSON.stringify(node).matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\.transcript_text\b/g)].map((m) => m[1]))];

/**
 * Fills each `<base>.transcript_text` the step reads: a recording (`{ id }`) gets its own; a list answer (`{ items: [{ id }] }`) gets
 * every item's, in order, each headed "Part n of N (time, length)" when there is more than one. Returns the paths it set, for
 * `dropTranscripts` after the step. A source that is down throws, so the step is retried by the failure policy (D66).
 */
export async function hydrateTranscripts(d: Deps, node: Node): Promise<string[]> {
  const set: string[] = [];
  for (const base of transcriptRefs(node)) {
    const v = resolvePath(d.ctx, base) as { id?: unknown; items?: unknown } | undefined;
    if (!v || typeof v !== "object") continue;
    const items = Array.isArray(v.items) ? (v.items as { id?: unknown; started_at?: string; duration_min?: number }[]) : typeof v.id === "string" ? [{ id: v.id }] : [];
    const ids = items.map((i) => i.id).filter((x): x is string => typeof x === "string");
    const rows = ids.length ? await many<RecordingRow>(d.c, "select * from recordings where id = any($1::uuid[])", [ids]) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const parts: string[] = [];
    for (const [i, it] of items.entries()) {
      const r = typeof it.id === "string" ? byId.get(it.id) : undefined;
      const text = r ? await transcriptFor(d, r) : "";
      if (items.length === 1) { parts.push(text); continue; }
      const at = r ? DateTime.fromJSDate(r.started_at).setZone(d.company.timezone).toFormat("h:mm a") : "";
      const len = r?.duration_min ?? it.duration_min;
      parts.push(`Part ${i + 1} of ${items.length}${at ? ` (${at}${len != null ? `, ${len} min` : ""})` : ""}:\n${text || "(no transcript for this part)"}`);
    }
    (v as Record<string, unknown>).transcript_text = parts.join("\n\n").trim();
    set.push(base);
  }
  return set;
}

/** Takes the transcripts `hydrateTranscripts` put in the context back out, so nothing the run saves carries one. */
export function dropTranscripts(ctx: Record<string, unknown>, bases: string[]): void {
  for (const base of bases) { const v = resolvePath(ctx, base); if (v && typeof v === "object") delete (v as Record<string, unknown>).transcript_text; }
}

const runsOf = `select 1 from runs x where x.company_id=r.company_id and x.context->'event'->>'recording_id' = r.id::text`;

/** A run reached its end: the transcript a webhook delivered for its recording is let go, unless another run about that recording is still going (or paused on a step). */
export async function releaseHeldTranscripts(c: PoolClient, run: { id: string; company_id: string; context: Record<string, unknown> }): Promise<number> {
  const recId = (run.context.event as { recording_id?: unknown } | undefined)?.recording_id;
  if (typeof recId !== "string") return 0;
  const r = await c.query(`update recordings r set transcript=null, summary=null, raw = case when r.transcript is not null then r.raw || '{"transcript_status":"ready"}'::jsonb else r.raw end
    where r.id::text=$1 and r.company_id=$2 and (r.transcript is not null or r.summary is not null)
      and not exists (${runsOf} and x.id<>$3 and x.status in ('active','waiting','paused'))`, [recId, run.company_id, run.id]);
  return r.rowCount ?? 0;
}

/**
 * Retention's safety net: any transcript or summary still held `calls.transcript_hold_hours` (48 unless the company says otherwise)
 * after the last run about it ended (or after it arrived, when nothing ran) is cleared, unless a run about it is still going or paused.
 */
export async function sweepHeldTranscripts(c: PoolClient, now = new Date()): Promise<number> {
  let n = 0;
  for (const co of await many<{ id: string; v: Buffer | null }>(c, "select co.id, b.value as v from companies co left join bindings b on b.company_id=co.id and b.key='calls.transcript_hold_hours'")) {
    const hours = callSetting(co.v ? { "calls.transcript_hold_hours": co.v.toString("utf8") } : {}, "calls.transcript_hold_hours");
    const r = await c.query(`update recordings r set transcript=null, summary=null, raw = case when r.transcript is not null then r.raw || '{"transcript_status":"ready"}'::jsonb else r.raw end
      where r.company_id=$1 and (r.transcript is not null or r.summary is not null)
        and not exists (${runsOf} and x.status in ('active','waiting','paused'))
        and coalesce((select max(x.finished_at) from runs x where x.company_id=r.company_id and x.context->'event'->>'recording_id' = r.id::text), r.received_at) < $2::timestamptz - make_interval(hours => $3::int)`, [co.id, now, hours]);
    n += r.rowCount ?? 0;
  }
  return n;
}
