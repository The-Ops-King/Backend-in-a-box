import { DateTime } from "luxon";
import type { Predicate } from "./definition";
import { render, resolvePath, UnknownPathError, type RenderEnv } from "./template";

const isRef = (v: unknown): v is string => typeof v === "string" && /^\{\{\s*[a-zA-Z0-9_.]+\s*\}\}$/.test(v);
const hasRef = (v: unknown): v is string => typeof v === "string" && /\{\{[^}]*\}\}/.test(v);
// the zones the date filters need: a predicate reads the same context a message is rendered against
const envOf = (ctx: Record<string, unknown>): RenderEnv => {
  const companyTz = (ctx.company as { timezone?: string } | undefined)?.timezone;
  const now = typeof ctx.now === "string" ? DateTime.fromISO(ctx.now) : undefined;
  return { tz: (ctx.contact as { timezone?: string } | undefined)?.timezone ?? companyTz ?? "UTC", companyTz, now: now?.isValid ? now : undefined };
};
/** A bare `{{path}}` keeps its type (a boolean stays a boolean); anything else with `{{…}}` in it is rendered, so `{{appointment.starts_at | date:HH}}` compares as "14", not as the literal string. */
export function operand(v: unknown, ctx: Record<string, unknown>): unknown {
  if (isRef(v)) return resolvePath(ctx, v.replace(/[{}\s]/g, ""));
  if (!hasRef(v)) return v;
  try { return render(v, ctx, envOf(ctx)); }
  catch (e) { if (e instanceof UnknownPathError) return undefined; throw e; }   // an absent value compares the way a bare path's undefined does
}
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" && !isNaN(+v) ? +v : NaN);

export function evaluate(p: Predicate, ctx: Record<string, unknown>): boolean {
  if ("eq" in p) return operand(p.eq[0], ctx) == operand(p.eq[1], ctx);
  if ("neq" in p) return operand(p.neq[0], ctx) != operand(p.neq[1], ctx);
  if ("gt" in p) return num(operand(p.gt[0], ctx)) > num(operand(p.gt[1], ctx));
  if ("gte" in p) return num(operand(p.gte[0], ctx)) >= num(operand(p.gte[1], ctx));
  if ("lt" in p) return num(operand(p.lt[0], ctx)) < num(operand(p.lt[1], ctx));
  if ("lte" in p) return num(operand(p.lte[0], ctx)) <= num(operand(p.lte[1], ctx));
  if ("in" in p) { const v = operand(p.in[0], ctx); return p.in[1].some((x) => operand(x, ctx) == v); }
  if ("has" in p) { const list = operand(p.has[0], ctx), v = operand(p.has[1], ctx); return Array.isArray(list) ? list.some((x) => x == v) : typeof list === "string" ? list.split(",").map((x) => x.trim()).includes(String(v)) : false; }
  if ("exists" in p) { const v = resolvePath(ctx, p.exists); return v !== undefined && v !== null && v !== ""; }
  if ("and" in p) return p.and.every((q) => evaluate(q, ctx));
  if ("or" in p) return p.or.some((q) => evaluate(q, ctx));
  if ("not" in p) return !evaluate(p.not, ctx);
  return false;
}
