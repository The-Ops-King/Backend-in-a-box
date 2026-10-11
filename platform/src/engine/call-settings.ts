/**
 * D87: the company settings the call flow reads (bindings of kind text, offered on the settings screen). Each is the
 * company's to change; these are only the values a company that never set one gets.
 *
 * - `calls.transcript_wait_min`: how long after hang-up a connected dialer call is re-checked for its transcript (every
 *   minute, by the poll) before it settles without one.
 * - `calls.conversation_gap_min`: the next call of the same caller to the same person starting within this of the last
 *   one ending is the same conversation (a dropped line, a hang-up by accident).
 * - `setter_result.set_within_min`: a booking through a setter link for the person, made during the call or within this
 *   long after hang-up, makes the call Set. The template, the context (`recording.set_until`) and the metrics all read it.
 * - `calls.transcript_hold_hours`: the longest a transcript a webhook delivered may stay held after the last run about it
 *   ended (retention's safety sweep; transcripts.ts).
 */
export const CALL_SETTING_DEFAULTS = { "calls.transcript_wait_min": 120, "calls.conversation_gap_min": 15, "setter_result.set_within_min": 30, "calls.transcript_hold_hours": 48 } as const;
export type CallSettingKey = keyof typeof CALL_SETTING_DEFAULTS;

/** A whole number ≥ 0 from the binding (minutes; hours for the hold), else the default. */
export function callSetting(bindings: Record<string, string>, key: CallSettingKey): number {
  const raw = (bindings[key] ?? "").trim(), n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n) : CALL_SETTING_DEFAULTS[key];
}

/** The same, read from the bindings table (metrics, the poll's helpers that have no bindings in hand). */
export async function callSettingOf(c: import("pg").PoolClient, companyId: string, key: CallSettingKey): Promise<number> {
  const r = await c.query<{ value: Buffer }>("select value from bindings where company_id=$1 and key=$2", [companyId, key]);
  return callSetting(r.rows[0] ? { [key]: r.rows[0].value.toString("utf8") } : {}, key);
}
