import type { Definition, Node, Edge } from "./definition";

type Step = { node_id: string; status: string };
const esc = (s: string) => s.replace(/"/g, "'").replace(/[<>]/g, "").replace(/\{\{\s*|\s*\}\}/g, "").replace(/\n/g, " ").slice(0, 60);
const trunc = (s: string, n = 42) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function label(n: Node): string {
  switch (n.type) {
    case "trigger": return `on ${n.event}`;
    case "wait": return `wait · ${n.rule.offset}${n.rule.guard ? ` (fallback ${n.rule.guard.fallback})` : ""}`;
    case "wait_for_reply": return `wait for reply · up to ${n.timeout}`;
    case "send_sms": return `SMS: ${trunc(esc(n.template))}`;
    case "send_email": return `Email: ${trunc(esc(n.subject))}`;
    case "slack_post": return `Slack: ${trunc(esc(n.template))}`;
    case "classify": return `classify reply (Jev)`;
    case "branch": return "branch";
    case "check": return `check`;
    case "set_tag": return `tag "${n.tag}"`; case "remove_tag": return `untag "${n.tag}"`;
    case "note": return "internal note";
    case "update_appointment": return `appointment → ${Object.values(n.set).join(", ")}`;
    case "update_opportunity": return "update opportunity";
    case "create_opportunity": return `pipeline card: ${trunc(esc(n.name))}`;
    case "set_var": return `set ${n.key}`;
    case "start_workflow": return `start "${n.workflow}"`;
    case "pause_runs": return "pause other runs";
    case "exit": return `exit: ${n.reason}`;
  }
}
function shape(n: Node, text: string): string {
  const t = `"${text}"`;
  switch (n.type) {
    case "trigger": return `([${t}])`;
    case "branch": case "check": return `{${t}}`;
    case "wait": case "wait_for_reply": return `[[${t}]]`;
    case "exit": return `(((${t})))`;
    default: return `[${t}]`;
  }
}
function edgeLabel(e: Edge): string {
  if (e.label) return e.label;
  if (e.else) return "else";
  if (!e.when) return "";
  return esc(JSON.stringify(e.when)).replace(/[{}\[\]"]/g, " ").replace(/\s+/g, " ").replace(/^eq\s*:/, "").trim();
}

/** Mermaid flowchart for a definition; with steps, nodes are colored by what happened and the current node is outlined. */
export function toMermaid(def: Definition, steps: Step[] = [], currentNode?: string | null): string {
  const lines = ["flowchart TD"];
  for (const n of def.nodes) lines.push(`  ${n.id}${shape(n, `${label(n)}`)}`);
  for (const e of def.edges) { const l = edgeLabel(e); lines.push(l ? `  ${e.from} -->|${l}| ${e.to}` : `  ${e.from} --> ${e.to}`); }
  lines.push("  classDef trigger fill:#e6efe9,stroke:#3f7d5c,color:#1f2433");
  lines.push("  classDef exit fill:#f1efe9,stroke:#8e8878,color:#1f2433");
  lines.push("  classDef ok fill:#d9eadf,stroke:#3f7d5c,stroke-width:2px,color:#1f2433");
  lines.push("  classDef waiting fill:#dde3ee,stroke:#4a5570,stroke-width:3px,color:#1f2433");
  lines.push("  classDef stale fill:#f6ebe0,stroke:#9a5b2d,color:#1f2433");
  lines.push("  classDef failed fill:#f6e3e3,stroke:#a63d3d,stroke-width:2px,color:#1f2433");
  lines.push("  classDef here stroke:#101319,stroke-width:4px");
  const byClass: Record<string, string[]> = {};
  for (const n of def.nodes) { const k = n.type === "trigger" ? "trigger" : n.type === "exit" ? "exit" : ""; if (k) (byClass[k] ??= []).push(n.id); }
  const last = new Map<string, string>(); for (const s of steps) last.set(s.node_id, s.status);
  for (const [id, st] of last) { const k = st === "ok" ? "ok" : st === "waiting" ? "waiting" : st === "failed" ? "failed" : "stale"; (byClass[k] ??= []).push(id); }
  if (currentNode) (byClass.here ??= []).push(currentNode);
  for (const [k, ids] of Object.entries(byClass)) if (ids.length) lines.push(`  class ${[...new Set(ids)].join(",")} ${k}`);
  return lines.join("\n");
}
