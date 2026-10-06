import type { Predicate } from "./definition";
import { resolvePath } from "./template";

const isRef = (v: unknown): v is string => typeof v === "string" && /^\{\{\s*[a-zA-Z0-9_.]+\s*\}\}$/.test(v);
export function operand(v: unknown, ctx: Record<string, unknown>): unknown {
  return isRef(v) ? resolvePath(ctx, v.replace(/[{}\s]/g, "")) : v;
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
  if ("exists" in p) { const v = resolvePath(ctx, p.exists); return v !== undefined && v !== null && v !== ""; }
  if ("and" in p) return p.and.every((q) => evaluate(q, ctx));
  if ("or" in p) return p.or.some((q) => evaluate(q, ctx));
  if ("not" in p) return !evaluate(p.not, ctx);
  return false;
}
