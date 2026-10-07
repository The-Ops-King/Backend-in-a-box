import type { Definition } from "@/engine/definition";
import { walkOrder } from "@/engine/describe";

/** Every message this workflow can send, in full, exactly as written. Placeholders stay visible so you can see what gets filled in. */
export function CopyPanel({ def }: { def: Definition }) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const rows = walkOrder(def).map((id) => byId.get(id)!).filter((n) => ["send_sms", "send_email", "slack_post", "note", "create_task"].includes(n.type));
  if (!rows.length) return <div className="empty">This workflow sends nothing.</div>;
  const show = (t: string) => t.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|\s*default:([^|}]*))?[^}]*\}\}/g, (_, p, d) => `⟨${p}${d !== undefined ? ` or "${d.trim()}"` : ""}⟩`).trim();
  return <div style={{ display: "grid", gap: 10 }}>{rows.map((n) => {
    const label = n.type === "send_sms" ? `Text${n.kind === "transactional" ? " · automated receipt" : ""}` : n.type === "send_email" ? `Email${n.kind === "transactional" ? " · automated receipt" : ""}` : n.type === "slack_post" ? "Slack post" : n.type === "note" ? "Internal note on the contact" : "Task";
    const text = n.type === "send_email" ? `Subject: ${show(n.subject)}\n\n${show(n.template)}` : n.type === "create_task" ? `${show(n.title)}${n.body ? `\n${show(n.body)}` : ""}` : n.type === "send_sms" || n.type === "slack_post" || n.type === "note" ? show(n.template) : "";
    return <div key={n.id} className="card"><div style={{ display: "flex", gap: 10, alignItems: "baseline" }}><span className="badge b-type">{label}</span><span className="mono muted">{n.id}</span>{"substitute_template" in n && n.substitute_template ? <span className="muted">· has a fallback version</span> : null}</div>
      <pre className="copy">{text}</pre>
      {"substitute_template" in n && n.substitute_template ? <><div className="muted" style={{ fontSize: 13, marginTop: 8 }}>Fallback, when the timing no longer fits:</div><pre className="copy">{show(n.substitute_template)}</pre></> : null}</div>; })}</div>;
}
