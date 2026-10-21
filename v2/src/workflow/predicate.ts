import { z } from "zod";
import { toInstant } from "./dates";
import { type RenderEnv, isAbsent } from "./filters";
import { type Context, evaluateExpr, parseTemplate, render, wholeExpr } from "./template";

/**
 * A condition over the run's context, used by trigger matches, the premise and branch edges.
 *
 * An operand that is exactly one `{{…}}` is that value with its type kept (a boolean compares as a boolean, a number as a
 * number). A string with other text around a `{{…}}` is rendered and compares as text. Anything else is a literal.
 * `exists` takes a bare path and holds when the value is there and not empty.
 */
export type Predicate =
  | { eq: [unknown, unknown] } | { ne: [unknown, unknown] }
  | { gt: [unknown, unknown] } | { gte: [unknown, unknown] } | { lt: [unknown, unknown] } | { lte: [unknown, unknown] }
  | { in: [unknown, unknown] } | { has: [unknown, unknown] } | { exists: string }
  | { and: Predicate[] } | { or: Predicate[] } | { not: Predicate };

const Operand = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean()]))]);
const Pair = z.tuple([Operand, Operand]);
const strictObj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const Predicate: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    strictObj({ eq: Pair }), strictObj({ ne: Pair }),
    strictObj({ gt: Pair }), strictObj({ gte: Pair }), strictObj({ lt: Pair }), strictObj({ lte: Pair }),
    strictObj({ in: Pair }), strictObj({ has: Pair }),
    strictObj({ exists: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/, { message: "exists takes a bare path, without {{ }}" }) }),
    strictObj({ and: z.array(Predicate).min(1) }), strictObj({ or: z.array(Predicate).min(1) }), strictObj({ not: Predicate }),
  ]),
);

function operand(v: unknown, ctx: Context, env: RenderEnv): unknown {
  if (typeof v !== "string") return v;
  const whole = wholeExpr(v);
  if (whole) return evaluateExpr(whole, ctx, env).value;
  return v.includes("{{") ? render(v, ctx, env).text : v;
}

const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined;

/** Orders two values: numbers (or numeric text) as numbers, two date-times as instants. Anything else has no order. */
function compare(a: unknown, b: unknown): number | undefined {
  const na = asNumber(a), nb = asNumber(b);
  if (na !== undefined && nb !== undefined) return na - nb;
  const da = typeof a === "string" ? toInstant(a) : undefined, db = typeof b === "string" ? toInstant(b) : undefined;
  if (da && db) return da.getTime() - db.getTime();
  return undefined;
}

function equal(a: unknown, b: unknown): boolean {
  if (isAbsent(a) && isAbsent(b)) return true;
  const na = asNumber(a), nb = asNumber(b);
  if (na !== undefined && nb !== undefined && typeof a !== "boolean" && typeof b !== "boolean") return na === nb;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/** Whether a condition holds. An absent value is never greater or less than anything. */
export function holds(p: Predicate, ctx: Context, env: RenderEnv): boolean {
  if ("and" in p) return p.and.every((q) => holds(q, ctx, env));
  if ("or" in p) return p.or.some((q) => holds(q, ctx, env));
  if ("not" in p) return !holds(p.not, ctx, env);
  if ("exists" in p) return !isAbsent(evaluateExpr({ path: p.exists, root: p.exists.split(".")[0]!, filters: [], source: p.exists }, ctx, env).value);
  const [op, pair] = Object.entries(p)[0] as [string, [unknown, unknown]];
  const a = operand(pair[0], ctx, env), b = operand(pair[1], ctx, env);
  switch (op) {
    case "eq": return equal(a, b);
    case "ne": return !equal(a, b);
    case "in": return Array.isArray(b) && b.some((x) => equal(a, x));
    case "has": return Array.isArray(a) && a.some((x) => equal(x, b));
    default: {
      const c = compare(a, b);
      if (c === undefined) return false;
      return op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0;
    }
  }
}

/** Every template string inside a condition, and every bare path it tests, for checking at save time. */
export function predicateParts(p: Predicate): { templates: string[]; paths: string[] } {
  const templates: string[] = [], paths: string[] = [];
  const walk = (q: Predicate) => {
    if ("and" in q) return q.and.forEach(walk);
    if ("or" in q) return q.or.forEach(walk);
    if ("not" in q) return walk(q.not);
    if ("exists" in q) return void paths.push(q.exists);
    for (const side of Object.values(q)[0] as unknown[]) {
      if (typeof side === "string" && side.includes("{{")) templates.push(side);
      if (Array.isArray(side)) for (const x of side) if (typeof x === "string" && x.includes("{{")) templates.push(x);
    }
  };
  walk(p);
  return { templates, paths };
}

/** Template problems inside a condition (unknown roots, unknown filters), each as a message. */
export const predicateErrors = (p: Predicate): string[] => {
  const { templates, paths } = predicateParts(p);
  return [
    ...templates.flatMap((t) => parseTemplate(t).errors),
    ...paths.flatMap((path) => parseTemplate(`{{${path}}}`).errors),
  ];
};
