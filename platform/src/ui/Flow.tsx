import type { Definition } from "@/engine/definition";
import { branchTitle, describeNode, edgeWords, kindOf, KIND_LABEL, walkOrder } from "@/engine/describe";
import { badge } from "./format";

type Step = { node_id: string; status: string; result?: Record<string, unknown>; error?: string | null };

/** Nodes in the order the flow runs them (walkOrder), each with a kind tag, a plain-English title, and where it goes next. */
export function Flow({ def, steps = [], currentNode }: { def: Definition; steps?: Step[]; currentNode?: string | null }) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const out = (id: string) => def.edges.filter((e) => e.from === id);
  const lastStep = new Map<string, Step>(); for (const s of steps) lastStep.set(s.node_id, s);
  return (
    <div className="flow">
      {walkOrder(def).map((id) => {
        const n = byId.get(id)!; const d = n.type === "branch" ? { title: branchTitle(def, id) } : describeNode(n); const st = lastStep.get(id); const kind = kindOf(n);
        const cls = st ? st.status : currentNode === id ? "waiting" : "";
        return (
          <div key={id} className={`node k-${kind} ${cls}`}>
            <div className="hd">
              <span className={`kind k-${kind}`}>{KIND_LABEL[kind]}</span><strong>{d.title}</strong>
              {st && <span className={badge(st.status)}>{st.status}</span>}
              {!st && currentNode === id && <span className="badge b-waiting">here now</span>}
            </div>
            {d.detail && <div className="body">{d.detail}</div>}
            {d.quote && <div className="tpl">{d.quote}</div>}
            {st?.error && <div className="body bad">{st.error}</div>}
            {st?.result && Object.keys(st.result).length > 0 && <div className="body mono muted">{JSON.stringify(st.result)}</div>}
            {out(id).length > 0 && n.type !== "exit" && (
              <div className="edges">{out(id).map((e, i) => { const to = byId.get(e.to); const w = edgeWords(e); return <div key={i} className="edge">{w ? <><b>{w}</b> → </> : "→ "}{to ? describeNode(to).title : e.to}</div>; })}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
