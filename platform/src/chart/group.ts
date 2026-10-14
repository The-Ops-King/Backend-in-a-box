import type { Chart, ChartNode, StepState } from "@/api/words";

/**
 * D114: a straight run of steps that only keep values (set_var) or read the engine's own ledger (lookup) is drawn as one
 * grey box that says what the run is for. Nothing else is grouped: a wait changes when things happen, Jev's read decides
 * a fork, and every other step touches the outside world. A run is a chain the definition really has: each step's one
 * way out is a plain way to the next, and each step after the first has that as its one way in, so nothing can join or
 * leave it part way (an implicit way out, implicit.ts, is a second way out). exact.ts holds the drawing to the same rule.
 */
const cache = new WeakMap<Chart, Chart>();

/** The runs to draw as one box, each its step ids in order, two or more. */
export function helperRuns(chart: Chart): string[][] {
  const byId = new Map(chart.nodes.map((n) => [n.id, n]));
  const outs = (id: string) => chart.edges.filter((e) => e.from === id);
  const ins = (id: string) => chart.edges.filter((e) => e.to === id);
  const plumb = (id: string) => !!byId.get(id)?.plumb;
  const link = (a: string): string | null => {
    const o = outs(a); if (!plumb(a) || o.length !== 1 || o[0].label || o[0].else) return null;
    const b = o[0].to; return b !== a && plumb(b) && ins(b).length === 1 ? b : null;
  };
  const runs: string[][] = []; const used = new Set<string>();
  for (const n of chart.nodes) {
    if (!n.plumb || used.has(n.id)) continue;
    const i = ins(n.id); if (i.length === 1 && link(i[0].from) === n.id) continue;   // not the start of its run
    const run = [n.id]; let cur = link(n.id);
    while (cur && !run.includes(cur)) { run.push(cur); cur = link(cur); }
    if (run.length > 1) { runs.push(run); run.forEach((id) => used.add(id)); }
  }
  return runs;
}

const join = (xs: string[]) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
// "the setter line, booking kind and booking source"; two stay whole ("the parts and the recording line")
const unThe = (xs: string[]) => xs.length > 2 && xs.every((x) => x.startsWith("the ")) ? xs.map((x, i) => (i ? x.slice(4) : x)) : xs;

/**
 * A run's words, made from what its steps keep: "Prepare the alert's words (7 steps)" when most of them belong to one
 * thing, its parts listed under it; else "Remember the setter line, booking kind and booking source (3 steps)".
 */
export function groupWords(members: ChartNode[], tell: { way?: string; nth?: string } = {}): { title: string; meta?: string } {
  const seen = new Set<string>(); const parts = members.flatMap((m) => { const k = `${m.plumb!.verb}|${m.plumb!.what}`; if (seen.has(k)) return []; seen.add(k); return [m.plumb!]; });
  const steps = `${tell.way ?? ""} (${tell.nth ? `${tell.nth} time, ` : ""}${members.length} steps)`;
  const sometimes = members.filter((m) => m.onlyIf).length;
  const extra = sometimes ? `${sometimes === members.length ? "all" : sometimes} only sometimes` : "";
  const kept = parts.filter((p) => p.verb === "remember"); const looked = parts.filter((p) => p.verb === "look up");
  // most of what it keeps belongs to one thing ("the alert's mark", "the alert's face"): it prepares that thing
  const owned = kept.map((p) => /^(the [^']+?'s) (.+)$/.exec(p.what));
  const owners = new Map<string, number>(); for (const o of owned) if (o) owners.set(o[1], (owners.get(o[1]) ?? 0) + 1);
  const [owner, many] = [...owners].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  if (!looked.length && many >= 2 && many * 2 >= kept.length) {
    const its = owned.filter((o) => o?.[1] === owner).map((o) => o![2]);
    const rest = kept.filter((_, i) => owned[i]?.[1] !== owner).map((p) => p.what);
    const all = members.every((m) => m.plumb!.text);
    return { title: `Prepare ${owner} ${all ? "words" : "details"}${steps}`, meta: [`its ${join(its)}`, ...rest, extra].filter(Boolean).join("; ") };
  }
  const say = (ps: typeof parts, most: number) => { const w = unThe(ps.map((p) => p.what)); return w.length > most ? `${w.slice(0, most - 1).join(", ")} and ${w.length - most + 1} more` : join(w); };
  const said = [looked.length && `Look up ${say(looked, 3)}`, kept.length && `${looked.length ? "remember" : "Remember"} ${say(kept, 4)}`].filter(Boolean).join(", then ");
  const cut = looked.length > 3 || kept.length > 4;
  return { title: `${said}${steps}`, meta: [cut && join(parts.map((p) => `${p.verb === "look up" ? "looks up " : ""}${p.what}`)), extra].filter(Boolean).join("; ") || undefined };
}

/** The chart as drawn (D114): each run of plumbing steps one helper node, the first step's id, `group` its steps in order. */
export function grouped(chart: Chart): Chart {
  const had = cache.get(chart); if (had) return had;
  const runs = helperRuns(chart);
  if (!runs.length) { cache.set(chart, chart); return chart; }
  const byId = new Map(chart.nodes.map((n) => [n.id, n]));
  const head = new Map(runs.map((r) => [r[0], r])); const inside = new Set(runs.flatMap((r) => r.slice(1)));
  const lastOf = new Map(runs.map((r) => [r[r.length - 1], r[0]]));
  const titles = new Set(chart.nodes.filter((n) => !inside.has(n.id) && !head.has(n.id)).map((n) => n.title));
  const plain = runs.map((r) => groupWords(r.map((id) => byId.get(id)!)).title);
  const dup = new Set(plain.filter((t, i) => titles.has(t) || plain.indexOf(t) !== i || plain.lastIndexOf(t) !== i));
  const nodes = chart.nodes.filter((n) => !inside.has(n.id)).map((n): ChartNode => {
    const r = head.get(n.id); if (!r) return n;
    const ms = r.map((id) => byId.get(id)!);
    // an arrow "on to …" names a step by its words: two boxes never read the same; told apart by the way into them, else counted
    const wayIn = chart.edges.filter((e) => e.to === n.id); const l = wayIn.length === 1 ? wayIn[0].label : ""; const way = l ? `, ${l === "otherwise" ? "otherwise" : `when ${l.replace(/^./, (c) => c.toLowerCase())}`}` : undefined;
    let w = groupWords(ms); if (dup.has(w.title) && way) w = groupWords(ms, { way });
    for (let k = 2; titles.has(w.title); k++) w = groupWords(ms, { way: dup.has(groupWords(ms).title) ? way : undefined, nth: k === 2 ? "2nd" : k === 3 ? "3rd" : `${k}th` });
    titles.add(w.title);
    return { id: n.id, kind: "other", title: w.title, ...(w.meta ? { meta: w.meta } : {}), detail: `Behind the scenes: these steps only ${ms.some((m) => m.plumb!.verb === "look up") ? "look things up in the engine's own records and keep values" : "keep values"} for the steps after them. Nothing is sent, written or waited for.`, helper: true, logo: "engine", group: r };
  });
  const edges = chart.edges.filter((e) => !inside.has(e.to)).map((e) => (lastOf.has(e.from) ? { ...e, from: lastOf.get(e.from)! } : e));
  const out: Chart = { ...chart, nodes, edges }; cache.set(chart, out); cache.set(out, out); return out;
}

/** The step a way out of a drawn node really leaves from: a box's last step. */
export const leaves = (n: ChartNode | undefined, id: string) => n?.group ? n.group[n.group.length - 1] : id;

/**
 * A box's state on a run, from its steps': all ran (some skipped, said), or where the run is or stopped among them.
 * words: what the box's pill says when "ran" is not the whole story.
 */
export function groupState(states: (StepState | null)[]): { st: StepState | null; words?: string } {
  if (states.every((s) => s === null)) return { st: null };
  const s = states.map((x) => x ?? "next"); const k = s.length;
  const at = (st: StepState) => s.indexOf(st);
  for (const [st, verb] of [["warn", "failed at"], ["here", "waiting at"], ["stop", "stopped at"]] as const) if (at(st) >= 0) return { st, words: `${verb} step ${at(st) + 1} of ${k}` };
  if (s.every((x) => x === "next")) return { st: "next" };
  const done = s.filter((x) => x !== "next").length; const skipped = s.filter((x) => x === "skip" || x === "blocked").length;
  if (done < k) return { st: "stop", words: `${done} of ${k} reached` };
  if (skipped === k) return { st: "skip", words: `all ${k} skipped` };
  const st: StepState = s.includes("ghost") ? "ghost" : "ok";
  return skipped ? { st, words: `${k - skipped} ran · ${skipped} skipped` } : { st };
}

const STEP_STATE: Record<StepState, string> = { ok: "ran", ghost: "ran in shadow", here: "waiting here", warn: "failed", skip: "skipped: its condition was not met", blocked: "blocked", next: "not reached", stop: "stopped" };
export type GroupStep = { id: string; title: string; meta?: string; label?: string; cond?: string; went?: string; state?: StepState; stateWords?: string };
/**
 * A box's popover (D114): what it is for, then every step inside in order with its full words, its condition, and how
 * many went through it lately (no run) or its state on the run. Null when the id is not a box.
 */
export function groupPopover(chart: Chart, id: string, states?: Record<string, StepState>): { title: string; meta?: string; detail?: string; steps: GroupStep[]; days?: number; summary?: { st: StepState; words: string } } | null {
  const box = grouped(chart).nodes.find((n) => n.id === id && n.group); if (!box) return null;
  const byId = new Map(chart.nodes.map((n) => [n.id, n]));
  const stOf = (m: string): StepState | null => (states ? states[m] ?? "next" : null);
  const steps = box.group!.map((m): GroupStep => {
    const n = byId.get(m)!; const st = stOf(m); const c = !states && chart.counts ? chart.counts.by[m] ?? { went: 0, skipped: 0 } : null;
    return { id: m, title: n.title, ...(n.meta ? { meta: n.meta } : {}), ...(n.label ? { label: n.label } : {}), ...(n.cond ? { cond: n.onlyIf ? `${n.cond}. Otherwise it is skipped and the run goes on.` : n.cond } : {}),
      ...(c ? { went: c.went ? `${c.went} went through${c.skipped ? `, ${c.skipped} skipped` : ""}` : "nobody lately" } : {}), ...(st ? { state: st, stateWords: STEP_STATE[st] } : {}) };
  });
  const sum = states ? groupState(box.group!.map(stOf)) : null;
  const words = sum?.st ? (sum.words ?? (sum.st === "next" ? "not reached" : sum.st === "skip" ? "all skipped" : "all ran")) : "";
  return { title: box.title, ...(box.meta ? { meta: box.meta } : {}), detail: box.detail, steps, ...(!states && chart.counts ? { days: chart.counts.days } : {}), ...(sum?.st ? { summary: { st: sum.st, words: words.replace(/^./, (c) => c.toUpperCase()) } } : {}) };
}
