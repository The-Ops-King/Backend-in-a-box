import type { PoolClient } from "pg";
import { many } from "@/db/client";
import { resolve } from "./alerts";

/**
 * D66. One failure policy for every step, decided here and applied by the runner.
 *
 *   transient  network error, timeout, 408/425/429/5xx, Postgres connection trouble → retried in place on RETRY_SCHEDULE (three tries in all, D76)
 *   auth       401/403: the token is wrong or lost a scope → paused at once; one alert per company per vendor; a new token wakes every run paused on it
 *   permanent  400/404/422, "not found" / "invalid" from the vendor, a step's own config error → no retry
 *   unknown    anything else → one retry as if transient, then permanent
 * Once the tries are spent (D77): a non-blocking step (blocking.ts) is skipped, one alert, and the run goes on; a blocking one holds
 * the run on that step, re-checked alone on HOLD_RECHECK_MIN while it is down (transient), or paused for a person (permanent).
 */
export type FailureClass = "transient" | "auth" | "permanent" | "unknown";
export type Classified = { cls: FailureClass; vendor: string | null; status: number | null; answered: boolean; message: string };

/** Minutes after each failed try before the next; the length is the number of retries. D76: no loops, at most three tries of a step in all, then one alert. */
export const RETRY_SCHEDULE = [1, 5];
/** D77: a blocking step that is down after its three tries is looked at again alone: 15 minutes after the hold, then every hour, until it passes. */
export const HOLD_RECHECK_MIN = [15, 60];

/** A vendor's refusal with its shape kept: the adapters that can afford it throw this; the rest throw strings this module parses. */
export class VendorError extends Error {
  constructor(public vendor: string, public status: number, public path: string, public body: string, message?: string) {
    super(message ?? `${vendor} ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = "VendorError";
  }
}

const TRANSIENT_STATUS = new Set([408, 425, 429]);
const NETWORK = /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_\w+)\b|socket hang up|fetch failed|timed out|timeout|network error|connection (terminated|refused|reset|closed)|too many clients|the database system is (starting|shutting)/i;
const VENDOR_WORDS: [RegExp, string][] = [[/\bGHL \d{3} on\b|^GHL\b|leadconnector|gohighlevel/, "ghl"], [/^slack\b/i, "slack"], [/\bjev\b/i, "jev"], [/anthropic|claude/i, "anthropic"], [/^calendly\b|calendly/i, "calendly"], [/^whop\b/i, "whop"], [/^fathom\b/i, "fathom"], [/resend/i, "resend"]];
const SLACK_AUTH = /\b(invalid_auth|not_authed|token_revoked|token_expired|account_inactive|missing_scope)\b/;
const SLACK_TRANSIENT = /\b(ratelimited|service_unavailable|internal_error|fatal_error|request_timeout)\b/;

export const classOfStatus = (status: number): FailureClass => status === 401 || status === 403 ? "auth" : TRANSIENT_STATUS.has(status) || status >= 500 ? "transient" : status === 400 || status === 404 || status === 422 ? "permanent" : status >= 400 && status < 500 ? "permanent" : "unknown";

/** What kind of failure this is, which vendor said it, and whether the vendor answered at all (a status means the write did not happen; silence means it may have). */
export function classifyError(e: unknown): Classified {
  const message = (e instanceof Error ? e.message : typeof e === "string" ? e : String((e as { message?: string })?.message ?? e)).slice(0, 500);
  if (e instanceof VendorError) return { cls: classOfStatus(e.status), vendor: e.vendor, status: e.status, answered: true, message };
  const vendor = VENDOR_WORDS.find(([re]) => re.test(message))?.[1] ?? null;
  // an SDK error (Anthropic's) carries its HTTP status as a property
  const prop = e && typeof e === "object" && typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : null;
  // "GHL 503 on /path: …", "fathom: create webhook 500 …", "whop: list payments 429 …", "… → 502: …"
  const inText = /\bGHL (\d{3}) on\b/.exec(message)?.[1] ?? /^(?:GHL|[a-z]+:\s*[a-z ]*?)\s*(\d{3})\b/i.exec(message)?.[1] ?? /(?:\bstatus|\bHTTP|→)\s*(\d{3})\b/i.exec(message)?.[1] ?? /\b(\d{3})\s+(?:Unauthorized|Forbidden|Not Found|Bad Request|Too Many Requests|Service Unavailable|Bad Gateway|Gateway Timeout|Internal Server Error)\b/i.exec(message)?.[1];
  const status = prop ?? (inText ? Number(inText) : null);
  if (status !== null) return { cls: classOfStatus(status), vendor, status, answered: true, message };
  if (vendor === "slack") return { cls: SLACK_AUTH.test(message) ? "auth" : SLACK_TRANSIENT.test(message) ? "transient" : "permanent", vendor, status: null, answered: !SLACK_TRANSIENT.test(message), message };
  if (NETWORK.test(message)) return { cls: "transient", vendor, status: null, answered: false, message };
  if (/\b(unauthori[sz]ed|invalid (private integration )?token|token (is )?(invalid|expired|revoked)|forbidden|missing scope)\b/i.test(message)) return { cls: "auth", vendor, status: null, answered: true, message };
  if (/\b(not found|invalid|does not exist|no such|unknown (field|path)|rendered empty|has no CRM id|no edge matched|no appointment on run|no opportunity on run|the model declined|unresolved)\b/i.test(message)) return { cls: "permanent", vendor, status: null, answered: true, message };
  return { cls: "unknown", vendor, status: null, answered: true, message };
}

/** The vendor whose token a binding holds, so replacing it can wake the runs paused on that vendor's auth. */
export function vendorOfBinding(key: string): string | null {
  return ({ "secret.ghl_pit": "ghl", "secret.calendly_token": "calendly", "secret.jev_key": "jev", "secret.anthropic_key": "anthropic", "secret.whop_api_key": "whop", "secret.fathom_api_key": "fathom", "secret.resend_key": "resend" } as Record<string, string>)[key] ?? null;
}

/** The exit_reason a paused run carries: `<class>[:<vendor>]: <what the vendor said>`, so the wake below can find the runs by vendor. */
export const pauseReason = (f: Classified, suffix?: string) => `${f.cls}${f.vendor ? `:${f.vendor}` : ""}: ${f.message}${suffix ? ` ${suffix}` : ""}`;

/**
 * A token was replaced: every run paused on that vendor's auth gets one more try of its step, now, and the vendor's auth
 * alert closes (a token that is still wrong re-raises it at the first step that fails). Returns the runs woken.
 */
export async function wakePausedOnAuth(c: PoolClient, companyId: string, vendor: string, now = new Date()): Promise<string[]> {
  const woken = await many<{ id: string }>(c, `update runs set status='waiting', next_run_at=$3, step_attempt=0, finished_at=null, claimed_at=null, claimed_by=null
    where company_id=$1 and status='paused' and exit_reason like $2 returning id`, [companyId, `auth:${vendor}:%`, now]);
  await resolve(c, companyId, `auth:${vendor}`, now);
  for (const r of woken) await resolve(c, companyId, `run:${r.id}:paused`, now, true);
  return woken.map((r) => r.id);
}

const VENDOR_NAME: Record<string, string> = { ghl: "GHL", slack: "Slack", calendly: "Calendly", jev: "Jev", anthropic: "The AI (Anthropic)", whop: "Whop", fathom: "Fathom", resend: "Resend" };
const STATUS_WORDS: Record<number, string> = { 400: "refused the request", 401: "rejected the token", 403: "refused access", 404: "has no such record", 408: "timed out", 409: "says it conflicts with what is there", 422: "refused the data", 425: "asked us to wait", 429: "is rate-limiting us", 500: "had an internal error", 502: "is unavailable", 503: "is unavailable", 504: "timed out" };
const unescape = (s: string) => { try { return JSON.parse(`"${s}"`) as string; } catch { return s; } };
const sentence = (s: string) => s.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");

/**
 * D77: a step's error as a person reads it in an alert: the vendor's own message out of its body (GHL `message` /
 * `errors[].message`, Calendly `message` / `details`, Slack `error`), else the status as words, never raw JSON; no final
 * period. "GHL says a record with the same value for External ID - test-20254447 already exists". The raw error stays in the
 * alert's detail and on the run page.
 */
export function plainError(f: Pick<Classified, "vendor" | "status" | "message">): string {
  const raw = f.message.trim();
  const who = f.vendor ? VENDOR_NAME[f.vendor] ?? f.vendor : null;
  // "GHL 400 on /path: <body>", "slack: invalid_auth", "fathom: create webhook 500 <body>", "POST url → 502: <body>"
  const prefixed = f.vendor ? new RegExp(`^${f.vendor}:\\s*(?:[a-z ]*?\\d{3}\\s*)?([\\s\\S]*)$`, "i").exec(raw)?.[1] : undefined;
  const body = /\b[A-Za-z]+ \d{3} on \S+:\s*([\s\S]*)$/.exec(raw)?.[1] ?? /→\s*\d{3}:\s*([\s\S]*)$/.exec(raw)?.[1] ?? prefixed ?? raw;
  const said = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? /"details"\s*:\s*\[\s*\{[^}]*?"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
  if (said) return sentence(`${who ?? "The vendor"} says ${unescape(said).replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase())}`);
  const text = body.trim();
  if (who === "Slack" && /^[a-z_]+$/.test(text)) return sentence(`Slack says ${text.replace(/_/g, " ")}`);
  if (f.status !== null && (!text || /^[[{<]/.test(text) || text === raw)) return sentence(`${who ?? "The vendor"} ${STATUS_WORDS[f.status] ?? `answered ${f.status}`}`);
  if (text && text !== raw && !/^[[{<]/.test(text)) return sentence(`${who ?? "The vendor"} says ${text.slice(0, 200).replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase())}`);
  return sentence(raw.slice(0, 200));
}
