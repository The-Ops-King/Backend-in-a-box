import { DATE_FORMATS, type DateFormat, formatDate, localHour, relativeWords, toInstant } from "./dates";

/** What a render needs besides the context: the clock, and the zones dates are written in. */
export type RenderEnv = {
  now: Date;
  /** The offer's own time zone: Slack lines and team-facing dates. */
  offerZone: string;
  /** The contact's time zone, when the run is about a contact who has one. Contact-facing dates use it, else the offer's. */
  contactZone?: string;
};

/** A filter refused its input: a date that is not a date, a time that has already passed. The text is held, never sent. */
export class FilterError extends Error {}

export type FilterDef = {
  /** Whether the filter takes an argument after a colon. */
  arg: "none" | "optional" | "required";
  /** Checked at save time: a message, or nothing when the argument is fine. */
  checkArg?: (arg: string) => string | undefined;
  /** The filter says "this may be empty": a blank result is what the author wrote, not a missing value. */
  blankOk?: true;
  apply: (v: unknown, arg: string | undefined, env: RenderEnv) => unknown;
};

/** Empty in the sense a message cares about: nothing there, an empty string, or an empty list. */
export const isAbsent = (v: unknown): boolean => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

const instant = (v: unknown): Date => {
  const d = toInstant(v);
  if (!d) throw new FilterError(`not a date: ${String(v)}`);
  return d;
};
const number = (v: unknown): number | undefined => (isAbsent(v) || typeof v === "boolean" || Number.isNaN(Number(v)) ? undefined : Number(v));
const contactZone = (env: RenderEnv) => env.contactZone ?? env.offerZone;
const checkDateFormat = (arg: string) => ((DATE_FORMATS as readonly string[]).includes(arg) ? undefined : `date format is one of ${DATE_FORMATS.join(", ")}`);
const checkNumber = (arg: string) => (/^\d+$/.test(arg) ? undefined : "takes a whole number");

/**
 * The fixed set of filters a template may use, `{{path | name:arg}}`. Every date filter passes an absent value through,
 * so `default` or `optional` after it still decides what an absent date reads as.
 */
export const FILTERS: Record<string, FilterDef> = {
  /** The argument when the value is absent: {{contact.first_name | default:there}}. */
  default: { arg: "required", apply: (v, arg) => (isAbsent(v) ? arg : v) },
  /** Says the value may be absent; a blank here is intended and is never held. */
  optional: { arg: "none", blankOk: true, apply: (v) => v },
  lower: { arg: "none", apply: (v) => (isAbsent(v) ? v : String(v).toLowerCase()) },
  upper: { arg: "none", apply: (v) => (isAbsent(v) ? v : String(v).toUpperCase()) },
  /** The first word of a name: "Ana Maria Lopez" → "Ana". */
  first_name: { arg: "none", apply: (v) => (isAbsent(v) ? v : String(v).trim().split(/\s+/)[0]) },
  /** At most N characters, with an ellipsis when cut: truncate:300. */
  truncate: { arg: "required", checkArg: checkNumber, apply: (v, arg) => {
    if (isAbsent(v)) return v;
    const n = Number(arg), s = String(v);
    return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
  } },
  /** 2999 → "2,999"; 2999.5 → "2,999.50"; money:0 rounds to whole units. The currency sign is the content's to write. */
  money: { arg: "optional", checkArg: checkNumber, apply: (v, arg) => {
    const n = number(v);
    if (n === undefined) return undefined;
    if (arg === undefined) return n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
    const d = Number(arg);
    return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  } },
  /** The number without its sign: a refund is stored negative and the content writes the minus. */
  abs: { arg: "none", apply: (v) => { const n = number(v); return n === undefined ? undefined : Math.abs(n); } },
  /** A date in the contact's zone (the offer's when the contact has none): date:medium. */
  date: { arg: "required", checkArg: checkDateFormat, apply: (v, arg, env) => (isAbsent(v) ? v : formatDate(instant(v), arg as DateFormat, contactZone(env))) },
  /** A date in the offer's zone, for what the team reads: offer_date:time_zone. */
  offer_date: { arg: "required", checkArg: checkDateFormat, apply: (v, arg, env) => (isAbsent(v) ? v : formatDate(instant(v), arg as DateFormat, env.offerZone)) },
  /** How far away a future time is, in words, at the moment of sending. A past time is refused: the message is held. */
  relative: { arg: "optional", checkArg: (a) => (["auto", "minutes", "hours"].includes(a) ? undefined : "relative takes auto, minutes or hours"), apply: (v, arg, env) => {
    if (isAbsent(v)) return v;
    const words = relativeWords(instant(v), (arg ?? "auto") as "auto" | "minutes" | "hours", env.now, contactZone(env));
    if (words === undefined) throw new FilterError(`${String(v)} is not in the future`);
    return words;
  } },
  /** Hours from now until that time, one decimal, negative once it has passed: a number, for conditions. */
  hours_until: { arg: "none", apply: (v, _arg, env) => (isAbsent(v) ? undefined : Math.round(((instant(v).getTime() - env.now.getTime()) / 3_600_000) * 10) / 10) },
  /** The hour of the day (0 to 23) of that time in the contact's zone: a number, for conditions ("a call at 9am or later"). */
  hour: { arg: "none", apply: (v, _arg, env) => (isAbsent(v) ? undefined : localHour(instant(v), contactZone(env))) },
  /** A labelled value, or nothing at all: {{contact.setter.name | prefix:"*Setter:*"}} → "*Setter:* Luis". */
  prefix: { arg: "required", blankOk: true, apply: (v, arg) => (isAbsent(v) ? "" : `${arg} ${toText(v)}`) },
  /** Like prefix, on its own line, so an absent value leaves no empty line behind. */
  line: { arg: "optional", blankOk: true, apply: (v, arg) => (isAbsent(v) ? "" : `\n${arg ? `${arg} ` : ""}${toText(v)}`) },
  /** A Slack link when there is a URL, else nothing: {{recording.share_url | link:Recording}}. */
  link: { arg: "optional", blankOk: true, apply: (v, arg) => (isAbsent(v) ? "" : `<${toText(v)}|${arg ?? toText(v)}>`) },
  /** A list as one line: join:", " (the default separator is ", "). */
  join: { arg: "optional", apply: (v, arg) => (Array.isArray(v) ? v.filter((x) => !isAbsent(x)).map(toText).join(arg ?? ", ") : v) },
  /** A picklist guard: the value only when it is one of the listed ones, else absent. oneof:"deposit,refund". */
  oneof: { arg: "required", apply: (v, arg) => (typeof v === "string" && (arg ?? "").split(",").map((x) => x.trim()).includes(v) ? v : undefined) },
};

/** How a value reads inside text. */
export function toText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.filter((x) => !isAbsent(x)).map(toText).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
