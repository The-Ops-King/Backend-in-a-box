import type { PoolClient } from "pg";
import { many } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { loadCompany } from "./context";
import { transcriptFor } from "./transcripts";
import type { RecordingRow } from "./recordings";

/**
 * D226 backfill (Tyler, 2026-10-23: "Yeah backfill with recorded calls. Leave jps calls alone"). The closing calls before the end of
 * day asked whether they were pitched, read from their recordings with the same test the call review uses: the closer presented
 * the offer and its price. The dry run answers each call with Jev's read and the line that shows it; nothing is written. The write
 * takes a person's answers (`decide`: appointment id → true / false) and sets only those bookings, only where nobody has said yet.
 * Calls with no recording, and the closers left out (`exclude`, their emails), are not touched.
 */
export type PitchedRow = { appointment: string; starts_at: string; prospect: string; closer: string | null; recordings: string[]; pitched: boolean | null; evidence: string; error?: string };
const SYSTEM = `You read the transcript of a sales call between a closer and a prospect. Decide whether the closer PITCHED: presented the offer (the program) and its price or investment. If the price or investment was presented, it is a pitch even if the prospect said no. Talking about goals, or ending the call before the offer and price, is not a pitch.
Answer JSON only: {"pitched": true | false | null, "evidence": "one short verbatim line from the transcript that shows the offer and price, or why not"}. Use null only when the transcript is too broken to tell.`;

export async function backfillPitched(c: PoolClient, adapters: Adapters, companyId: string, opts: { from: Date; to: Date; exclude?: string[]; dryRun: boolean; decide?: Record<string, boolean> }): Promise<{ rows: PitchedRow[]; written?: number }> {
  if (!opts.dryRun) {
    let written = 0;
    for (const [id, v] of Object.entries(opts.decide ?? {})) {
      if (typeof v !== "boolean") continue;
      const r = await c.query("update appointments set pitched=$3 where company_id=$1 and id=$2 and pitched is null", [companyId, id, v]);
      written += r.rowCount ?? 0;
    }
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'appointments.pitched_backfill','company',$2,$3)", [companyId, companyId, { decide: opts.decide ?? {}, written }]);
    return { rows: [], written };
  }
  const co = await loadCompany(c, companyId);
  const key = co.bindings["secret.anthropic_key"] || process.env.ANTHROPIC_API_KEY;
  const exclude = (opts.exclude ?? []).map((e) => e.trim().toLowerCase());
  const appts = await many<{ id: string; contact_id: string; starts_at: Date; prospect: string; closer: string | null; closer_email: string | null }>(c,
    `select a.id, a.contact_id, a.starts_at, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as prospect, u.name as closer, lower(u.email) as closer_email
       from appointments a join contacts ct on ct.id=a.contact_id left join users u on u.id=a.assigned_user_id
       left join company_terms t on t.id=a.appointment_term
      where a.company_id=$1 and a.starts_at >= $2 and a.starts_at < $3 and a.status <> 'cancelled' and a.pitched is null and coalesce(t.category,'closing')='closing'
      order by a.starts_at`, [companyId, opts.from, opts.to]);
  const rows: PitchedRow[] = [];
  for (const a of appts) {
    if (a.closer_email && exclude.includes(a.closer_email)) continue;
    // its own recordings, else the contact's within the hour around it (as the end of day finds them)
    const recs = await many<RecordingRow>(c, `select * from recordings where company_id=$1 and provider='fathom' and (appointment_id=$2 or (appointment_id is null and contact_id=$3 and started_at between $4::timestamptz - interval '30 minutes' and $4::timestamptz + interval '90 minutes')) order by started_at`,
      [companyId, a.id, a.contact_id, a.starts_at]);
    if (!recs.length) continue;
    const row: PitchedRow = { appointment: a.id, starts_at: a.starts_at.toISOString(), prospect: a.prospect, closer: a.closer, recordings: recs.map((r) => r.share_url ?? r.external_id), pitched: null, evidence: "" };
    rows.push(row);
    let text = "";
    try { for (const r of recs) text += (text ? "\n\n" : "") + await transcriptFor({ adapters, adapterCompany: co.adapterCompany, bindings: co.bindings }, r); }
    catch (e) { row.error = `transcript: ${String((e as Error).message).slice(0, 160)}`; continue; }
    if (!text.trim()) { row.error = "no transcript"; continue; }
    if (!key) { row.error = "no Anthropic key bound"; continue; }
    try {
      const r = await adapters.analyst.analyze(key, { system: SYSTEM, input: text, format: "json", maxTokens: 300 });
      const v = r.parsed as { pitched?: unknown; evidence?: unknown } | undefined;
      row.pitched = typeof v?.pitched === "boolean" ? v.pitched : null;
      row.evidence = typeof v?.evidence === "string" ? v.evidence.slice(0, 300) : "";
    } catch (e) { row.error = `read: ${String((e as Error).message).slice(0, 160)}`; }
  }
  return { rows };
}
