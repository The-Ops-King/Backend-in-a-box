import { DateTime, Duration } from "luxon";

export class StaleTemplateError extends Error { constructor(msg: string) { super(msg); this.name = "StaleTemplateError"; } }
export class UnknownPathError extends Error { constructor(msg: string) { super(msg); this.name = "UnknownPathError"; } }

export function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Parses "4h", "30m", "2d", "90s" into a Duration. */
export function parseDuration(s: string): Duration {
  const m = /^([+-]?)(\d+)\s*(s|m|h|d|w)$/.exec(s.trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  const n = +m[2] * (m[1] === "-" ? -1 : 1);
  const unit = { s: "seconds", m: "minutes", h: "hours", d: "days", w: "weeks" }[m[3] as "s" | "m" | "h" | "d" | "w"] as "seconds";
  return Duration.fromObject({ [unit]: n });
}

const round5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);
const clock = (dt: DateTime) => dt.minute === 0 ? dt.toFormat("ha").toLowerCase() : dt.toFormat("h:mma").toLowerCase();

/**
 * D5a: deliberately imprecise. Throws on a non-positive duration so "in -30 minutes" can't ship;
 * the node's staleness policy catches the throw.
 */
export function relative(target: DateTime, mode: "auto" | "minutes" | "hours", now: DateTime = DateTime.now()): string {
  const mins = target.diff(now, "minutes").minutes;
  if (mins <= 0) throw new StaleTemplateError(`target ${target.toISO()} is not in the future`);
  if (mode === "minutes") return `in about ${round5(mins)} minutes`;
  if (mode === "hours") {
    const h = Math.round(mins / 30) / 2;
    return h <= 1 ? "in about an hour" : `in about ${h % 1 === 0 ? h : h.toFixed(1)} hours`;
  }
  if (mins < 60) return `in about ${round5(mins)} minutes`;
  if (mins < 240) return relative(target, "hours", now);
  const t = target.setZone(now.zone), n = now.setZone(now.zone);
  if (t.hasSame(n, "day")) return `today at ${clock(t)}`;
  if (t.hasSame(n.plus({ days: 1 }), "day")) return `tomorrow at ${clock(t)}`;
  if (t.diff(n, "days").days < 6) return `${t.toFormat("cccc")} at ${clock(t)}`;
  return `${t.toFormat("ccc, LLL d")} at ${clock(t)}`;
}

type Filter = (v: unknown, arg: string | undefined, env: RenderEnv, ctx: Record<string, unknown>) => unknown;
export type RenderEnv = { now?: DateTime; tz: string; companyTz?: string };

const absent = (v: unknown) => v === undefined || v === null || v === "";
const filters: Record<string, Filter> = {
  // the date filters pass an absent value through untouched, so `{{contact.first_booked_at | date_company | default:—}}` reads as "—" instead of throwing
  relative: (v, arg, env) => (absent(v) ? undefined : relative(toDT(v, env.tz), (arg as "auto" | "minutes" | "hours") ?? "auto", (env.now ?? DateTime.now()).setZone(env.tz))),
  date: (v, arg, env) => (absent(v) ? undefined : toDT(v, env.tz).toFormat(arg ?? "ccc, LLL d 'at' h:mma")),
  // same as date, in the company's zone: lists the team reads (Slack, pipeline cards) stay in one zone
  date_company: (v, arg, env) => (absent(v) ? undefined : toDT(v, env.companyTz ?? env.tz).toFormat(arg ?? "ccc LLL d · h:mm a ZZZZ")),
  tz: (v, arg) => (absent(v) ? undefined : toDT(v, arg ?? "UTC").toISO()),
  // hours from now until that time, one decimal, negative once it has passed: {{appointment.starts_at | hours_until}} → 41.5
  hours_until: (v, _arg, env) => (absent(v) ? undefined : Math.round(toDT(v, env.tz).diff(env.now ?? DateTime.now(), "hours").hours * 10) / 10),
  words: (v) => String(v ?? "").replace(/[_-]+/g, " "),   // closed_won → closed won
  upper: (v) => String(v ?? "").toUpperCase(),
  lower: (v) => String(v ?? "").toLowerCase(),
  first_name: (v) => String(v ?? "").trim().split(/\s+/)[0] ?? "",
  default: (v, arg) => (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) ? arg : v),
  // D85: one rendered line per item of a list, the argument a template of its own with {{item.*}}, {{index}} (from 0) and {{number}} (from 1)
  // beside everything else in the context: {{vars.days | each:"• {{item.label}}: {{item.count}} calls" | join:"\n" | default:No calls}}
  each: (v, arg, env, ctx) => (Array.isArray(v) ? v : absent(v) ? [] : [v]).map((item, index) => render(arg ?? "{{item}}", { ...ctx, item, index, number: index + 1 }, env)),
  join: (v, arg) => (Array.isArray(v) ? v.map((x) => (x === undefined || x === null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x))).join(arg ?? ", ") : v),
  json: (v) => (v === undefined ? "" : JSON.stringify(v, null, 2)),
  // an analysis object as Slack / note text: keys become labels, lists become bullets, anything named like a quote is a blockquote
  lines: (v) => renderLines(v),
  // a picklist guard: the value only when it is one of the allowed ones, else nothing (the CRM drops an unknown option silently, which reads like the field was never written)
  oneof: (v, arg) => (typeof v === "string" && (arg ?? "").split(",").map((x) => x.trim()).includes(v) ? v : ""),
  truncate: (v, arg) => { const n = Number(arg ?? 300); const s = String(v ?? ""); return s.length > n ? `${s.slice(0, n - 1)}…` : s; },
  // a labelled line only when there is a value: {{contact.fields.setter | prefix:*Setter:* }} → "*Setter:* Luis", or nothing at all
  prefix: (v, arg) => (v === undefined || v === null || v === "" ? "" : `${arg ?? ""} ${v}`.trim()),
  // a Slack link only when there is a URL: {{recording.share_url | link:Fathom}} → <https://…|Fathom>, or nothing
  link: (v, arg) => (v === undefined || v === null || v === "" ? "" : `<${String(v)}|${arg ?? String(v)}>`),
  // like prefix, on its own line: "\n*Setter:* Luis" after the line before it, or nothing at all (no blank line left behind)
  line: (v, arg) => (v === undefined || v === null || v === "" ? "" : `\n${arg ? `${arg} ` : ""}${v}`),
  // a refund is stored negative; the sign is written by the template ("−$500"), the number by this
  abs: (v) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? "" : Math.abs(Number(v))),
  // D88: words for counts in lists. nonzero: 0 is nothing (so `default`, `each`, `then` treat it as absent); plural: 1 → "1 call", 3 → "3 calls" (plural:call or plural:"person|people")
  nonzero: (v) => (v === 0 || v === "0" ? undefined : v),
  plural: (v, arg) => { if (absent(v) || isNaN(Number(v))) return ""; const [one, many] = (arg ?? "").split("|"); const n = Number(v); return `${n} ${n === 1 ? one : many ?? `${one}s`}`; },
  // the argument when the value is there (not absent, not false, not 0, not an empty list), else nothing: {{item.both | then:", "}}
  then: (v, arg) => (absent(v) || v === false || v === 0 || (Array.isArray(v) && !v.length) ? "" : arg ?? ""),
  // the value with the argument after it, or nothing: {{n | plural:call | suffix:" with no outcome"}}
  suffix: (v, arg) => (absent(v) ? "" : `${v}${arg ?? ""}`),
  // a number with a fixed count of decimals, no thousands separator: 1500 | fixed:2 → 1500.00 ; nothing → ""
  fixed: (v, arg) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? "" : Number(v).toFixed(Number(arg ?? 0))),
  // 2999 → 2,999 ; 2999.5 → 2,999.50 ; nothing → ""
  money: (v) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? "" : Number(v).toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(Number(v)) ? 0 : 2, maximumFractionDigits: 2 })),
  // a list as one line when short, else bullets; an object list shows its lead field (the objection, the pain) — for Slack lines like *Pain:* …
  bullets: (v) => { const items = (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]).map((x) => (x && typeof x === "object" ? scalar((x as Record<string, unknown>)[Object.keys(x as object).find((k) => /objection|pain|desire|name|label|title|text/i.test(k)) ?? Object.keys(x as object)[0]]) : scalar(x))).filter(Boolean); return items.length <= 1 || items.join(", ").length <= 80 ? items.join(", ") : `\n${items.map((i) => `• ${i}`).join("\n")}`; },
};

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length);
const label = (k: string) => k.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
const scalar = (v: unknown) => (typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));
const isQuoteKey = (k: string) => /quote|verbatim|said/i.test(k);
/** Generic: walks whatever shape the analysis has, so a prompt change never breaks the message. */
export function renderLines(v: unknown): string {
  if (typeof v === "string") return v;
  const out: string[] = [];
  const walk = (key: string, value: unknown, depth: number) => {
    if (isEmpty(value)) return;
    const pad = "    ".repeat(depth), name = label(key);
    if (Array.isArray(value)) {
      if (value.every((x) => typeof x !== "object" || x === null)) {
        const items = value.filter((x) => !isEmpty(x)).map(scalar); if (!items.length) return;
        if (isQuoteKey(key)) { out.push(`${pad}*${name}:*`); items.forEach((q) => out.push(`${pad}> _"${q}"_`)); }
        else if (items.length <= 3 && items.join(", ").length <= 90) out.push(`${pad}*${name}:* ${items.join(", ")}`);
        else { out.push(`${pad}*${name}:*`); items.forEach((i) => out.push(`${pad}• ${i}`)); }
        return;
      }
      out.push(`${pad}*${name}:*`);
      for (const obj of value as Record<string, unknown>[]) {
        if (isEmpty(obj)) continue;
        const keys = Object.keys(obj).filter((k) => !isEmpty(obj[k])); if (!keys.length) continue;
        if (keys.length === 1) { out.push(`${pad}• ${scalar(obj[keys[0]])}`); continue; }
        const lead = keys.find((k) => /name|type|title|label|pain|desire|objection/i.test(k));
        if (lead) { out.push(`${pad}• *${scalar(obj[lead])}*`); keys.filter((k) => k !== lead).forEach((k) => walk(k, obj[k], depth + 1)); }
        else keys.forEach((k) => walk(k, obj[k], depth + 1));
      }
      return;
    }
    if (typeof value === "object") { const o = value as Record<string, unknown>; const keys = Object.keys(o).filter((k) => !isEmpty(o[k])); if (!keys.length) return; out.push(`${pad}*${name}:*`); keys.forEach((k) => walk(k, o[k], depth + 1)); return; }
    if (isQuoteKey(key)) out.push(`${pad}> _"${scalar(value)}"_`); else out.push(`${pad}*${name}:* ${scalar(value)}`);
  };
  if (v && typeof v === "object" && !Array.isArray(v)) Object.entries(v as Record<string, unknown>).forEach(([k, x]) => walk(k, x, 0));
  else walk("value", v, 0);
  return out.join("\n");
}
function toDT(v: unknown, tz: string): DateTime {
  const dt = v instanceof Date ? DateTime.fromJSDate(v) : typeof v === "string" ? DateTime.fromISO(v) : DateTime.invalid("not a date");
  if (!dt.isValid) throw new Error(`not a datetime: ${String(v)}`);
  return dt.setZone(tz);
}

/** A filter argument in double quotes may hold `|`, `}}` and `{{…}}` of its own (`each`, D85); `\"` `\\` `\n` `\t` inside it are escapes. */
const quotedArg = (i: number, t: string, from: number) => t[i] === '"' && /:\s*$/.test(t.slice(from, i));
const unquote = (a: string) => (a.length >= 2 && a.startsWith('"') && a.endsWith('"') ? a.slice(1, -1).replace(/\\(["\\nt])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c)) : a);
/** The outermost `{{ … }}` of a template, quoted filter arguments read whole; an unclosed one is text. */
export function exprSpans(t: string): { start: number; end: number; expr: string }[] {
  const out: { start: number; end: number; expr: string }[] = [];
  for (let i = t.indexOf("{{"); i >= 0; i = t.indexOf("{{", i)) {
    let j = i + 2, q = false;
    for (; j < t.length; j++) {
      if (q) { if (t[j] === "\\") j++; else if (t[j] === '"') q = false; continue; }
      if (quotedArg(j, t, i + 2)) q = true;
      else if (t[j] === "}" && t[j + 1] === "}") break;
    }
    if (j >= t.length) break;
    const expr = t.slice(i + 2, j).trim();
    if (expr) out.push({ start: i, end: j + 2, expr });
    i = j + 2;
  }
  return out;
}
/** The pipes of one expression, split outside quoted arguments. */
function pipesOf(expr: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let j = 0; j < expr.length; j++) {
    const ch = expr[j];
    if (q) { cur += ch; if (ch === "\\" && j + 1 < expr.length) cur += expr[++j]; else if (ch === '"') q = false; continue; }
    if (ch === '"' && /:\s*$/.test(cur)) q = true;
    if (ch === "|") { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** One `path | filter:arg | filter2` expression, as a value (its type kept: a number stays a number). Unknown path → throws (also enforced at save). */
export function resolveExpr(expr: string, ctx: Record<string, unknown>, env: RenderEnv): unknown {
  const [pathRaw, ...pipes] = pipesOf(expr);
  let v = resolvePath(ctx, pathRaw);
  if (v === undefined && !pipes.some((p) => /^(default|prefix|line|link|bullets|oneof|each)\b/.test(p))) throw new UnknownPathError(`unknown path {{${pathRaw}}}`);   // these pipes mean "may be absent" (an absent list is an empty one)
  for (const pipe of pipes) {
    // split on the FIRST colon only — "date:h:mma" has a colon inside its argument
    const i = pipe.indexOf(":"); const name = (i < 0 ? pipe : pipe.slice(0, i)).trim(); const arg = i < 0 ? undefined : unquote(pipe.slice(i + 1).trim());
    const f = filters[name];
    if (!f) throw new Error(`unknown filter ${name}`);
    v = f(v, arg, env, ctx);
  }
  return v;
}
/** Renders `{{ path | filter:arg | filter2 }}`. Unknown path → throws (also enforced at save). */
export function render(template: string, ctx: Record<string, unknown>, env: RenderEnv): string {
  let out = "", at = 0;
  for (const s of exprSpans(template)) { const v = resolveExpr(s.expr, ctx, env); out += template.slice(at, s.start) + (v === undefined || v === null ? "" : String(v)); at = s.end; }
  return out + template.slice(at);
}

/** Save-time check: every {{path}} must be a known root. Bindings are checked against the manifest separately. */
export const KNOWN_ROOTS = ["contact", "appointment", "opportunity", "company", "calendar", "slack", "reply", "event", "vars", "crm", "secret", "now", "cards", "record", "recording", "prompt", "agreement", "records", "user", "reaction", "picklist", "setting",
  "data", "item", "index", "number"];   // data: the event a wait_for_event match is reading; item, index, number: inside an `each` (D85)
export function referencedPaths(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)/g)].map((m) => m[1]);
}
