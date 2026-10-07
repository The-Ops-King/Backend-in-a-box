import type { Definition } from "@/engine/definition";
import { walkOrder } from "@/engine/describe";
import { saveCopyAction } from "./actions";

/**
 * Every message this workflow can send, in full and editable. Saving makes a new version of this company's copy and marks it
 * as edited, so template upgrades leave it alone. Placeholders stay as {{…}} so what gets filled in is visible.
 */
export function CopyPanel({ def, slug, workflowId, saved, error }: { def: Definition; slug: string; workflowId: string; saved?: string; error?: string }) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const rows = walkOrder(def).map((id) => byId.get(id)!).filter((n) => ["send_sms", "send_email", "slack_post", "note", "create_task"].includes(n.type));
  if (!rows.length) return <div className="empty">This workflow sends nothing.</div>;
  const field = (nodeId: string, f: string, label: string, value: string, rowsN = 4) => (
    <form action={saveCopyAction} className="copy-form" key={`${nodeId}.${f}`}>
      <input type="hidden" name="slug" value={slug} /><input type="hidden" name="workflowId" value={workflowId} /><input type="hidden" name="nodeId" value={nodeId} /><input type="hidden" name="field" value={f} />
      <label className="muted" style={{ fontSize: 12.5, letterSpacing: ".04em", textTransform: "uppercase" }}>{label}</label>
      <textarea name="text" defaultValue={value} rows={rowsN} className="copy-edit" />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}><button className="btn" type="submit">Save</button>{saved === nodeId ? <span className="badge b-live">saved</span> : null}</div>
    </form>);
  return <div style={{ display: "grid", gap: 12 }}>
    {error ? <div className="card ready ready-no"><strong>Not saved.</strong> {error}</div> : null}
    <div className="muted" style={{ fontSize: 13 }}>Placeholders: <code>{"{{contact.first_name}}"}</code>, <code>{"{{appointment.starts_at | relative}}"}</code>, <code>{"{{appointment.closer.first_name}}"}</code>, <code>{"{{calendar.booking.url}}"}</code>, <code>{"{{appointment.answers.<name>}}"}</code>. Add <code>| default:…</code> for a fallback. Unknown placeholders are refused.</div>
    {rows.map((n) => {
      const label = n.type === "send_sms" ? `Text${n.kind === "transactional" ? " · automated receipt" : ""}` : n.type === "send_email" ? `Email${n.kind === "transactional" ? " · automated receipt" : ""}` : n.type === "slack_post" ? "Slack post" : n.type === "note" ? "Internal note on the contact" : "Task";
      return <div key={n.id} id={`copy-${n.id}`} className="card">
        <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}><span className="badge b-type">{label}</span><span className="mono muted">{n.id}</span></div>
        {n.type === "send_email" ? field(n.id, "subject", "Subject", n.subject, 1) : null}
        {n.type === "send_sms" || n.type === "send_email" || n.type === "slack_post" || n.type === "note" ? field(n.id, "template", n.type === "send_email" ? "Body (HTML allowed)" : "Message", n.template, n.type === "send_sms" ? 3 : 7) : null}
        {(n.type === "send_sms" || n.type === "send_email") && n.substitute_template ? field(n.id, "substitute_template", "Fallback, when the timing no longer fits", n.substitute_template, 3) : null}
        {n.type === "create_task" ? <>{field(n.id, "title", "Task title", n.title, 1)}{n.body ? field(n.id, "body", "Task details", n.body, 3) : null}</> : null}
      </div>; })}
  </div>;
}
