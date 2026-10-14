import type { Chart } from "@/api/words";
import { grouped } from "./group";

/**
 * The chart's tidy layout as data (D107), apart from the drawing so it is tested without a browser and checked on the
 * server (D111): one spine of rows, each a straight run of nodes or a fork with its labelled groups, and a group's content
 * is itself rows, so a fork inside a branch draws its own groups inside that branch. Every step is its own node (D111:
 * nothing hidden, nothing folded but a two-way branch around one step). Whether the result is exact is exact.ts's call;
 * a workflow it cannot draw exactly is drawn as a plain graph instead. A run of value-keeping steps is one node (D114).
 */
type N = Chart["nodes"][number];
/**
 * cond: the blue mark (a step that may not fire); when: a sometimes-step's short condition, drawn dashed with that line
 * (D103); fold: a two-way branch drawn as this step's condition, its other way the "otherwise" around the step (raw
 * edge labels, so the check can hold the drawing to them); entry: a trigger that starts the run here, part way down;
 * exits: ways out of this step that end the run at once (a check's "otherwise" stop), drawn as short lines off to the side;
 * next: the words on this step's one way on, when it has some (a resume's "back to the step the run was on").
 */
export type Item = { id: string; n: N; cond?: string; when?: string; fold?: { fork: string; yes: string; no: string }; entry?: boolean; exits?: { id: string; n: N; label: string; else: boolean }[]; next?: { label: string; else: boolean } };
/** go: carries on to the fork's join; bare: one of a workflow's separate starts (no card, no label); else: the branch's otherwise way. */
export type Group = { label: string; rows: Row[]; go: boolean; first: string | null; bare?: boolean; else?: boolean };
export type Row =
  | { kind: "nodes"; items: Item[] }
  /** fork null: triggers that start in different places, each start a bare group, joining where their paths meet */
  | { kind: "fork"; fork: Item | null; groups: Group[] }
  /** the flow goes on at a step drawn elsewhere (another branch's step, a step past the join, a loop back) */
  | { kind: "on"; to: string; title: string }
  /** steps listed in order rather than drawn as branches: nested too deep, or not reached by the walk (never exact) */
  | { kind: "more"; label: string; items: Item[]; linked: boolean };

const MAX_DEPTH = 4;
/** A group's heading as drawn: "the reply is a cancel" → "Cancel". */
export const labelOf = (l: string) => l.replace(/^the reply is (a )?/i, "").replace(/[“”"]/g, "").replace(/^./, (ch) => ch.toUpperCase());
/** A folded branch's condition as the step's blue line shows it: "this is a reschedule" → "a reschedule". */
export const whenOf = (l: string) => l.replace(/^this is not /, "not ").replace(/^this is /, "");

export function arrange(real: Chart): Row[] {
  const chart = grouped(real);
  const byId = new Map(chart.nodes.map((n) => [n.id, n]));
  const outs = (id: string) => chart.edges.filter((e) => e.from === id);
  const ins = (id: string) => chart.edges.filter((e) => e.to === id);
  const nexts = (id: string) => [...new Set(outs(id).map((e) => e.to))];
  const seen = new Set<string>();

  const item = (id: string): Item => {
    const n = byId.get(id)!; const it: Item = { id, n };
    if (n.cond && (n.kind === "send" || n.onlyIf)) it.cond = n.cond;
    if (n.onlyIf) it.when = n.onlyIf;
    return it;
  };
  /**
   * A branch that only decides whether one step runs: one "when" way to that step, the plain otherwise way to where the
   * step goes. Drawn as the step with the condition on it (D103's look); folded only when that drawing says everything:
   * the step is reached from nowhere else, has no condition of its own, and the otherwise way carries no words of its own.
   */
  const condOf = (forkId: string): { step: N; fold: NonNullable<Item["fold"]>; next: string } | null => {
    const f = byId.get(forkId); if (!f || f.kind !== "fork") return null;
    const fo = outs(forkId); if (fo.length !== 2 || !fo.some((e) => e.else) || !fo.some((e) => !e.else)) return null;
    const yes = fo.find((e) => !e.else)!, no = fo.find((e) => e.else)!; const step = byId.get(yes.to);
    if (!step || seen.has(step.id) || step.id === no.to || step.onlyIf || ["trig", "fork", "end"].includes(step.kind)) return null;
    if (no.label !== "otherwise" || !yes.label || ins(step.id).length !== 1) return null;
    const so = outs(step.id); if (so.length !== 1 || so[0].to !== no.to || so[0].label) return null;
    return { step, fold: { fork: forkId, yes: yes.label, no: no.label }, next: no.to };
  };
  /** Every node reachable from `from` (itself included) with its distance, not going past a stop node or a placed one. */
  const reach = (from: string, stop: Set<string>): Map<string, number> => {
    const d = new Map<string, number>([[from, 0]]); const q = [from];
    while (q.length) { const id = q.shift()!; if (stop.has(id) || seen.has(id)) continue; for (const nx of nexts(id)) if (!d.has(nx)) { d.set(nx, d.get(id)! + 1); q.push(nx); } }
    return d;
  };
  const below = (id: string) => { const r = reach(id, new Set()); r.delete(id); return r; };
  /**
   * Where a fork's ways meet again: of the nodes the most ways reach, the first (no other such node leads to it).
   * Counting ways first keeps a cross-link (the team's ✅ going to the confirmed steps) from passing for the join. When
   * no two ways meet inside, the enclosing fork's join, if a way gets there.
   */
  const joinOf = (starts: string[], stop: Set<string>): string | null => {
    const R = starts.map((s) => reach(s, stop));
    const pick = (ids: string[]) => {
      const sc = ids.map((id) => ({ id, count: R.filter((r) => r.has(id)).length, dist: R.reduce((a, r) => a + (r.get(id) ?? 0), 0) }));
      const top = Math.max(...sc.map((s) => s.count)); const best = sc.filter((s) => s.count === top);
      const first = best.filter((s) => !best.some((o) => o.id !== s.id && below(o.id).has(s.id)));
      return (first.length ? first : best).sort((a, b) => a.dist - b.dist)[0]?.id ?? null;
    };
    const all = [...new Set(R.flatMap((r) => [...r.keys()]))];
    const inner = all.filter((id) => !stop.has(id) && !seen.has(id) && R.filter((r) => r.has(id)).length > 1);
    if (inner.length) return pick(inner);
    const outer = all.filter((id) => stop.has(id));
    return outer.length ? pick(outer) : null;
  };

  /** A fork's groups, each walked to the join; past the depth limit, its steps listed in order instead. */
  function forkRow(fork: Item | null, ways: { label: string; to: string; else?: boolean; lead?: Item[] }[], stop: Set<string>, depth: number): { row: Row; join: string | null } {
    const join = joinOf(ways.map((w) => w.to), stop);
    if (depth >= MAX_DEPTH) {
      const list: Item[] = fork ? [fork] : []; const halt = new Set([...stop, ...(join ? [join] : [])]);
      for (const w of ways) { list.push(...(w.lead ?? [])); for (const id of reach(w.to, halt).keys()) if (!seen.has(id) && !halt.has(id)) { seen.add(id); list.push(item(id)); } }
      return { row: { kind: "more", label: "Too deep to draw as branches: its steps in order", items: list, linked: true }, join };
    }
    const inner = new Set(stop); if (join) { inner.add(join); for (const id of below(join).keys()) inner.add(id); }
    const groups: Group[] = ways.map((w) => {
      const { rows, end } = walk(w.to, inner, depth + 1);
      if (w.lead) rows.unshift({ kind: "nodes", items: w.lead });
      // left the group somewhere other than the join: say where it goes on
      if (end && end !== join) rows.push({ kind: "on", to: end, title: byId.get(end)?.title ?? end });
      const head = rows.find((r) => r.kind === "nodes" || r.kind === "fork");
      const first = !head ? null : head.kind === "nodes" ? head.items[0].id : head.kind === "fork" ? head.fork?.id ?? null : null;
      return { label: fork ? labelOf(w.label) : "", rows, go: !!join && end === join, first, ...(fork ? {} : { bare: true }), ...(w.else ? { else: true } : {}) };
    });
    return { row: { kind: "fork", fork, groups }, join };
  }

  /** The rows from `start` until a stop node (returned as `end`), an end, or a step already drawn. */
  function walk(start: string | null, stop: Set<string>, depth: number): { rows: Row[]; end: string | null } {
    const rows: Row[] = []; let line: Item[] = [];
    const flush = () => { if (line.length) { rows.push({ kind: "nodes", items: line }); line = []; } };
    let cur = start;
    for (let guard = 0; cur && guard < 400; guard++) {
      if (stop.has(cur)) { flush(); return { rows, end: cur }; }
      if (seen.has(cur)) { flush(); rows.push({ kind: "on", to: cur, title: byId.get(cur)?.title ?? cur }); return { rows, end: null }; }
      const n = byId.get(cur); if (!n) break;
      const ent = entries.get(cur); if (ent) { entries.delete(cur); line.push(...ent); }
      seen.add(cur);
      const o = outs(cur);
      if (n.kind === "fork") { const c = condOf(cur); if (c && !stop.has(c.step.id)) { seen.add(c.step.id); line.push({ ...item(c.step.id), cond: `Only when ${c.fold.yes}`, when: whenOf(c.fold.yes), fold: c.fold }); cur = c.next; continue; } }
      // a step whose other ways only end the run (a check that otherwise stops) keeps its place in the line; those ends hang off its side
      if (o.length > 1) {
        const dead = o.filter((e) => { const t = byId.get(e.to); return !!t && t.kind === "end" && !outs(t.id).length && ins(t.id).length === 1 && !seen.has(t.id) && !stop.has(t.id); });
        const live = o.filter((e) => !dead.includes(e));
        if (dead.length && live.length === 1 && !live[0].label) {
          for (const e of dead) seen.add(e.to);
          line.push({ ...item(cur), exits: dead.map((e) => ({ id: e.to, n: byId.get(e.to)!, label: e.label, else: !!e.else })) }); cur = live[0].to; continue;
        }
      }
      if (o.length > 1) {
        flush();
        const r = forkRow(item(cur), o.map((e) => ({ label: e.label, to: e.to, ...(e.else ? { else: true } : {}) })), stop, depth); rows.push(r.row); cur = r.join; continue;
      }
      line.push(o.length === 1 && (o[0].label || o[0].else) ? { ...item(cur), next: { label: o[0].label, else: !!o[0].else } } : item(cur));
      cur = o[0]?.to ?? null;
    }
    flush(); return { rows, end: null };
  }

  // the starts: triggers that share a first step sit side by side over it; a trigger whose first step another start
  // reaches anyway is drawn where it comes in; starts that only meet further down (or never) are bare groups side by side
  const entries = new Map<string, Item[]>();
  const byFirst = new Map<string, Item[]>();
  for (const t of chart.nodes.filter((n) => n.kind === "trig")) { seen.add(t.id); const f = outs(t.id)[0]?.to ?? ""; byFirst.set(f, [...(byFirst.get(f) ?? []), { id: t.id, n: t }]); }
  const firsts = [...byFirst.keys()].filter((f) => byId.has(f));
  const roots = firsts.filter((f) => !firsts.some((g) => g !== f && below(g).has(f)));
  for (const f of firsts) if (!roots.includes(f)) entries.set(f, byFirst.get(f)!.map((t) => ({ ...t, entry: true })));
  const lead = [...byFirst.entries()].filter(([f]) => !byId.has(f)).flatMap(([, ts]) => ts);
  const rows: Row[] = [];
  if (roots.length <= 1) {
    const top = [...lead, ...(roots.length ? byFirst.get(roots[0])! : [])];
    if (top.length) rows.push({ kind: "nodes", items: top });
    if (roots.length) rows.push(...walk(roots[0], new Set(), 0).rows);
  } else {
    if (lead.length) rows.push({ kind: "nodes", items: lead });
    const r = forkRow(null, roots.map((f) => ({ label: "", to: f, lead: byFirst.get(f)! })), new Set(), 0);
    rows.push(r.row);
    if (r.join) rows.push(...walk(r.join, new Set(), 0).rows);
  }

  // nothing is dropped silently: a step the walk did not reach is listed at the bottom (and the chart is drawn as a graph)
  const placed = new Set(placedIds(rows));
  const left = drawable(chart).filter((id) => !placed.has(id));
  if (left.length) rows.push({ kind: "more", label: "More steps (not placed on the chart)", items: left.map((id) => item(id)), linked: false });
  return rows;
}

/** The ids a layout placed, a folded branch with the step it is drawn as, a box with its steps. */
export function placedIds(rows: Row[]): string[] {
  const out: string[] = []; const put = (it: Item) => out.push(...(it.fold ? [it.fold.fork] : []), ...(it.n.group ?? [it.id]), ...(it.exits ?? []).map((x) => x.id));
  for (const r of rows) {
    if (r.kind === "nodes" || r.kind === "more") r.items.forEach(put);
    else if (r.kind === "fork") { if (r.fork) put(r.fork); for (const g of r.groups) out.push(...placedIds(g.rows)); }
  }
  return out;
}
/**
 * The nodes a chart draws: every one, except an exit no edge touches. That exit is never run: a check's else_exit stops
 * the run itself, and the check's words say so (Daily EOD reminder's "nothing to file" is one).
 */
export function drawable(chart: Chart): string[] {
  return chart.nodes.filter((n) => !(n.kind === "end" && !chart.edges.some((e) => e.to === n.id || e.from === n.id))).map((n) => n.id);
}
