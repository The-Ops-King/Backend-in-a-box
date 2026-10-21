import { z } from "zod";
import type { Tx } from "@/engine/store";
import { personView } from "@/projections/derived";
import { COLUMNS, type ColType, type PersonRow, type ProjTable, type Rows } from "@/projections/tables";
import type { Period } from "./periods";

/**
 * The metric layer: every number a report says has one definition, as data, in the offer's report definitions. A
 * metric is a small query over the projections, in a fixed vocabulary: which table, which time its period is on, which
 * rows count (filters on its columns, a value or a setting), and how they add up (a count, a sum, a median), split by
 * closer, setter or source. A rate is two metrics divided where it is read, never an average of averages. No SQL
 * comes from a definition: every column is checked against the table's own.
 */

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
/** A value written in the definition, or a setting's value (the metric is not there while it is unset). */
const Value = z.union([Scalar, z.array(Scalar), z.object({ setting: z.string().regex(/^[a-z][a-z0-9_.]*$/) }).strict()]);
const Filter = z.object({
  /** A column of the table, or a field inside one of its JSON columns ("attrs.fields.hair_loss_stage"). */
  col: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*$/),
  /** A field under `col` named by a setting (the offer's own qualifying question): `col` is then the JSON column. */
  field: z.object({ setting: z.string().regex(/^[a-z][a-z0-9_.]*$/) }).strict().optional(),
  op: z.enum(["eq", "ne", "in", "not_in", "is_null", "not_null", "gte", "lte", "before_now", "is_true"]),
  value: Value.optional(),
}).strict();

const Common = { label: z.string(), unit: z.enum(["count", "money", "minutes", "rate"]), what: z.string(), v1: z.string() };
/** Which column each split reads. A team member's key is a CRM user id or a name; a bare name is read as one. */
const Dims = z.object({ closer: z.string().optional(), setter: z.string().optional(), source: z.string().optional() }).strict();

export const MetricDef = z.union([
  /** What the daily counts hold: `fact` is the count's name, `agg` its count (n) or its amount. */
  z.object({ ...Common, from: z.literal("daily_facts"), fact: z.string(), agg: z.enum(["count", "sum"]), where: z.array(Filter).default([]) }).strict(),
  /** Rows of a projection whose `time` falls in the period. */
  z.object({
    ...Common, from: z.enum(["appointments", "calls", "payments", "deals", "contacts_index"]), time: z.string(), where: z.array(Filter).default([]),
    agg: z.enum(["count", "sum", "median", "distinct"]), of: z.string().optional(),
    /** For a sum: what a row with no value adds (a value, or a setting's). */
    ofDefault: Value.optional(),
    dims: Dims.default({}),
  }).strict(),
  z.object({ ...Common, rate: z.object({ num: z.string(), den: z.string() }).strict() }).strict(),
]);
export type MetricDef = z.infer<typeof MetricDef>;

export type GroupBy = "closer" | "setter" | "source";
export type MetricValue = { value: number | null; rows: Map<string, number>; numerator?: number; denominator?: number; unavailable?: string };

export type MetricCtx = { tx: Tx; offerId: string; settings: Record<string, unknown>; now: Date; defs: Record<string, unknown>; people: PersonRow[]; cache?: Map<string, MetricValue> };

/** A metric definition, checked. */
export function metricDef(defs: Record<string, unknown>, name: string): MetricDef {
  const raw = defs[name];
  if (raw === undefined) throw new Error(`the offer has no metric named ${name}`);
  const r = MetricDef.safeParse(raw);
  if (!r.success) throw new Error(`metric ${name} does not validate: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

const get = (row: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), row);

/** Every column a definition names, checked against the table: only the table's own columns (and fields inside its JSON ones). */
function checkCol(table: ProjTable, col: string) {
  const cols = COLUMNS[table] as Record<string, ColType>;
  const [head] = col.split(".");
  if (!cols[head!]) throw new Error(`${table} has no column ${head}`);
  if (col.includes(".") && cols[head!] !== "json") throw new Error(`${table}.${head} has no fields`);
}

class Unavailable extends Error {}

/** A team member's key, as the counts file them. */
const key = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v);
  return s.startsWith("crm:") || s.startsWith("name:") ? s : `name:${s}`;
};

/** The name a key is read as: the person's, else the name it holds. */
export function labelOf(k: string, people: PersonRow[]): string {
  if (!k) return "unassigned";
  if (k.startsWith("crm:")) { const p = people.find((x) => x.crmUserId === k.slice(4)); return (p && (personView(p).name as string)) || k.slice(4); }
  if (k.startsWith("name:")) { const n = k.slice(5); const p = people.find((x) => (x.name ?? "").toLowerCase() === n.toLowerCase()); return p?.name ?? n; }
  return k;
}
/** One key per person: a name a person on the team has is read as their CRM key, so their counts add up. */
function unify(k: string, people: PersonRow[]): string {
  if (!k.startsWith("name:")) return k;
  const p = people.find((x) => (x.name ?? "").toLowerCase() === k.slice(5).toLowerCase());
  return p?.crmUserId ? `crm:${p.crmUserId}` : k;
}

function valueOf(v: z.infer<typeof Value> | undefined, settings: Record<string, unknown>): unknown {
  if (v && typeof v === "object" && !Array.isArray(v) && "setting" in v) {
    const s = settings[v.setting];
    if (s === undefined || s === null || s === "") throw new Unavailable(`the setting ${v.setting} is not set`);
    return s;
  }
  return v;
}

function holds(row: Record<string, unknown>, f: z.infer<typeof Filter>, settings: Record<string, unknown>, now: Date): boolean {
  const field = f.field ? String(valueOf(f.field, settings)) : undefined;
  if (field !== undefined && !/^[a-zA-Z0-9_]+$/.test(field)) throw new Error(`the setting ${f.field!.setting} is not a field name`);
  const x = get(row, field ? `${f.col}.${field}` : f.col);
  const v = valueOf(f.value, settings);
  const t = (a: unknown) => (a instanceof Date ? a.getTime() : a);
  switch (f.op) {
    case "eq": return t(x) === v;
    case "ne": return t(x) !== v;
    case "in": return (Array.isArray(v) ? v : [v]).includes(x as never);
    case "not_in": return !(Array.isArray(v) ? v : [v]).includes(x as never);
    case "is_null": return x === null || x === undefined;
    case "not_null": return x !== null && x !== undefined;
    case "gte": return x !== null && x !== undefined && Number(t(x)) >= Number(v);
    case "lte": return x !== null && x !== undefined && Number(t(x)) <= Number(v);
    case "before_now": return x instanceof Date && x.getTime() < now.getTime();
    case "is_true": return x === true;
  }
}

/** One metric over one period, in total and split one way. */
export async function metric(c: MetricCtx, name: string, period: Period, by?: GroupBy): Promise<MetricValue> {
  const memo = `${name}|${period.from}|${period.to}|${by ?? ""}`;
  const hit = c.cache?.get(memo);
  if (hit) return hit;
  const out = await compute(c, name, period, by);
  c.cache?.set(memo, out);
  return out;
}

async function compute(c: MetricCtx, name: string, period: Period, by?: GroupBy): Promise<MetricValue> {
  const def = metricDef(c.defs, name);
  if ("rate" in def) {
    const n = await metric(c, def.rate.num, period, by), d = await metric(c, def.rate.den, period, by);
    if (n.unavailable || d.unavailable) return { value: null, rows: new Map(), unavailable: n.unavailable ?? d.unavailable };
    const rows = new Map<string, number>();
    for (const k of new Set([...n.rows.keys(), ...d.rows.keys()])) { const dd = d.rows.get(k) ?? 0; if (dd > 0) rows.set(k, (n.rows.get(k) ?? 0) / dd); }
    return { value: d.value ? (n.value ?? 0) / d.value : null, rows, numerator: n.value ?? 0, denominator: d.value ?? 0 };
  }
  try {
    if (def.from === "daily_facts") {
      for (const f of def.where) checkCol("daily_facts", f.col);
      const rows = (await c.tx.projFind("daily_facts", c.offerId, { where: { metric: def.fact } })).filter((r) => r.day >= period.from && r.day <= period.to && def.where.every((f) => holds(r as never, f, c.settings, c.now)));
      const add = (r: Rows["daily_facts"]) => (def.agg === "count" ? r.n : r.amount);
      const total = rows.reduce((s, r) => s + add(r), 0);
      const split = new Map<string, number>();
      if (by) for (const r of rows) { const k = unify(by === "source" ? r.source : r[by], c.people); split.set(k, (split.get(k) ?? 0) + add(r)); }
      return { value: round(total), rows: new Map([...split].map(([k, v]) => [k, round(v)])) };
    }
    checkCol(def.from, def.time);
    for (const f of def.where) checkCol(def.from, f.col);
    if (def.of) checkCol(def.from, def.of);
    for (const col of Object.values(def.dims)) if (col) checkCol(def.from, col);
    const rows = (await c.tx.projFind(def.from, c.offerId, { range: { col: def.time, from: period.start, to: period.end } }))
      .filter((r) => def.where.every((f) => holds(r as never, f, c.settings, c.now))) as unknown as Record<string, unknown>[];
    const fallback = def.ofDefault !== undefined ? valueOf(def.ofDefault, c.settings) : undefined;
    const vals = (rs: Record<string, unknown>[]) => rs.map((r) => (def.of ? get(r, def.of) ?? fallback : undefined));
    const agg = (rs: Record<string, unknown>[]): number | null => {
      if (def.agg === "count") return rs.length;
      if (def.agg === "distinct") return new Set(vals(rs).filter((v) => v !== null && v !== undefined)).size;
      const nums = vals(rs).filter((v) => v !== null && v !== undefined && !Number.isNaN(Number(v))).map(Number);
      if (def.agg === "sum") return round(nums.reduce((s, n) => s + n, 0));
      if (!nums.length) return null;
      const sorted = nums.sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    };
    const split = new Map<string, number>();
    if (by) {
      const col = def.dims[by];
      if (!col) throw new Error(`${def.label} cannot be split by ${by}`);
      const groups = new Map<string, Record<string, unknown>[]>();
      for (const r of rows) { const v = get(r, col); const k = by === "source" ? (v === null || v === undefined ? "" : String(v)) : unify(key(v), c.people); groups.set(k, [...(groups.get(k) ?? []), r]); }
      for (const [k, rs] of groups) { const v = agg(rs); if (v !== null) split.set(k, v); }
    }
    return { value: agg(rows), rows: split };
  } catch (e) {
    if (e instanceof Unavailable) return { value: null, rows: new Map(), unavailable: e.message };
    throw e;
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
