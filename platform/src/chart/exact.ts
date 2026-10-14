import type { Chart } from "@/api/words";
import { arrange, drawable, labelOf, placedIds, whenOf, type Row } from "./arrange";
import type { GraphLayout } from "./graph";

/**
 * D111: is a drawing exactly the workflow? A drawing is what the page puts in front of Tyler: the boxes, and the lines
 * between them with the words on each. It is exact when every step that runs is drawn exactly once, every line drawn
 * is a real way the run can go (from that step, to that step, with that way's words and its otherwise-ness), every
 * real way is drawn, and nothing else is. The same check runs in the dashboard (which layout to draw), on save (which
 * layout a workflow gets; refused when neither) and in the daily health sweep.
 */
export type Line = { from: string; to: string; label: string; else: boolean };
export type Drawing = { nodes: string[]; lines: Line[]; problems?: string[] };
export type Exactness = { exact: boolean; problems: string[] };

const norm = (l: string) => labelOf(l).trim().toLowerCase();
const key = (l: Line) => `${l.from} → ${l.to}${l.label ? ` “${norm(l.label)}”` : ""}${l.else ? " (otherwise)" : ""}`;
const count = (keys: string[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());

/** The real thing: every step that can run and every edge, with its words. */
export function realOf(chart: Chart): Drawing {
  return { nodes: drawable(chart), lines: chart.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, else: !!e.else })) };
}

export function exactness(chart: Chart, drawing: Drawing): Exactness {
  const problems = [...(drawing.problems ?? [])];
  const real = realOf(chart); const title = new Map(chart.nodes.map((n) => [n.id, `“${n.title}” (${n.id})`]));
  const name = (id: string) => title.get(id) ?? id;
  const want = new Set(real.nodes); const drawn = count(drawing.nodes);
  for (const id of real.nodes) if (!drawn.has(id)) problems.push(`step ${name(id)} is not drawn`);
  for (const [id, k] of drawn) {
    if (!want.has(id)) problems.push(`${title.has(id) ? `step ${name(id)}` : `a box “${id}”`} is drawn but is not a step that runs`);
    else if (k > 1) problems.push(`step ${name(id)} is drawn ${k} times`);
  }
  const say = (l: Line) => `${name(l.from)} → ${name(l.to)}${l.label ? ` “${l.label}”` : ""}${l.else ? " (otherwise)" : ""}`;
  const r = count(real.lines.map(key)), d = count(drawing.lines.map(key));
  const sample = new Map([...real.lines, ...drawing.lines].map((l) => [key(l), l]));
  for (const [k, n] of r) if ((d.get(k) ?? 0) < n) problems.push(`the way ${say(sample.get(k)!)} is not drawn`);
  for (const [k, n] of d) if ((r.get(k) ?? 0) < n) problems.push(`a line ${say(sample.get(k)!)} is drawn but the workflow has no such way`);
  return { exact: !problems.length, problems };
}

/**
 * What the tidy layout draws, line by line: consecutive steps, a fork to each group's first step (with the group's
 * heading), a group that carries on to the join, an arrow on to a step drawn elsewhere, an entry trigger into the step
 * after it, and a folded branch (the step's condition and the otherwise way round it to where the step goes).
 */
export function tidyDrawing(chart: Chart, rows: Row[]): Drawing {
  const lines: Line[] = []; const problems: string[] = [];
  const kinds = new Map(chart.nodes.map((n) => [n.id, n.kind])); const drawn = new Set(placedIds(rows));
  type Tail = { id: string; label: string; else: boolean };
  const plain = (id: string): Tail => ({ id, label: "", else: false });
  const to = (tails: Tail[], id: string) => { for (const t of tails) lines.push({ from: t.id, to: id, label: t.label, else: t.else }); };
  const lay = (rs: Row[], incoming: Tail[]): Tail[] => {
    let tails = incoming;
    for (const r of rs) {
      if (r.kind === "nodes") {
        const side = r.items.filter((i) => i.n.kind === "trig" && !i.entry);
        if (side.length) tails = side.map((i) => plain(i.id));
        for (const it of r.items) {
          if (it.n.kind === "trig" && !it.entry) continue;
          if (it.entry) { tails = [...tails, plain(it.id)]; continue; }
          if (it.fold) {
            // the condition the step shows must be the branch's, and the branch must be one
            if (kinds.get(it.fold.fork) !== "fork" || it.when !== whenOf(it.fold.yes)) problems.push(`the condition on “${it.n.title}” is not the branch's`);
            to(tails, it.fold.fork); lines.push({ from: it.fold.fork, to: it.id, label: it.fold.yes, else: false });
            tails = [plain(it.id), { id: it.fold.fork, label: it.fold.no, else: true }];
          } else { to(tails, it.id); tails = [{ id: it.id, label: it.next?.label ?? "", else: !!it.next?.else }]; }
          for (const x of it.exits ?? []) lines.push({ from: it.id, to: x.id, label: x.label, else: x.else });
        }
      } else if (r.kind === "on") {
        // the arrow names its step by its title: a title two steps share does not say which one the run goes on to
        const same = chart.nodes.filter((n) => n.id !== r.to && n.title === r.title && drawn.has(n.id)).length;
        if (same) problems.push(`an arrow says “on to ${r.title}”, and ${same + 1} steps are called that`);
        to(tails, r.to); tails = [];
      }
      else if (r.kind === "fork") {
        if (r.fork) to(tails, r.fork.id);
        const next: Tail[] = [];
        for (const g of r.groups) {
          const from = r.fork ? [{ id: r.fork.id, label: g.label, else: !!g.else }] : [];
          const t = g.rows.length ? lay(g.rows, from) : from;
          if (g.go) next.push(...t);
        }
        tails = next;
      } else {
        problems.push(r.linked ? `${r.items.length} steps are listed in order, not drawn as branches (nested too deep)` : `${r.items.length} step${r.items.length === 1 ? " is" : "s are"} listed apart: the layout does not reach ${r.items.length === 1 ? "it" : "them"}`);
        tails = [];
      }
    }
    return tails;
  };
  lay(rows, []);
  return { nodes: placedIds(rows), lines, problems };
}

/**
 * What the plain graph draws: one box per laid-out node, one line per laid-out edge with its words. Each line must start
 * on its own step's box and end on its own step's box, so a line the library routed elsewhere is not passed as right.
 */
export function graphDrawing(g: GraphLayout): Drawing {
  const problems: string[] = []; const box = new Map(g.nodes.map((n) => [n.id, n]));
  const on = (p: { x: number; y: number }, id: string) => { const b = box.get(id); if (!b) return false; const s = 2; return p.x >= b.x - s && p.x <= b.x + b.w + s && p.y >= b.y - s && p.y <= b.y + b.h + s && (Math.abs(p.x - b.x) <= s || Math.abs(p.x - b.x - b.w) <= s || Math.abs(p.y - b.y) <= s || Math.abs(p.y - b.y - b.h) <= s); };
  for (const e of g.edges) {
    const a = e.points[0], z = e.points[e.points.length - 1];
    if (e.points.length < 2 || !on(a, e.from) || !on(z, e.to)) problems.push(`the line ${e.from} → ${e.to} does not run from its step's box to its step's box`);
  }
  return { nodes: g.nodes.map((n) => n.id), lines: g.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, else: e.else })), problems };
}

export type TidyPick = { layout: "tidy"; rows: Row[]; tidy: Exactness };
/** The tidy layout and whether it is exact: the first resort, synchronous (the graph layout is not). */
export function tidyOf(chart: Chart): TidyPick {
  const rows = arrange(chart);
  return { layout: "tidy", rows, tidy: exactness(chart, tidyDrawing(chart, rows)) };
}
