import Link from "next/link";
import { notFound } from "next/navigation";
import { company, workflow, readiness } from "@/ui/queries";
import { ReadinessCard } from "@/ui/Readiness";
import { loadPickers } from "@/ui/settings-data";
import { asOperator } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { NextUp } from "@/ui/Plan";
import { plannedRuns } from "@/ui/plan";
import { Outline } from "@/ui/Outline";
import { ago, badge } from "@/ui/format";
import { toggleWorkflow } from "@/ui/actions";
export const dynamic = "force-dynamic";
export default async function WorkflowPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params; const co = await company(slug); const w = await workflow(id); if (!co || !w || w.company_id !== co.id) notFound();
  const all = await readiness(co.id, slug); const mine = all.workflows.find((x) => x.id === w.id);
  const live = await plannedRuns({ workflowId: w.id });
  const pk = await loadPickers(co.id);
  const bindings = Object.fromEntries(Object.entries((await asOperator((c) => loadCompany(c, co.id))).bindings).filter(([k]) => !k.startsWith("secret.")));   // examples never see a secret
  const ready = { ready: !!mine?.ready && !all.issues.some((i) => i.level === "blocker" && !i.href), issues: all.issues.filter((i) => !i.href || i.href.endsWith(`/w/${w.id}`)), workflows: mine ? [mine] : [] };
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / {w.name}</p>
    <h1>{w.name}</h1>
    <form action={toggleWorkflow} style={{ display: "inline" }}><input type="hidden" name="id" value={w.id} /><input type="hidden" name="slug" value={slug} />
      <button className={`btn ${w.enabled ? "btn-off" : "btn-on"}`} type="submit">{w.enabled ? "Turn off" : "Turn on"}</button></form>
    <p className="sub"><span className={badge(w.enabled ? "active" : "paused")}>{w.enabled ? "on" : "off"}</span> · v{w.current_version}{w.template_version ? ` from template v${w.template_version}` : ""}{w.diverged ? " · edited since install" : ""} · re-entry <code>{w.reentry_policy}</code>{w.definition ? <> · premise <code>{w.definition.premise.check}</code></> : null}</p>
    <ReadinessCard r={ready} title="Ready to turn on?" />
    <div className="grid g4">
      <div className="card stat"><div className="n">{w.stats.total}</div><div className="l">runs</div></div>
      <div className="card stat"><div className="n">{w.stats.waiting}</div><div className="l">in flight</div></div>
      <div className="card stat"><div className="n">{w.stats.completed}</div><div className="l">completed</div></div>
      <div className="card stat"><div className="n" style={{ color: w.stats.failed ? "var(--bad)" : undefined }}>{w.stats.failed}</div><div className="l">failed</div></div>
    </div>
    <h2>What it does</h2>
    <p className="sub">Read top to bottom. Hover a line to see what it produces, as an example. Changes to any workflow go through the chat, not this page.</p>
    {w.definition ? <Outline def={w.definition} company={{ name: co.name, timezone: co.timezone }} bindings={bindings} pk={pk} /> : <div className="card ready ready-no"><strong>This workflow's stored definition no longer runs on the current engine.</strong><div className="body">Re-run install for this company to upgrade it to the current template. Until then its triggers are skipped.</div><pre className="json" style={{ marginTop: 10 }}>{w.parseError}</pre></div>}
    <h2>In this workflow right now · {live.length}</h2>
    <NextUp runs={live} slug={slug} tz={co.timezone} showContact />
    <div className="grid g2" style={{ marginTop: 22, alignItems: "start" }}>
      <div>
        <h2 style={{ marginTop: 0 }}>Bindings this workflow needs</h2>
        <div className="tbl"><table><tbody>{w.manifest.bindings.map((b) => <tr key={b.key}><td className="mono">{b.key}</td><td><span className={badge(w.bound.includes(b.key) ? "ok" : b.required ? "failed" : "skipped")}>{w.bound.includes(b.key) ? "bound" : b.required ? "missing" : "optional, unbound"}</span></td></tr>)}</tbody></table></div>
        <h2>Versions</h2>
        <div className="tbl"><table><tbody>{w.versions.map((v) => <tr key={v.version}><td>v{v.version}</td><td>{ago(v.saved_at)}</td><td style={{ color: "var(--muted)" }}>{v.note ?? ""}</td></tr>)}</tbody></table></div>
      </div>
      <div>
        <h2 style={{ marginTop: 0 }}>Definition</h2>
        <details className="steps"><summary>The JSON this workflow runs from (audit)</summary><pre className="json">{JSON.stringify(w.definition ?? w.parseError, null, 2)}</pre></details>
      </div>
    </div>
  </>);
}
