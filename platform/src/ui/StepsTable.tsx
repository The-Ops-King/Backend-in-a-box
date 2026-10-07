import type { Definition } from "@/engine/definition";
import { branchTitle, describeNode, edgeWords, kindOf, KIND_LABEL, walkOrder } from "@/engine/describe";

/** The workflow as a table: one row per step, what it does, where it goes. For checking a flow without reading a chart. */
export function StepsTable({ def }: { def: Definition }) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const out = (id: string) => def.edges.filter((e) => e.from === id);
  return <div className="tbl"><table><thead><tr><th>#</th><th>Step</th><th>Kind</th><th>What it does</th><th>Then</th></tr></thead><tbody>
    {walkOrder(def).map((id, i) => { const n = byId.get(id)!; const d = n.type === "branch" ? { title: branchTitle(def, id) } : describeNode(n); const kind = kindOf(n);
      return <tr key={id}><td className="mono muted">{i + 1}</td><td className="mono">{id}</td><td><span className={`kind k-${kind}`}>{KIND_LABEL[kind]}</span></td>
        <td><strong>{d.title}</strong>{d.detail ? <div className="muted" style={{ fontSize: 13 }}>{d.detail}</div> : null}{d.quote ? <div className="tpl" style={{ marginTop: 6 }}>{d.quote}</div> : null}{n.type === "check" ? <div className="muted" style={{ fontSize: 13 }}>if not → stops ({n.else_exit.replace(/_/g, " ")})</div> : null}</td>
        <td>{n.type === "exit" ? <span className="muted">end</span> : out(id).map((e, j) => { const to = byId.get(e.to); const w = edgeWords(e); return <div key={j}>{w ? <b>{w}</b> : null}{w ? " → " : "→ "}<span className="mono">{e.to}</span> <span className="muted">{to ? (to.type === "branch" ? branchTitle(def, to.id) : describeNode(to).title) : ""}</span></div>; })}</td></tr>; })}
  </tbody></table></div>;
}
