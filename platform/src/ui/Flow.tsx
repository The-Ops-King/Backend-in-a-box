import type { Definition, Node, Edge } from "@/engine/definition";
import { badge } from "./format";

type Step = { node_id: string; status: string; result?: Record<string, unknown>; error?: string | null };
const cond = (e: Edge) => e.label ? e.label : e.else ? "else" : e.when ? JSON.stringify(e.when).replace(/"\{\{|\}\}"/g, "").replace(/[{}"\[\]]/g, " ").replace(/\s+/g, " ").trim() : "";

function describe(n: Node): { title: string; body?: string; tpl?: string } {
  switch (n.type) {
    case "trigger": return { title: `on ${n.event}`, body: n.match ? `when ${JSON.stringify(n.match).replace(/"/g, "")}` : undefined };
    case "wait": return { title: `wait until ${n.rule.offset}`, body: `anchor ${n.rule.anchor} · tz ${n.rule.tz}${n.rule.guard ? ` · if <${n.rule.guard.min_lead} before, use ${n.rule.guard.fallback}` : ""}` };
    case "wait_for_reply": return { title: `wait for a ${n.channel} reply`, body: `up to ${n.timeout}; wakes the minute one arrives` };
    case "send_sms": return { title: "send SMS", body: n.validity ? `valid ${n.validity.anchor}${n.validity.min_lead ? ` ≥${n.validity.min_lead} before` : ""} · if stale: ${n.on_stale}` : undefined, tpl: n.template };
    case "send_email": return { title: `send email — ${n.subject}`, body: n.validity ? `valid ${n.validity.anchor} · if stale: ${n.on_stale}` : undefined, tpl: n.template.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
    case "slack_post": return { title: `Slack → ${n.channel}`, tpl: n.template };
    case "classify": return { title: `classify with Jev → ${n.into}`, body: `options: ${n.domain} · below ${n.threshold} = unclear`, tpl: n.input };
    case "branch": return { title: "branch" };
    case "check": return { title: "check", body: `${JSON.stringify(n.when).replace(/"/g, "")} else exit ${n.else_exit}` };
    case "set_tag": return { title: `tag "${n.tag}"` }; case "remove_tag": return { title: `remove tag "${n.tag}"` };
    case "note": return { title: "internal note", tpl: n.template };
    case "update_appointment": return { title: "update appointment", body: JSON.stringify(n.set) };
    case "update_opportunity": return { title: "update opportunity", body: JSON.stringify(n.set) };
    case "create_opportunity": return { title: "create pipeline card", body: `pipeline ${n.pipeline} · stage ${n.stage}${n.fields.length ? ` · fields: ${n.fields.map((f) => `${f.id} = ${f.value}`).join(", ")}` : ""}`, tpl: n.name };
    case "set_var": return { title: `set ${n.key}`, body: String(n.value) };
    case "start_workflow": return { title: `hand off to "${n.workflow}"` };
    case "pause_runs": return { title: "pause other runs for this contact" };
    case "exit": return { title: `exit · ${n.reason}` };
  }
}

/** Nodes in walk order from the trigger (breadth-first over edges), so branches read top to bottom; each node lists where it goes next. */
export function Flow({ def, steps = [], currentNode }: { def: Definition; steps?: Step[]; currentNode?: string | null }) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const out = (id: string) => def.edges.filter((e) => e.from === id);
  const order: string[] = []; const seen = new Set<string>();
  const q = def.nodes.filter((n) => n.type === "trigger").map((n) => n.id);
  while (q.length) { const id = q.shift()!; if (seen.has(id)) continue; seen.add(id); order.push(id); for (const e of out(id)) q.push(e.to); }
  for (const n of def.nodes) if (!seen.has(n.id)) order.push(n.id);
  const lastStep = new Map<string, Step>(); for (const s of steps) lastStep.set(s.node_id, s);
  return (
    <div className="flow">
      {order.map((id) => {
        const n = byId.get(id)!; const d = describe(n); const st = lastStep.get(id);
        const cls = st ? st.status : currentNode === id ? "waiting" : "";
        return (
          <div key={id} className={`node ${cls}`}>
            <div className="hd">
              <span className="badge b-type">{n.type}</span><strong>{d.title}</strong><span className="id">{id}</span>
              {st && <span className={badge(st.status)}>{st.status}</span>}
              {!st && currentNode === id && <span className="badge b-waiting">here now</span>}
            </div>
            {d.body && <div className="body">{d.body}</div>}
            {d.tpl && <div className="tpl mono">{d.tpl}</div>}
            {st?.error && <div className="body" style={{ color: "var(--bad)" }}>{st.error}</div>}
            {st?.result && Object.keys(st.result).length > 0 && <div className="body mono" style={{ color: "var(--muted)" }}>{JSON.stringify(st.result)}</div>}
            {out(id).length > 0 && n.type !== "exit" && (
              <div className="edges">{out(id).map((e, i) => <div key={i} className="edge">→ <b>{e.to}</b>{cond(e) ? ` · ${cond(e)}` : ""}{byId.get(e.to) ? ` (${describe(byId.get(e.to)!).title})` : ""}</div>)}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
