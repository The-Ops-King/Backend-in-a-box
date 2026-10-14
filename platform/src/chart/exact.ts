import type { Chart } from "@/api/words";
import { drawable, labelOf, whenOf } from "./arrange";
import type { GraphLayout } from "./graph";

/**
 * D111: is a drawing exactly the workflow? A drawing is what the page puts in front of Tyler, read back from the SVG
 * itself (draw.ts marks every node and every line with what it stands for), so whatever happens between the layout and
 * the picture (a run's view, a phone's width, groups left out) is what is checked. It is exact when every step that runs
 * is drawn exactly once, every line drawn is a real way the run can go (from that step, to that step, with that way's
 * words and its otherwise-ness), every real way is drawn, and nothing else is. The same check runs in the dashboard
 * (which layout to draw), on save (which layout a workflow gets; refused when neither) and in the daily health sweep.
 */
/** when: the words are a folded branch's condition as the step shows it; on: an arrow that names its step by title. */
export type Line = { from: string; to: string; label: string; else: boolean; when?: boolean; on?: boolean };
/** groups (D114): boxes that each stand for a run of steps, in order; their steps are in `nodes` too. */
export type Drawing = { nodes: string[]; lines: Line[]; problems?: string[]; filtered?: boolean; groups?: string[][] };
/** filtered: a deliberately partial view (a run's path on a phone, said on the page): only what it draws must be real. */
export type Exactness = { exact: boolean; problems: string[]; filtered?: boolean };

const norm = (l: string) => labelOf(l).trim().toLowerCase();
const key = (l: Line) => `${l.from} → ${l.to}${l.label ? ` “${norm(l.label)}”` : ""}${l.else ? " (otherwise)" : ""}`;
const count = (keys: string[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());

/** The real thing: every step that can run and every edge, with its words. */
export function realOf(chart: Chart): Drawing {
  return { nodes: drawable(chart), lines: chart.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, else: !!e.else })) };
}

const unesc = (s: string) => s.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The drawing an SVG from draw.ts is: its nodes (data-id, and the branch a step is drawn as: data-also) and its marked lines. */
export function svgDrawing(svg: string): Drawing {
  const nodes: string[] = []; const lines: Line[] = []; const problems: string[] = []; const groups: string[][] = [];
  for (const m of svg.matchAll(/<g\b([^>]*)>/g)) {
    const a = m[1]; if (!/\bclass="nd\b/.test(a)) continue;
    const id = /\bdata-id="([^"]*)"/.exec(a)?.[1]; const grp = /\bdata-group="([^"]*)"/.exec(a)?.[1];
    if (grp !== undefined) {
      const ids = unesc(grp).split(",").map(decodeURIComponent);
      if (id === undefined || ids[0] !== unesc(id)) problems.push(`a box “${id ?? "?"}” stands for steps it does not start with`);
      groups.push(ids); nodes.push(...ids);
    } else if (id !== undefined) nodes.push(unesc(id));
    const also = /\bdata-also="([^"]*)"/.exec(a)?.[1]; if (also !== undefined) nodes.push(unesc(also));
  }
  for (const m of svg.matchAll(/\bdata-ways="([^"]*)"/g)) for (const part of unesc(m[1]).split(";").filter(Boolean)) {
    const [from, to, label, els, when, on] = part.split("|").map(decodeURIComponent);
    lines.push({ from, to, label, else: els === "1", ...(when === "1" ? { when: true } : {}), ...(on === "1" ? { on: true } : {}) });
  }
  for (const m of svg.matchAll(/\bdata-more="(\d+)"/g)) problems.push(+m[1] === 1 ? "1 step is listed apart, not drawn on the chart" : `${m[1]} steps are listed apart, not drawn on the chart`);
  return { nodes, lines, problems, filtered: /\bdata-filtered="1"/.test(svg), ...(groups.length ? { groups } : {}) };
}

export function exactness(chart: Chart, drawing: Drawing): Exactness {
  const problems = [...(drawing.problems ?? [])];
  const real = realOf(chart); const title = new Map(chart.nodes.map((n) => [n.id, `“${n.title}” (${n.id})`]));
  const name = (id: string) => title.get(id) ?? id;
  const want = new Set(real.nodes); const drawn = count(drawing.nodes); const filtered = !!drawing.filtered;
  // D114: a box stands for its steps only when they are a straight run the workflow really has, each step only keeping a
  // value or reading the ledger: the one way out of each is a plain way to the next, the one way into each after the
  // first is from the one before. Then the ways inside it are drawn by it; nothing can join, leave or fork in between.
  const inner: Line[] = [];
  for (const g of drawing.groups ?? []) {
    const say = `the box “${g.map(name).join(", ")}”`;
    if (g.length < 2) problems.push(`${say} stands for one step`);
    for (const id of g) if (title.has(id) && !chart.nodes.find((n) => n.id === id)!.plumb) problems.push(`${say} hides ${name(id)}, which does more than keep a value`);
    g.forEach((id, i) => {
      const outs = real.lines.filter((l) => l.from === id), ins = real.lines.filter((l) => l.to === id);
      if (i < g.length - 1) {
        const o = outs[0]; if (outs.length !== 1 || o.to !== g[i + 1] || o.label || o.else) problems.push(`${say} hides a way out of ${name(id)}: ${outs.length} way${outs.length === 1 ? "" : "s"} out, to ${outs.map((l) => name(l.to)).join(", ") || "nothing"}`);
        else inner.push(o);
      }
      if (i > 0 && (ins.length !== 1 || ins[0].from !== g[i - 1])) problems.push(`${say} hides a way into ${name(id)} from ${ins.filter((l) => l.from !== g[i - 1]).map((l) => name(l.from)).join(", ") || "nowhere"}`);
    });
  }
  for (const id of real.nodes) if (!drawn.has(id) && !filtered) problems.push(`step ${name(id)} is not drawn`);
  for (const [id, k] of drawn) {
    if (!want.has(id)) problems.push(`${title.has(id) ? `step ${name(id)}` : `a box “${id}”`} is drawn but is not a step that runs`);
    else if (k > 1) problems.push(`step ${name(id)} is drawn ${k} times`);
  }
  const lines = [...drawing.lines, ...inner].map((l) => {
    if (!l.when) return l;
    // a folded branch shows its condition the way the step's blue line says it ("a reschedule" for "this is a reschedule")
    const e = real.lines.find((r) => r.from === l.from && r.to === l.to && !r.else && whenOf(r.label) === l.label);
    return e ? { ...l, label: e.label } : l;
  });
  for (const l of lines) {
    if (!l.to) problems.push(`a line from ${name(l.from)} leads nowhere`);
    if (l.on) {
      // the arrow names its step by title: a title two drawn steps share does not say which one the run goes on to
      const t = chart.nodes.find((n) => n.id === l.to)?.title;
      const same = chart.nodes.filter((n) => n.id !== l.to && n.title === t && drawn.has(n.id)).length;
      if (same) problems.push(`an arrow says “on to ${t}”, and ${same + 1} steps are called that`);
    }
  }
  const say = (l: Line) => `${name(l.from)} → ${l.to ? name(l.to) : "nowhere"}${l.label ? ` “${l.label}”` : ""}${l.else ? " (otherwise)" : ""}`;
  const r = count(real.lines.map(key)), d = count(lines.filter((l) => l.to).map(key));
  const sample = new Map([...real.lines, ...lines].map((l) => [key(l), l]));
  if (!filtered) for (const [k, n] of r) if ((d.get(k) ?? 0) < n) problems.push(`the way ${say(sample.get(k)!)} is not drawn`);
  for (const [k, n] of d) if ((r.get(k) ?? 0) < n) problems.push(`a line ${say(sample.get(k)!)} is drawn but the workflow has no such way`);
  return { exact: !problems.length, problems: [...new Set(problems)], ...(filtered ? { filtered } : {}) };
}

/** What the layout says about the graph's lines beyond the SVG: each must run from its own step's box to its own step's box. */
export function graphGeometry(g: GraphLayout): string[] {
  const problems: string[] = []; const box = new Map(g.nodes.map((n) => [n.id, n]));
  const on = (p: { x: number; y: number }, id: string) => { const b = box.get(id); if (!b) return false; const s = 2; return p.x >= b.x - s && p.x <= b.x + b.w + s && p.y >= b.y - s && p.y <= b.y + b.h + s && (Math.abs(p.x - b.x) <= s || Math.abs(p.x - b.x - b.w) <= s || Math.abs(p.y - b.y) <= s || Math.abs(p.y - b.y - b.h) <= s); };
  for (const e of g.edges) {
    const a = e.points[0], z = e.points[e.points.length - 1];
    if (e.points.length < 2 || !on(a, e.from) || !on(z, e.to)) problems.push(`the line ${e.from} → ${e.to} does not run from its step's box to its step's box`);
  }
  return problems;
}
