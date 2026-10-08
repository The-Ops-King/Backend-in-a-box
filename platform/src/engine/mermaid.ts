import type { Definition, Edge, Node } from "./definition";
import { branchTitle, describeNode, edgeWords, exitWords, kindOf, type NodeKind, collapsePlumbing } from "./describe";

type Step = { node_id: string; status: string };
const esc = (s: string) => s.replace(/"/g, "'").replace(/[<>]/g, "").replace(/\n/g, " ");
const trunc = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * One shape per kind, always:
 *   trigger ([pill])   decision {diamond}   wait [[double bar]]   exit (((double circle)))   everything else [box]
 * Fill color says what kind of step it is; stroke says what happened to it in this run (see legend in Mermaid.tsx).
 */
function shape(n: Node, text: string): string {
  const t = `"${text}"`;
  switch (kindOf(n)) {
    case "trigger": return `([${t}])`;
    case "decision": return `{${t}}`;
    case "wait": return `[[${t}]]`;
    case "exit": return `(((${t})))`;
    default: return `[${t}]`;
  }
}
/** Word-wrap at ~24 characters so a box never clips its words (the chart's font is wider than the one mermaid measures with). */
const wrap = (s: string, width = 24): string => { const out: string[] = []; let cur = ""; for (const w of s.split(/\s+/)) { if (cur && (cur + " " + w).length > width) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w; } if (cur) out.push(cur); return out.join("<br/>"); };
function label(def: Definition, n: Node): string {
  const d = n.type === "branch" ? { title: branchTitle(def, n.id) } : describeNode(n);
  return d.quote ? `${wrap(esc(d.title))}<br/>${wrap(esc(trunc(d.quote.replace(/[*_~]/g, ""), 60)))}` : wrap(esc(trunc(d.title, 70)));   // Slack's *bold* marks would read as markdown in the chart
}
const edgeLabel = (e: Edge) => esc(edgeWords(e));

/** Fills by kind (dark theme). Strokes by run status. */
export const KIND_FILL: Record<NodeKind, { fill: string; stroke: string }> = {
  trigger: { fill: "#1f4433", stroke: "#8fd1a6" }, message: { fill: "#1c3049", stroke: "#a9c6ee" }, crm: { fill: "#45341c", stroke: "#efc98a" },
  decision: { fill: "#302f38", stroke: "#c9c6d8" }, wait: { fill: "#222120", stroke: "#b3ada3" }, ai: { fill: "#372347", stroke: "#d6bbf2" }, control: { fill: "#222120", stroke: "#b3ada3" }, exit: { fill: "#1a1917", stroke: "#8f8a81" },
};
export const STATUS_STROKE: Record<string, string> = { ok: "#7cc094", waiting: "#8db4e8", failed: "#ee7f81", stale: "#e6b76e", skipped: "#e6b76e", here: "#ffffff" };

/** Mermaid flowchart for a definition; with steps, strokes show what happened and the current node is outlined. */
export function toMermaid(def: Definition, steps: Step[] = [], currentNode?: string | null): string {
  const lines = ["flowchart TD"];
  def = collapsePlumbing(def);   // no "Remember …" boxes: the chart shows what happens, not how copy is assembled
  // "Done" is implied, as in the outline: a plain done-exit and the edges into it are not drawn; a stop with a reason is
  const doneExits = new Set(def.nodes.filter((n) => n.type === "exit" && exitWords(n.reason).startsWith("Done")).map((n) => n.id));
  def = { ...def, nodes: def.nodes.filter((n) => !doneExits.has(n.id)), edges: def.edges.filter((e) => !doneExits.has(e.to) && !doneExits.has(e.from)) };
  for (const n of def.nodes) lines.push(`  ${n.id}${shape(n, label(def, n))}`);
  for (const e of def.edges) { const l = edgeLabel(e); lines.push(l ? `  ${e.from} -->|${l}| ${e.to}` : `  ${e.from} --> ${e.to}`); }
  // a check's "if not" path is an exit reason, not an edge; draw it dashed to the matching exit so nothing floats unexplained
  const synthetic: string[] = [];
  for (const n of def.nodes) if (n.type === "check") {
    const x = def.nodes.find((m) => m.type === "exit" && m.reason === n.else_exit);
    const target = x ? x.id : `${n.id}_else`;
    if (!x) { lines.push(`  ${target}((("${esc(exitWords(n.else_exit))}")))`); synthetic.push(target); }
    lines.push(`  ${n.id} -.->|if not| ${target}`);
  }
  for (const [k, c] of Object.entries(KIND_FILL)) lines.push(`  classDef k_${k} fill:${c.fill},stroke:${c.stroke},color:#f7f5f0,stroke-width:2px`);
  lines.push(`  classDef ok stroke:${STATUS_STROKE.ok},stroke-width:3px`);
  lines.push(`  classDef waiting stroke:${STATUS_STROKE.waiting},stroke-width:3px,stroke-dasharray:6 3`);
  lines.push(`  classDef failed stroke:${STATUS_STROKE.failed},stroke-width:3px`);
  lines.push(`  classDef stale stroke:${STATUS_STROKE.stale},stroke-width:3px,stroke-dasharray:2 3`);
  lines.push(`  classDef here stroke:${STATUS_STROKE.here},stroke-width:4px`);
  const byClass: Record<string, string[]> = {};
  for (const n of def.nodes) (byClass[`k_${kindOf(n)}`] ??= []).push(n.id);
  for (const id of synthetic) (byClass.k_exit ??= []).push(id);
  const last = new Map<string, string>(); for (const s of steps) last.set(s.node_id, s.status);
  for (const [id, st] of last) { const k = st === "ok" ? "ok" : st === "waiting" ? "waiting" : st === "failed" ? "failed" : "stale"; (byClass[k] ??= []).push(id); }
  if (currentNode) (byClass.here ??= []).push(currentNode);
  for (const [k, ids] of Object.entries(byClass)) if (ids.length) lines.push(`  class ${[...new Set(ids)].join(",")} ${k}`);
  return lines.join("\n");
}
