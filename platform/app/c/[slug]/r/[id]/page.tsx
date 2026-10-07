import Link from "next/link";
import { notFound } from "next/navigation";
import { company, run } from "@/ui/queries";
import { Flow } from "@/ui/Flow";
import { Mermaid } from "@/ui/Mermaid";
import { toMermaid } from "@/engine/mermaid";
import { ago, badge, when } from "@/ui/format";
import { PlanList } from "@/ui/Plan";
import { plannedRuns } from "@/ui/plan";
export const dynamic = "force-dynamic";
export default async function RunPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params; const co = await company(slug); const r = await run(id); if (!co || !r || r.company_id !== co.id) notFound();
  const plan = ["active", "waiting"].includes(r.status) ? (await plannedRuns({ contactId: r.contact_id })).find((p) => p.run_id === r.id)?.plan ?? [] : [];
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / <Link href={`/c/${slug}/w/${r.workflow_id}`}>{r.workflow}</Link> / run</p>
    <h1>{r.workflow} · <Link href={`/c/${slug}/contacts/${r.contact_id}`}>{r.contact.trim() || "contact"}</Link></h1>
    <p className="sub"><span className={badge(r.status)}>{r.status}</span>{r.exit_reason ? ` · ${r.exit_reason}` : ""} · started {ago(r.started_at)}{r.status === "waiting" && r.next_run_at ? ` · next ${when(r.next_run_at, co.timezone)}` : ""}{r.appt ? ` · appointment ${when(r.appt.starts_at, co.timezone)} (${r.appt.term}, ${r.appt.status})` : ""}</p>
    {["active", "waiting"].includes(r.status) ? <><h2>What happens next</h2><div className="card"><PlanList plan={plan} tz={co.timezone} /></div></> : null}
    <h2>Where this run is</h2>
    <Mermaid chart={toMermaid(r.definition, r.steps, r.current_node)} />
    <div className="grid g2" style={{ alignItems: "start" }}>
      <div><details className="steps" open><summary>Step by step, in words</summary><Flow def={r.definition} steps={r.steps} currentNode={r.current_node} /></details></div>
      <div>
        <h2 style={{ marginTop: 0 }}>Sends</h2>
        {r.sends.length === 0 ? <div className="empty">Nothing sent yet.</div> : <div className="tbl"><table><tbody>{r.sends.map((s, i) => <tr key={i}><td><span className="badge b-type">{s.channel}</span></td><td><span className={badge(s.status)}>{s.status}</span>{s.suppressed_reason ? <div style={{ color: "var(--muted)", fontSize: 12 }}>{s.suppressed_reason}</div> : null}{s.error ? <div style={{ color: "var(--bad)", fontSize: 12 }}>{s.error}</div> : null}</td><td style={{ whiteSpace: "pre-wrap" }}>{s.rendered_body.replace(/<[^>]+>/g, " ").trim()}</td><td>{s.sent_at ? ago(s.sent_at) : ""}</td></tr>)}</tbody></table></div>}
        <h2>Steps</h2>
        <div className="tbl"><table><thead><tr><th>Node</th><th>Status</th><th>When</th></tr></thead><tbody>{r.steps.map((s, i) => <tr key={i}><td className="mono">{s.node_id} <span style={{ color: "var(--muted)" }}>{s.node_type}</span></td><td><span className={badge(s.status)}>{s.status}</span></td><td>{ago(s.started_at)}</td></tr>)}</tbody></table></div>
        <h2>Context</h2>
        <pre className="json">{JSON.stringify(r.context, null, 2)}</pre>
      </div>
    </div>
  </>);
}
