import type { Definition } from "@/engine/definition";
import { describeNode, walkOrder } from "@/engine/describe";
import { saveStepAction } from "./actions";
import type { Pickers } from "./settings-data";

/**
 * GHL-style settings on the steps themselves: pick the pipeline and stage, the owner, the Slack channel, the tags, right
 * where the step is. A value that comes from a company binding shows what it resolves to; saving writes the literal onto
 * this company's copy.
 */
export function StepsPanel({ def, slug, workflowId, pk, saved }: { def: Definition; slug: string; workflowId: string; pk: Pickers; saved?: string }) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const rows = walkOrder(def).map((id) => byId.get(id)!).filter((n) => ["pipeline_card", "slack_post", "set_tag", "remove_tag", "update_contact", "create_task"].includes(n.type));
  if (!rows.length) return <div className="empty">No steps with CRM or Slack settings in this workflow.</div>;
  const bound = (v: string | undefined) => (v && /^\{\{/.test(v) ? <span className="muted" style={{ fontSize: 12 }}> · from setting <code>{v.replace(/[{}\s]/g, "").split("|")[0]}</code></span> : null);
  const stageOpts = (pk.catalog?.pipelines ?? []).flatMap((p) => p.stages.map((s) => ({ value: `${p.id}|${s.id}`, label: `${p.name} › ${s.name}` })));
  const hidden = (n: { id: string; type: string }) => <><input type="hidden" name="slug" value={slug} /><input type="hidden" name="workflowId" value={workflowId} /><input type="hidden" name="nodeId" value={n.id} /><input type="hidden" name="type" value={n.type} /></>;
  return <div style={{ display: "grid", gap: 10 }}>{rows.map((n) => {
    const d = describeNode(n);
    return <form key={n.id} id={`step-${n.id}`} action={saveStepAction} className="form card settings step">{hidden(n)}
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}><span className="mono muted">{n.id}</span><strong>{d.title}</strong>{saved === n.id ? <span className="badge b-live">saved</span> : null}</div>
      {n.type === "pipeline_card" ? (() => { const curP = pk.resolve(n.pipeline), curS = pk.resolve(n.stage); const cur = curP && curS ? `${curP}|${curS}` : ""; const known = stageOpts.some((o) => o.value === cur);
        return <div className="grid g2" style={{ marginTop: 8 }}>
          <label>Pipeline › stage{bound(n.stage ?? n.pipeline)}<select name="pipeline_stage" defaultValue={cur}><option value="">— keep —</option>{!known && cur ? <option value={cur}>{pk.pipelineName(curP)} › {pk.stageName(curS)} (current)</option> : null}{stageOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>{!n.stage ? <span className="muted" style={{ fontSize: 12 }}>This step only updates fields; picking a stage makes it move the card too.</span> : null}</label>
          <label>Card name{bound(n.name)}<input type="text" name="name" defaultValue={n.name ?? ""} placeholder="{{contact.name}} -- New" /></label>
          <label>Owner{bound(n.assign_to)}<select name="assign_to" defaultValue={pk.resolve(n.assign_to)}><option value="">— as the template says —</option>{pk.users.map((u) => <option key={u.ghl_user_id} value={u.ghl_user_id}>{u.name}</option>)}</select></label>
          <label>Status<select name="status" defaultValue={n.status ?? ""}><option value="">open (leave as is)</option><option value="won">won</option><option value="lost">lost</option><option value="abandoned">abandoned</option></select></label>
          <label>If the card does not exist<select name="if_missing" defaultValue={n.if_missing}><option value="create">create it</option><option value="skip">skip this step</option></select></label>
        </div>; })() : null}
      {n.type === "slack_post" ? (() => { const cur = pk.resolve(n.channel); return <label style={{ marginTop: 8 }}>Channel{bound(n.channel)}{pk.slackChannels ? <select name="channel" defaultValue={cur}><option value="">— keep —</option>{!pk.slackChannels.some((ch) => ch.id === cur) && cur ? <option value={cur}>{cur} (current)</option> : null}{pk.slackChannels.map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}</select> : <input type="text" name="channel" defaultValue={cur} placeholder="C0123ABCDEF — connect Slack in settings to pick by name" />}</label>; })() : null}
      {n.type === "set_tag" || n.type === "remove_tag" ? <label style={{ marginTop: 8 }}>Tags (one per line){bound(Array.isArray(n.tag) ? undefined : n.tag)}<textarea name="tags" rows={2} defaultValue={(Array.isArray(n.tag) ? n.tag : [n.tag]).join("\n")} /></label> : null}
      {n.type === "update_contact" ? <label style={{ marginTop: 8 }}>Owner{bound(n.set.assign_to)}<select name="assign_to" defaultValue={pk.resolve(n.set.assign_to)}><option value="">— as the template says —</option>{pk.users.map((u) => <option key={u.ghl_user_id} value={u.ghl_user_id}>{u.name}</option>)}</select></label> : null}
      {n.type === "create_task" ? <div className="grid g2" style={{ marginTop: 8 }}><label>Assign to{bound(n.assign_to)}<select name="assign_to" defaultValue={pk.resolve(n.assign_to)}><option value="">— as the template says —</option>{pk.users.map((u) => <option key={u.ghl_user_id} value={u.ghl_user_id}>{u.name}</option>)}</select></label><label>Due<input type="text" name="due" defaultValue={n.due} placeholder="+1d" /></label></div> : null}
      <button className="btn" type="submit" style={{ marginTop: 8 }}>Save step</button>
    </form>; })}</div>;
}
