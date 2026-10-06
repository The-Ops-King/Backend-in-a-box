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

type Filter = (v: unknown, arg: string | undefined, env: RenderEnv) => unknown;
export type RenderEnv = { now?: DateTime; tz: string };

const filters: Record<string, Filter> = {
  relative: (v, arg, env) => relative(toDT(v, env.tz), (arg as "auto" | "minutes" | "hours") ?? "auto", (env.now ?? DateTime.now()).setZone(env.tz)),
  date: (v, arg, env) => toDT(v, env.tz).toFormat(arg ?? "ccc, LLL d 'at' h:mma"),
  tz: (v, arg) => toDT(v, arg ?? "UTC").toISO(),
  upper: (v) => String(v ?? "").toUpperCase(),
  lower: (v) => String(v ?? "").toLowerCase(),
  first_name: (v) => String(v ?? "").trim().split(/\s+/)[0] ?? "",
  default: (v, arg) => (v === undefined || v === null || v === "" ? arg : v),
};
function toDT(v: unknown, tz: string): DateTime {
  const dt = v instanceof Date ? DateTime.fromJSDate(v) : typeof v === "string" ? DateTime.fromISO(v) : DateTime.invalid("not a date");
  if (!dt.isValid) throw new Error(`not a datetime: ${String(v)}`);
  return dt.setZone(tz);
}

/** Renders `{{ path | filter:arg | filter2 }}`. Unknown path → throws (also enforced at save). */
export function render(template: string, ctx: Record<string, unknown>, env: RenderEnv): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const [pathRaw, ...pipes] = expr.split("|").map((s) => s.trim());
    let v = resolvePath(ctx, pathRaw);
    if (v === undefined && !pipes.some((p) => p.startsWith("default"))) throw new UnknownPathError(`unknown path {{${pathRaw}}}`);
    for (const pipe of pipes) {
      // split on the FIRST colon only — "date:h:mma" has a colon inside its argument
      const i = pipe.indexOf(":"); const name = (i < 0 ? pipe : pipe.slice(0, i)).trim(); const arg = i < 0 ? undefined : pipe.slice(i + 1).trim();
      const f = filters[name];
      if (!f) throw new Error(`unknown filter ${name}`);
      v = f(v, arg, env);
    }
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Save-time check: every {{path}} must be a known root. Bindings are checked against the manifest separately. */
export const KNOWN_ROOTS = ["contact", "appointment", "opportunity", "company", "calendar", "slack", "reply", "event", "vars", "crm", "secret", "now"];
export function referencedPaths(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)/g)].map((m) => m[1]);
}
