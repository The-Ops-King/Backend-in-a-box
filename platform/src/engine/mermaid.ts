import type { Definition, Edge, Node } from "./definition";
import { describeNode, edgeWords, exitWords, kindOf, type NodeKind } from "./describe";

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
function label(n: Node): string {
  const d = describeNode(n);
  return d.quote ? `${esc(d.title)}<br/><i>${esc(trunc(d.quote, 60))}</i>` : esc(trunc(d.title, 70));
}
const edgeLabel = (e: Edge) => esc(edgeWords(e));

/** Fills by kind (dark theme). Strokes by run status. */
export const KIND_FILL: Record<NodeKind, { fill: string; stroke: string }> = {
  trigger: { fill: "#1e3a2c", stroke: "#5e9e78" }, message: { fill: "#1b2a3d", stroke: "#6f9bd6" }, crm: { fill: "#3a2d1b", stroke: "#d6a35b" },
  decision: { fill: "#2a2a30", stroke: "#a6a3b8" }, wait: { fill: "#1c1b19", stroke: "#8a857c" }, ai: { fill: "#2f1f3d", stroke: "#b48ad9" }, control: { fill: "#1c1b19", stroke: "#8a857c" }, exit: { fill: "#141312", stroke: "#5e5a54" },
};
export const STATUS_STROKE: Record<string, string> = { ok: "#5e9e78", waiting: "#6f9bd6", failed: "#d9686a", stale: "#d6a35b", skipped: "#d6a35b", here: "#f5f3ee" };

/** Mermaid flowchart for a definition; with steps, strokes show what happened and the current node is outlined. */
export function toMermaid(def: Definition, steps: Step[] = [], currentNode?: string | null): string {
  const lines = ["flowchart TD"];
  for (const n of def.nodes) lines.push(`  ${n.id}${shape(n, label(n))}`);
  for (const e of def.edges) { const l = edgeLabel(e); lines.push(l ? `  ${e.from} -->|${l}| ${e.to}` : `  ${e.from} --> ${e.to}`); }
  // a check's "if not" path is an exit reason, not an edge; draw it dashed to the matching exit so nothing floats unexplained
  const synthetic: string[] = [];
  for (const n of def.nodes) if (n.type === "check") {
    const x = def.nodes.find((m) => m.type === "exit" && m.reason === n.else_exit);
    const target = x ? x.id : `${n.id}_else`;
    if (!x) { lines.push(`  ${target}((("${esc(exitWords(n.else_exit))}")))`); synthetic.push(target); }
    lines.push(`  ${n.id} -.->|if not| ${target}`);
  }
  for (const [k, c] of Object.entries(KIND_FILL)) lines.push(`  classDef k_${k} fill:${c.fill},stroke:${c.stroke},color:#f5f3ee,stroke-width:1.5px`);
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
