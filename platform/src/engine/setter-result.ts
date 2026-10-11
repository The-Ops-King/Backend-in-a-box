import type { PoolClient } from "pg";
import { many } from "@/db/client";
import type { Company } from "@/adapters/types";
import type { GhlReads } from "@/adapters/ghl/metrics";
import { testContactSql } from "./mode";

/**
 * D79: what a setter call achieved, as Jev reads it from the transcript, and how often that read matched what happened.
 * The four results are the core vocabulary (`setter_call_result`); the Discovery Call record's `call_result` option keys
 * are the company's own (`discovery_call.results`, {key: meaning}, like `sales_call.outcomes`); unbound, the keys are the
 * meanings themselves.
 */
export const SETTER_RESULTS = ["set", "follow_up", "dq", "not_interested"] as const;
export type SetterResult = (typeof SETTER_RESULTS)[number];
export const RESULT_WORDS: Record<SetterResult, string> = { set: "Set", follow_up: "Follow up", dq: "DQ", not_interested: "Not interested" };
/** A closing call booked this long after the setter call ended counts as Set whatever Jev read. */
export const BOOKED_WITHIN_MIN = 30;
/** How long after the call a booking still says the call set it, for scoring. */
export const TRUTH_DAYS = 7;
export const DISCOVERY_OBJECT = "custom_objects.discovery_call";
const isResult = (v: unknown): v is SetterResult => typeof v === "string" && (SETTER_RESULTS as readonly string[]).includes(v);

function resultMap(bindings: Record<string, string>): Record<string, unknown> {
  try { const j = JSON.parse(bindings["discovery_call.results"] ?? "{}") as unknown; return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : {}; } catch { return {}; }
}
/** meaning → the company's option key; a meaning the map has no key for is "" (the field is left alone). */
export function discoveryResultValues(bindings: Record<string, string>): Record<SetterResult, string> {
  const map = resultMap(bindings);
  if (!Object.keys(map).length) return { set: "set", follow_up: "follow_up", dq: "dq", not_interested: "not_interested" };
  const key = (m: SetterResult) => Object.entries(map).find(([, v]) => v === m)?.[0].trim() ?? "";
  return { set: key("set"), follow_up: key("follow_up"), dq: key("dq"), not_interested: key("not_interested") };
}
/** The meaning of a value on the record (the company's key, or with no map the meaning itself); null when blank or unknown. */
export function discoveryResultMeaning(value: unknown, bindings: Record<string, string>): SetterResult | null {
  const v = String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim().toLowerCase();
  if (!v) return null;
  const map = resultMap(bindings);
  if (!Object.keys(map).length) return isResult(v) ? v : null;
  const hit = Object.entries(map).find(([k]) => k.trim().toLowerCase() === v)?.[1];
  return isResult(hit) ? hit : null;
}
/** `setter_result.act`: off unless the company turned it on. */
export const setterResultActs = (bindings: Record<string, string>) => /^(true|yes|on|1)$/i.test((bindings["setter_result.act"] ?? "").trim());

export type TruthBy = "crm" | "human" | "booking_30m" | "booking_7d" | "dq_tag" | "card_lost" | "no_booking_7d";
export type SetterRead = {
  recording_id: string; contact_id: string; at: Date; setter: string | null; predicted: string; confidence: number | null; result: string; decided_by: string;
  truth: SetterResult | "not_set" | null; truth_by: TruthBy | null; agreed: boolean | null;
};
export const TRUTH_WORDS: Record<TruthBy, string> = { crm: "changed on the Discovery Call record", human: "a team member's tap", booking_30m: `booked within ${BOOKED_WITHIN_MIN} minutes`, booking_7d: `booked within ${TRUTH_DAYS} days`, dq_tag: "a dq tag added in the CRM", card_lost: "the setter card marked lost in the CRM", no_booking_7d: `no booking within ${TRUTH_DAYS} days` };

type Row = { recording_id: string; contact_id: string; end_at: Date; setter: string | null; predicted: string | null; confidence: string | null; result: string | null; decided_by: string | null; booked_30: boolean;
  human: string | null; booked_7d: boolean; dq_tag: boolean; card_lost: boolean; ghl_record_id: string | null; written: string | null };

/**
 * Every setter-call read in [start, end) (one per recording, the latest), people who are test contacts left out, each with
 * what happened since (D79), strongest first: a later change of `call_result` on the Discovery Call record in GHL (read
 * live; skipped when GHL cannot be read), a team member's tap, a booking within 30 minutes, a booking within 7 days → set;
 * a dq tag added in the CRM → dq; the setter card marked lost in the CRM → not interested; Jev read set and 7 days passed
 * with no booking → not set. Anything else is not known yet. Only what a person or the CRM did counts, never the engine's
 * own actions.
 */
export async function setterReads(c: PoolClient, companyId: string, q: { start: Date; end: Date; now: Date; domains: string[]; bindings: Record<string, string>; ac?: Company; reads?: GhlReads }): Promise<{ reads: SetterRead[]; crm_unread?: string }> {
  const object = q.bindings["crm.object_discovery_call"] || DISCOVERY_OBJECT;
  const rows = await many<Row>(c, `
    select * from (select distinct on (e.data->>'recording_id') e.data->>'recording_id' as recording_id, e.contact_id::text as contact_id, coalesce(r.ended_at, r.started_at) as end_at,
        nullif(e.data->>'setter','') as setter, nullif(e.data->>'predicted','') as predicted, nullif(e.data->>'predicted_confidence','') as confidence,
        nullif(e.data->>'result','') as result, nullif(e.data->>'decided_by','') as decided_by, coalesce(e.data->>'booked_within_30m','') = 'true' as booked_30,
        (select h.data->>'decided' from events h where h.company_id=e.company_id and h.event_type='intent.reviewed' and h.data->>'domain'='setter_call_result' and h.data->>'recording_id'=e.data->>'recording_id' order by h.id desc limit 1) as human,
        exists (select 1 from appointments a where a.company_id=e.company_id and a.contact_id=e.contact_id and a.source<>'test' and a.booked_at >= r.started_at and a.booked_at < coalesce(r.ended_at, r.started_at) + make_interval(days => $5)) as booked_7d,
        exists (select 1 from events t where t.company_id=e.company_id and t.contact_id=e.contact_id and t.event_type='tag.added' and t.source='ghl_poll' and (t.data->>'tag'='dq' or t.data->>'tag' like 'dq-%') and t.occurred_at > coalesce(r.ended_at, r.started_at)) as dq_tag,
        exists (select 1 from events m where m.company_id=e.company_id and m.contact_id=e.contact_id and m.event_type='card.moved' and m.data->>'by'='crm' and m.data->>'pipeline_id'=$6 and m.data->>'to_status'='lost' and m.occurred_at > coalesce(r.ended_at, r.started_at)) as card_lost,
        cr.ghl_record_id, cr.properties->>'call_result' as written
      from events e join recordings r on r.id::text = e.data->>'recording_id' join contacts ct on ct.id=e.contact_id
        left join crm_records cr on cr.company_id=e.company_id and cr.object_key=$7 and cr.record_key=e.data->>'external_id'
      where e.company_id=$1 and e.event_type='setter_call.result' and e.occurred_at >= $2 and e.occurred_at < $3 and not ${testContactSql("ct", "$4")}
      order by e.data->>'recording_id', e.id desc) x order by end_at`,
    [companyId, q.start, q.end, q.domains, TRUTH_DAYS, q.bindings["crm.pipeline_setter"] ?? "", object]);
  let live: Map<string, unknown> | null = null, crm_unread: string | undefined;
  if (q.reads && q.ac && rows.some((r) => r.ghl_record_id)) {
    try { live = new Map((await q.reads.objectRecords(q.ac, object)).map((x) => [x.id, x.properties.call_result])); }
    catch (e) { crm_unread = String((e as Error).message).slice(0, 160); }
  }
  const reads = rows.map((r): SetterRead => {
    const crm = live && r.ghl_record_id ? discoveryResultMeaning(live.get(r.ghl_record_id), q.bindings) : null;
    const human = isResult(r.human) ? r.human : null;
    const lapsed = q.now.getTime() > r.end_at.getTime() + TRUTH_DAYS * 86_400_000;
    const [truth, truth_by]: [SetterRead["truth"], TruthBy | null] =
      crm && crm !== discoveryResultMeaning(r.written, q.bindings) ? [crm, "crm"]
      : human ? [human, "human"]
      : r.booked_30 ? ["set", "booking_30m"]
      : r.booked_7d ? ["set", "booking_7d"]
      : r.dq_tag ? ["dq", "dq_tag"]
      : r.card_lost ? ["not_interested", "card_lost"]
      : r.predicted === "set" && lapsed ? ["not_set", "no_booking_7d"]
      : [null, null];
    const predicted = r.predicted ?? "unclear";
    return { recording_id: r.recording_id, contact_id: r.contact_id, at: r.end_at, setter: r.setter, predicted, confidence: r.confidence !== null && !isNaN(Number(r.confidence)) ? Number(r.confidence) : null,
      result: r.result ?? "", decided_by: r.decided_by ?? "", truth, truth_by, agreed: truth === null || !isResult(predicted) ? null : predicted === truth };
  });
  return { reads, ...(crm_unread ? { crm_unread } : {}) };
}

export type AccuracyGroup = { key: string; label: string; reads: number; scored: number; agreed: number };
export type SetterAccuracy = { reads: number; confident: number; scored: number; agreed: number; pending: number; unsure: number; unsure_answered: number; groups: AccuracyGroup[]; crm_unread?: string };
/** Jev's reads that committed to a result and whose outcome is known, how many matched, split by what Jev read (or by setter). */
export function accuracyOf(reads: SetterRead[], by: "result" | "setter" = "result", crm_unread?: string): SetterAccuracy {
  const confident = reads.filter((r) => isResult(r.predicted)), scored = confident.filter((r) => r.agreed !== null);
  const groups = new Map<string, AccuracyGroup>();
  const keyOf = (r: SetterRead) => (by === "result" ? r.predicted : r.setter ?? "");
  if (by === "result") for (const k of SETTER_RESULTS) groups.set(k, { key: k, label: RESULT_WORDS[k], reads: 0, scored: 0, agreed: 0 });
  for (const r of confident) {
    const k = keyOf(r), g = groups.get(k) ?? { key: k, label: by === "result" ? RESULT_WORDS[k as SetterResult] : k || "unknown setter", reads: 0, scored: 0, agreed: 0 };
    g.reads++; if (r.agreed !== null) { g.scored++; if (r.agreed) g.agreed++; }
    groups.set(k, g);
  }
  const unsure = reads.filter((r) => !isResult(r.predicted));
  return { reads: reads.length, confident: confident.length, scored: scored.length, agreed: scored.filter((r) => r.agreed).length, pending: confident.length - scored.length,
    unsure: unsure.length, unsure_answered: unsure.filter((r) => r.truth_by === "human").length, groups: [...groups.values()].filter((g) => g.reads || by === "result"), ...(crm_unread ? { crm_unread } : {}) };
}

/** The line under the number: how many reads, how many still waiting, how many Jev left to the team. */
export function accuracyWords(a: SetterAccuracy): string {
  const parts = [`${a.reads} setter call${a.reads === 1 ? "" : "s"} read`, `${a.scored} with a known outcome`];
  if (a.pending) parts.push(`${a.pending} still waiting on one (no booking, tag, card move or tap yet)`);
  if (a.unsure) parts.push(`Jev was unsure on ${a.unsure} and asked the team (${a.unsure_answered} answered)`);
  return parts.join(" · ") + (a.crm_unread ? ` · couldn't read the Discovery Call records in GHL (${a.crm_unread}), so a change made there isn't counted` : "");
}

