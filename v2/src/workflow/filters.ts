import { DATE_FORMATS, type DateFormat, formatDate, localHour, relativeWords, toInstant } from "./dates";
import { toMs } from "./duration";

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
  /** `ctx`: the context the template is rendered against (only `option` reads it: the offer's own picklist keys). */
  apply: (v: unknown, arg: string | undefined, env: RenderEnv, ctx: Record<string, unknown>) => unknown;
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
const checkDuration = (arg: string) => (/^[1-9]\d*(s|m|h|d|w)$/.test(arg) ? undefined : 'takes a duration: "30m", "2h", "1d"');
const checkName = (arg: string) => (/^[a-z][a-z0-9_]*$/.test(arg) ? undefined : "takes a picklist name: lowercase words joined by _");
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : isAbsent(v) ? [] : [v]);
const scalar = (v: unknown) => (typeof v === "boolean" ? (v ? "Yes" : "No") : toText(v));
const LEAD = /objection|pain|desire|name|label|title|text/i;

/** A date-time moved by a duration, as an ISO time: for time arithmetic in params, conditions and wait anchors. */
const shift = (sign: 1 | -1) => (v: unknown, arg: string | undefined) => (isAbsent(v) ? v : new Date(instant(v).getTime() + sign * toMs(arg!)).toISOString());

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
  /** That time plus a duration, as an ISO time: {{appointment.booked_at | plus:5m}}. */
  plus: { arg: "required", checkArg: checkDuration, apply: shift(1) },
  /** That time minus a duration, as an ISO time: {{appointment.starts_at | minus:30m}}. */
  minus: { arg: "required", checkArg: checkDuration, apply: shift(-1) },
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

  // Lists and counts. `each` is applied by the renderer (it renders a template of its own per item); the rest are plain.
  /**
   * One rendered line per item of a list: each:"• {{item.label}}: {{item.count}}". Inside it `item` is the item,
   * `index` its place from 0, `number` from 1, and `parent` the item of the list around it (a nested each). Gives back
   * the list of lines, for `join`. Every blank inside an item is reported, with which item it was.
   */
  each: { arg: "required", apply: () => { throw new FilterError("each is applied by the renderer"); } },
  /** The first N items of a list (first: the first one, as a list of one). */
  first: { arg: "optional", checkArg: checkNumber, apply: (v, arg) => (Array.isArray(v) ? v.slice(0, Number(arg ?? 1)) : v) },
  /**
   * A list as one line when it is short (one item, or 80 characters at most joined), else one "• item" line each on
   * new lines; an item that is an object shows its lead field (objection, pain, desire, name, label, title or text).
   */
  bullets: { arg: "none", apply: (v) => {
    const items = asList(v).map((x) => {
      if (!x || typeof x !== "object" || Array.isArray(x)) return scalar(x);
      const o = x as Record<string, unknown>;
      return scalar(o[Object.keys(o).find((k) => LEAD.test(k)) ?? Object.keys(o)[0]!]);
    }).filter((x) => x !== "");
    if (!items.length) return undefined;
    return items.length <= 1 || items.join(", ").length <= 80 ? items.join(", ") : `\n${items.map((i) => `• ${i}`).join("\n")}`;
  } },
  /** An answer object as labelled lines: keys become *Labels:*, lists become bullets, anything named like a quote a blockquote. */
  lines: { arg: "none", apply: (v) => { if (isAbsent(v)) return v; const out = renderLines(v); return out === "" ? undefined : out; } },
  /** closed_won → "closed won": underscores and dashes as spaces. */
  words: { arg: "none", apply: (v) => (isAbsent(v) ? v : toText(v).replace(/[_-]+/g, " ")) },
  /** A count with its noun: plural:call gives "1 call", "3 calls"; plural:"person|people" names both. */
  plural: { arg: "required", apply: (v, arg) => {
    const n = number(v);
    if (n === undefined) return undefined;
    const [one, many] = (arg ?? "").split("|");
    return `${n} ${n === 1 ? one : many ?? `${one}s`}`;
  } },
  /** Zero is nothing: so `default`, `then`, `suffix` and `optional` treat a 0 as absent. */
  nonzero: { arg: "none", apply: (v) => (v === 0 || v === "0" ? undefined : v) },
  /** The argument when the value is there (not absent, false, 0 or an empty list), else nothing: {{item.both | then:", "}}. */
  then: { arg: "required", blankOk: true, apply: (v, arg) => (isAbsent(v) || v === false || v === 0 ? "" : arg ?? "") },
  /** The value with the argument after it, or nothing at all: {{n | plural:call | suffix:" with no outcome"}}. */
  suffix: { arg: "required", blankOk: true, apply: (v, arg) => (isAbsent(v) ? "" : `${toText(v)}${arg ?? ""}`) },
  /** A number with exactly N decimals and no thousands separator: 1500 | fixed:2 → "1500.00". */
  fixed: { arg: "required", checkArg: checkNumber, apply: (v, arg) => { const n = number(v); return n === undefined ? undefined : n.toFixed(Number(arg)); } },
  /** A fraction as a percentage number: 0.92 → 92 (percent:1 keeps one decimal). The words write the % sign. */
  percent: { arg: "optional", checkArg: checkNumber, apply: (v, arg) => {
    const n = number(v);
    if (n === undefined) return undefined;
    const d = 10 ** Number(arg ?? 0);
    return Math.round(n * 100 * d) / d;
  } },
  /**
   * The offer's own option key for a value, from the setting picklist.<name> (an optional setting): a list keeps the
   * value only when it is one of them; a map gives the key it names for the value; an offer that set nothing for that
   * picklist gets the value as it is.
   */
  option: { arg: "required", checkArg: checkName, apply: (v, arg, _env, ctx) => {
    const p = ((ctx.setting as Record<string, unknown> | undefined)?.picklist as Record<string, unknown> | undefined)?.[arg!];
    if (p === undefined || p === null || p === "") return v;
    if (isAbsent(v)) return v;
    if (Array.isArray(p)) return typeof v === "string" && p.includes(v) ? v : undefined;
    if (typeof p === "object") { const k = (p as Record<string, unknown>)[toText(v).trim().toLowerCase()]; return isAbsent(k) ? undefined : k; }
    return v;
  } },
};

/** Settings a filter reads by itself, which the offer may leave unset (`option` reads picklist.<name>). */
export const filterSettings = (f: { name: string; arg?: string }): string[] => (f.name === "option" && f.arg ? [`picklist.${f.arg}`] : []);

const isEmptyish = (v: unknown) => isAbsent(v) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
const label = (k: string) => k.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
const isQuoteKey = (k: string) => /quote|verbatim|said/i.test(k);

/** An answer object (the AI's notes, a scorecard) as Slack or note text: whatever shape it has, so a prompt change never breaks the words. */
export function renderLines(v: unknown): string {
  if (typeof v === "string") return v;
  const out: string[] = [];
  const walk = (key: string, value: unknown, depth: number) => {
    if (isEmptyish(value)) return;
    const pad = "    ".repeat(depth), name = label(key);
    if (Array.isArray(value)) {
      if (value.every((x) => typeof x !== "object" || x === null)) {
        const items = value.filter((x) => !isEmptyish(x)).map(scalar);
        if (!items.length) return;
        if (isQuoteKey(key)) { out.push(`${pad}*${name}:*`); items.forEach((q) => out.push(`${pad}> _"${q}"_`)); }
        else if (items.length <= 3 && items.join(", ").length <= 90) out.push(`${pad}*${name}:* ${items.join(", ")}`);
        else { out.push(`${pad}*${name}:*`); items.forEach((i) => out.push(`${pad}• ${i}`)); }
        return;
      }
      out.push(`${pad}*${name}:*`);
      for (const obj of value as Record<string, unknown>[]) {
        if (isEmptyish(obj)) continue;
        const keys = Object.keys(obj).filter((k) => !isEmptyish(obj[k]));
        if (!keys.length) continue;
        if (keys.length === 1) { out.push(`${pad}• ${scalar(obj[keys[0]!])}`); continue; }
        const lead = keys.find((k) => /name|type|title|label|pain|desire|objection/i.test(k));
        if (lead) { out.push(`${pad}• *${scalar(obj[lead])}*`); keys.filter((k) => k !== lead).forEach((k) => walk(k, obj[k], depth + 1)); }
        else keys.forEach((k) => walk(k, obj[k], depth + 1));
      }
      return;
    }
    if (typeof value === "object") {
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => !isEmptyish(o[k]));
      if (!keys.length) return;
      out.push(`${pad}*${name}:*`);
      keys.forEach((k) => walk(k, o[k], depth + 1));
      return;
    }
    if (isQuoteKey(key)) out.push(`${pad}> _"${scalar(value)}"_`); else out.push(`${pad}*${name}:* ${scalar(value)}`);
  };
  if (v && typeof v === "object" && !Array.isArray(v)) Object.entries(v as Record<string, unknown>).forEach(([k, x]) => walk(k, x, 0));
  else walk("value", v, 0);
  return out.join("\n");
}

/** How a value reads inside text. */
export function toText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.filter((x) => !isAbsent(x)).map(toText).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
