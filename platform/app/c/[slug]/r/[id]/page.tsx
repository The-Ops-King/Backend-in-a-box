import Link from "next/link";
import { notFound } from "next/navigation";
import { company, run } from "@/ui/queries";
import { Outline } from "@/ui/Outline";
import { Timeline } from "@/ui/Timeline";
import { Mermaid } from "@/ui/Mermaid";
import { toMermaid } from "@/engine/mermaid";
import { loadPickers } from "@/ui/settings-data";
import { ago, badge, stamp } from "@/ui/format";
import { PlanList } from "@/ui/Plan";
import { plannedRuns } from "@/ui/plan";
export const dynamic = "force-dynamic";
export default async function RunPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params; const co = await company(slug); const r = await run(id); if (!co || !r || r.company_id !== co.id) notFound();
  const plan = ["active", "waiting"].includes(r.status) ? (await plannedRuns({ contactId: r.contact_id })).find((p) => p.run_id === r.id)?.plan ?? [] : [];
  const pk = await loadPickers(co.id);
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / <Link href={`/c/${slug}/w/${r.workflow_id}`}>{r.workflow}</Link> / run</p>
    <h1>{r.contact.trim() || "contact"} <span className="muted">· {r.workflow}</span></h1>
    <p className="sub"><span className={badge(r.status)}>{r.status}</span>{r.exit_reason ? ` · ${r.exit_reason}` : ""} · started {stamp(r.started_at, co.timezone)} ({ago(r.started_at)}){r.appt ? ` · appointment ${stamp(r.appt.starts_at, co.timezone)} (${r.appt.term}, ${r.appt.status})` : ""} · <Link href={`/c/${slug}/contacts/${r.contact_id}`}>open contact</Link></p>
    <h2>What happened</h2>
    <Timeline def={r.definition} steps={r.steps} sends={r.sends} tz={co.timezone} startedAt={r.started_at} status={r.status} exitReason={r.exit_reason} nextRunAt={r.next_run_at} currentNode={r.current_node} />
    {["active", "waiting"].includes(r.status) ? <><h2>What happens next</h2><div className="card"><PlanList plan={plan} tz={co.timezone} /></div></> : null}
    <h2>The path, on the workflow</h2>
    <Outline def={r.definition} company={{ name: co.name, timezone: co.timezone }} pk={pk} steps={r.steps} currentNode={r.current_node} />
    <h3 className="chart-h">Flow chart · this run's path on the branches</h3><Mermaid chart={toMermaid(r.definition, r.steps, r.current_node)} />
    <details className="adv"><summary>Advanced · context and raw steps</summary>
      <div className="tbl" style={{ marginTop: 12 }}><table><thead><tr><th>Node</th><th>Status</th><th>When</th><th>Result</th></tr></thead><tbody>{r.steps.map((s, i) => <tr key={i}><td className="mono">{s.node_id} <span style={{ color: "var(--muted)" }}>{s.node_type}</span></td><td><span className={badge(s.status)}>{s.status}</span></td><td>{stamp(s.started_at, co.timezone)}</td><td className="mono muted" style={{ fontSize: 12 }}>{s.error ?? JSON.stringify(s.result)}</td></tr>)}</tbody></table></div>
      <h3>Context</h3>
      <pre className="json">{JSON.stringify(r.context, null, 2)}</pre>
    </details>
  </>);
}
