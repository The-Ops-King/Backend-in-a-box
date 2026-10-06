import Link from "next/link";
import { notFound } from "next/navigation";
import { company, workflow } from "@/ui/queries";
import { Flow } from "@/ui/Flow";
import { Mermaid } from "@/ui/Mermaid";
import { toMermaid } from "@/engine/mermaid";
import { ago, badge } from "@/ui/format";
import { toggleWorkflow } from "@/ui/actions";
export const dynamic = "force-dynamic";
export default async function WorkflowPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params; const co = await company(slug); const w = await workflow(id); if (!co || !w || w.company_id !== co.id) notFound();
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / {w.name}</p>
    <h1>{w.name}</h1>
    <form action={toggleWorkflow} style={{ display: "inline" }}><input type="hidden" name="id" value={w.id} /><input type="hidden" name="slug" value={slug} />
      <button className={`btn ${w.enabled ? "btn-off" : "btn-on"}`} type="submit">{w.enabled ? "Turn off" : "Turn on"}</button></form>
    <p className="sub"><span className={badge(w.enabled ? "active" : "paused")}>{w.enabled ? "on" : "off"}</span> · v{w.current_version}{w.template_version ? ` from template v${w.template_version}` : ""}{w.diverged ? " · edited since install" : ""} · re-entry <code>{w.reentry_policy}</code> · premise <code>{w.definition.premise.check}</code></p>
    <div className="grid g4">
      <div className="card stat"><div className="n">{w.stats.total}</div><div className="l">runs</div></div>
      <div className="card stat"><div className="n">{w.stats.waiting}</div><div className="l">in flight</div></div>
      <div className="card stat"><div className="n">{w.stats.completed}</div><div className="l">completed</div></div>
      <div className="card stat"><div className="n" style={{ color: w.stats.failed ? "var(--bad)" : undefined }}>{w.stats.failed}</div><div className="l">failed</div></div>
    </div>
    <h2>Flow chart</h2>
    <Mermaid chart={toMermaid(w.definition)} />
    <div className="grid g2" style={{ marginTop: 22, alignItems: "start" }}>
      <div><h2 style={{ marginTop: 0 }}>Steps</h2><Flow def={w.definition} /></div>
      <div>
        <h2 style={{ marginTop: 0 }}>Bindings this workflow needs</h2>
        <table><tbody>{w.manifest.bindings.map((b) => <tr key={b.key}><td className="mono">{b.key}</td><td><span className={badge(w.bound.includes(b.key) ? "ok" : b.required ? "failed" : "skipped")}>{w.bound.includes(b.key) ? "bound" : b.required ? "missing" : "optional, unbound"}</span></td></tr>)}</tbody></table>
        <h2>Versions</h2>
        <table><tbody>{w.versions.map((v) => <tr key={v.version}><td>v{v.version}</td><td>{ago(v.saved_at)}</td><td style={{ color: "var(--muted)" }}>{v.note ?? ""}</td></tr>)}</tbody></table>
        <h2>Definition</h2>
        <pre className="json">{JSON.stringify(w.definition, null, 2)}</pre>
      </div>
    </div>
  </>);
}
