/** What writeDefaults needs of a connection: a pool client or the migrator. */
type Q = { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> };

/**
 * D193 (audit §3.1, open item 50 part 2; Tyler: "Updating the default doesn't do anything to existing offers"). Every company setting
 * the engine falls back on when an offer has not set it, listed once with that fallback. The fallback only seeds an offer: install
 * writes these onto a new one and migration 0004 wrote each existing offer's effective value onto it, so changing a default never
 * changes an offer that exists. And one reading of a yes/no setting (four had grown, each taking different words).
 */
export type SettingKind = "text" | "number" | "switch";

// The defaults themselves, here and nowhere else (the modules that read these settings take them from here). This file imports
// nothing of the engine's, so any module can read it.
/** D118: the Sales Call's Primary Objection options an offer that never declared its own was given. */
export const DEFAULT_OBJECTIONS = ["price", "partner", "timing", "fear", "medical", "burned_before", "competitor", "think_about_it"];
/** The disposition key the engine writes for each meaning (eod.ts), when an offer has not mapped its own. */
export const DISPOSITION_DEFAULTS: Record<string, string> = { closed: "closed_won", deposit: "deposit", pending: "close_pending", follow_up: "follow_up", lost: "lost", unqualified: "dq" };
/** D87: the call flow's timings (minutes; hours for the hold). */
export const CALL_SETTING_DEFAULTS = { "calls.transcript_wait_min": 120, "calls.conversation_gap_min": 15, "setter_result.set_within_min": 30, "calls.transcript_hold_hours": 48 } as const;
/** D88, D135: an open alert is said again after this many minutes, only within these hours (Tyler's working day, Arizona); a poll failing this many times in a row is a problem. */
export const REPEAT_AFTER_MIN = 60, POLL_FAILURES = 2, REPEAT_HOURS = "07:00-17:00", REPEAT_TZ = "America/Phoenix";

/** `sales_call.dispositions` as an offer would set it ({value: meaning}): the keys the engine itself writes, pending included. */
export const ENGINE_DISPOSITIONS: Record<string, string> = Object.fromEntries(Object.entries(DISPOSITION_DEFAULTS).map(([meaning, key]) => [key, meaning]));

// Not listed, because their readers disagree on what "unset" means, so no one value is what the offer runs on (D193, for Tyler):
// crm.object_discovery_call (setter results and the bot's graph fall back on custom_objects.discovery_call; the end of day reads no
// Discovery Calls at all), sales_call.dispositions (ledger drift takes "unset" as "no Deposit option"; the end of day writes `deposit`)
// and sales_call.objections (the Sales Call takes DEFAULT_OBJECTIONS; the application-triage playbook refuses an offer that has not named its own).
export const SETTING_DEFAULTS = {
  "alerts.repeat_minutes": { kind: "number", default: String(REPEAT_AFTER_MIN) },
  "alerts.poll_failures": { kind: "number", default: String(POLL_FAILURES) },
  "alerts.repeat_hours": { kind: "text", default: REPEAT_HOURS },
  "alerts.repeat_timezone": { kind: "text", default: REPEAT_TZ },
  "calls.transcript_wait_min": { kind: "number", default: String(CALL_SETTING_DEFAULTS["calls.transcript_wait_min"]) },
  "calls.conversation_gap_min": { kind: "number", default: String(CALL_SETTING_DEFAULTS["calls.conversation_gap_min"]) },
  "setter_result.set_within_min": { kind: "number", default: String(CALL_SETTING_DEFAULTS["setter_result.set_within_min"]) },
  "calls.transcript_hold_hours": { kind: "number", default: String(CALL_SETTING_DEFAULTS["calls.transcript_hold_hours"]) },
  "crm.object_payment": { kind: "text", default: "custom_objects.payment" },
  "booking.setter_rule": { kind: "text", default: "calendar" },
  "crm.tasks": { kind: "switch", default: "on" },
  "setter_result.act": { kind: "switch", default: "off" },
  "eod.setter_calls": { kind: "switch", default: "off" },
  "slack.live": { kind: "switch", default: "off" },
  "reports.quiet_when_empty": { kind: "switch", default: "off" },
  "qualify.unanswered_is_mql": { kind: "switch", default: "off" },
} as const satisfies Record<string, { kind: SettingKind; default: string }>;
export type DefaultedKey = keyof typeof SETTING_DEFAULTS;

const ON = /^(true|yes|on|1)$/i, OFF = /^(false|no|off|0)$/i;
/** A setting an offer holds at exactly its default: what install wrote, not something the offer chose (copying settings overwrites it). */
export const isDefaultValue = (key: string, value: string | undefined) => key in SETTING_DEFAULTS && value === SETTING_DEFAULTS[key as DefaultedKey].default;

/** The one reading of a yes/no setting: on, off, or (unset, or a word that is neither) its default. */
export function switchOn(bindings: Record<string, string>, key: DefaultedKey & keyof { [K in DefaultedKey as (typeof SETTING_DEFAULTS)[K]["kind"] extends "switch" ? K : never]: true }): boolean {
  const v = (bindings[key] ?? "").trim();
  return ON.test(v) ? true : OFF.test(v) ? false : ON.test(SETTING_DEFAULTS[key].default);
}

/** Writes every listed setting an offer lacks, as its default; says which. Install and migration 0004 use it. */
export async function writeDefaults(c: Q, companyId: string): Promise<string[]> {
  const have = new Set(((await c.query("select key from bindings where company_id=$1", [companyId])).rows as { key: string }[]).map((r) => r.key));
  const missing = (Object.keys(SETTING_DEFAULTS) as DefaultedKey[]).filter((k) => !have.has(k));
  for (const k of missing) await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,convert_to($4,'UTF8')) on conflict (company_id, key) do nothing",
    [companyId, k, SETTING_DEFAULTS[k].kind === "number" ? "number" : "text", SETTING_DEFAULTS[k].default]);
  return missing;
}
