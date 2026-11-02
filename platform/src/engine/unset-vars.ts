import type { Definition, Node } from "./definition";

/**
 * D304 (Tyler: "every time we fix the alert we should be making a fix that makes sure that alert doesn't need to happen in the
 * future"). PMU's Call booked v15 added a follow-up path that reached the booking card without the steps that set its headline
 * (`vars.head`); every follow-up booking then failed with "unknown path {{vars.head}}" (Tanganyika Brewer, 2026-11-02). Such a
 * definition is found when it is saved, not when a person books: a step that reads `vars.X` with no fallback (`| default:`), on a path
 * from a trigger that never sets X, is named. Set: a set_var's key, the `into` of a step that remembers (analyze, report, eod_due, …),
 * an ensure_contact's own id. Not reads: a condition (when, only_if, a wait's match: an absent value compares as empty), a value with a
 * pipe that means "may be absent" (default, prefix, line, link, bullets, oneof, each: template.ts), a var the step itself sets, or one
 * guarded by `exists`; nor anything a record step reads (bookkeeping lands an absent value as null). A step that runs only sometimes (only_if) counts as setting what it sets: whether its condition and a reader's
 * agree is the workflow's design, not a path the chart can see.
 */
export type UnsetRead = { node: string; title?: string; var: string; missing_on: string };

/** The vars a step itself sets for the steps after it (a step skipped by its own only_if sets nothing, so it is not counted). */
export function setsOf(n: Node): string[] {
  const o = n as unknown as { key?: string; into?: string | string[] };
  if (n.type === "set_var") return o.key ? [o.key] : [];
  const into = o.into === undefined ? [] : Array.isArray(o.into) ? o.into : [o.into];
  const vars = into.map((x) => String(x).replace(/^vars\./, "").split(".")[0]).filter(Boolean);
  if (n.type === "ensure_contact") vars.push(n.id);
  return n.type === "eod_due" ? [...vars, "overdue_lines"] : vars;
}

const guarded = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => guarded(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "exists" && typeof x === "string" && x.startsWith("vars.")) out.add(x.slice(5).split(".")[0]); else guarded(x, out); }
  return out;
};

/** The vars a step reads with no fallback: each {{…}} whose expression names vars.X and has no `default` filter. */
export function readsOf(n: Node): string[] {
  if (n.type === "record") return [];   // bookkeeping: an absent value lands as null, never a failure (executor.ts)
  const safe = new Set([...guarded(n), ...setsOf(n)]), out = new Set<string>();
  const walk = (v: unknown, key?: string) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\{\{((?:[^{}]|\{[^{}]*\})*)\}\}/g)) {
        const expr = m[1]; if (/\|\s*(default|prefix|line|link|bullets|oneof|each)\b/.test(expr)) continue;
        const head = /^\s*vars\.([A-Za-z0-9_]+)/.exec(expr); if (head && !safe.has(head[1])) out.add(head[1]);
      }
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!["title", "description", "note", "when", "only_if", "match"].includes(k)) walk(x, k);
  };
  walk(n);
  return [...out];
}

/** Each step that reads a var some path from a trigger reaches it without setting. */
export function unsetReads(def: Definition): UnsetRead[] {
  const nodes = new Map(def.nodes.map((n) => [n.id, n]));
  const preds = new Map<string, string[]>();
  for (const e of def.edges) preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
  // must[n]: the vars set on every path from a trigger to n (before n runs); null: not reached yet
  const must = new Map<string, Set<string> | null>(def.nodes.map((n) => [n.id, n.type === "trigger" ? new Set<string>() : null]));
  const after = (id: string) => { const m = must.get(id); return m ? new Set([...m, ...setsOf(nodes.get(id)!)]) : null; };
  for (let changed = true, guard = 0; changed && guard < 1000; guard++) {
    changed = false;
    for (const n of def.nodes) {
      if (n.type === "trigger") continue;
      const ins = (preds.get(n.id) ?? []).map(after).filter((s): s is Set<string> => !!s);
      if (!ins.length) continue;
      const next = new Set([...ins[0]].filter((v) => ins.every((s) => s.has(v))));
      const cur = must.get(n.id);
      if (!cur || cur.size !== next.size || [...next].some((v) => !cur.has(v))) { must.set(n.id, next); changed = true; }
    }
  }
  const out: UnsetRead[] = [];
  for (const n of def.nodes) {
    const m = must.get(n.id); if (!m) continue;
    for (const v of readsOf(n)) {
      if (m.has(v)) continue;
      // name a step before it that reaches it without setting v, so the fix is findable
      const via = (preds.get(n.id) ?? []).find((p) => { const a = after(p); return a && !a.has(v); }) ?? "a trigger";
      out.push({ node: n.id, title: (n as { title?: string }).title, var: v, missing_on: via });
    }
  }
  return out;
}
