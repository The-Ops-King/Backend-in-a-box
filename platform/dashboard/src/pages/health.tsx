import { useParams } from "react-router-dom";
import { api, usePage, useAction, type HealthPage } from "~/api";
import { Crumb, Empty, Fold, Ic, NameLine, Sec, Skeleton, Tag, toast } from "~/ui/pieces";
import { Link } from "react-router-dom";
import { ago, when } from "~/fmt";

export function Health() {
  const { slug = "" } = useParams();
  const key = ["health", slug];
  const q = usePage<HealthPage>(key, `/api/v1/companies/${slug}/health`);
  const sweep = useAction<string, { note: string }>((wid) => api(`/api/v1/workflows/${wid}/fire`, { method: "POST" }), [key, ["company", slug]]);
  const fix = useAction<string, { note: string }>((provider) => api(`/api/v1/companies/${slug}/health/fix`, { method: "POST", json: { provider } }), [key]);
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={8} />;
  const { company: co, open, checks, resolved, sweep: sw, starts, jev } = q.data;
  const pct = (k: number, n: number) => (n ? `${Math.round((k / n) * 100)}%` : "—");
  const intent = (v: string) => (v ? v.replace(/_/g, " ") : "nothing");
  const st = (s: string) => s === "ok" ? "ok" : s === "error" ? "warn" : s === "warn" ? "warn" : "stop";
  return <>
    <Crumb items={[{ to: `/app/c/${slug}`, label: co.name }]} />
    <NameLine name="Health" control={sw?.enabled ? <button type="button" className="btn" disabled={sweep.isPending} onClick={async () => { try { const r = await sweep.mutateAsync(sw.workflow_id); toast(r.note); } catch (e) { toast((e as Error).message, true); } }}>Sweep now</button> : undefined} />
    <div className="tagline">{open.length ? <Tag kind="warn">{open.length} open</Tag> : <Tag kind="ok">all clear</Tag>}<span>{sw ? `sweep ${sw.when ?? "off"}` : "no sweep workflow"}</span><span>·</span><span>last {sw?.last_run_at ? ago(sw.last_run_at) : "never"}</span></div>
    <Sec>Open right now</Sec>
    {open.length === 0 ? <Empty>Nothing wrong that the engine can see.</Empty> : <div className="rows">{open.map((a) => <div key={a.id} className="row"><Ic state="warn" /><span className="mid"><span className="nm" style={{ whiteSpace: "normal" }}>{a.text}</span><span className="sub"><span>{a.source}</span><span>· open {ago(a.first_seen)}</span>{a.link ? <a href={a.link} target="_blank" rel="noreferrer">{a.link_label ?? "open"} ↗</a> : null}</span></span><span className="d">{a.level}</span></div>)}</div>}
    <Sec>Last sweep, check by check</Sec>
    {!sw?.last_run_at ? <Empty>The sweep has not run yet.</Empty> : <div className="rows">{checks.map((c) => <div key={c.id} className={`row ${c.state === "off" || c.state === "na" ? "off" : ""}`}><Ic state={c.state === "off" || c.state === "na" ? "stop" : st(c.state)} /><span className="mid"><span className="nm">{c.label}</span><span className="sub" style={{ display: "block" }}>{c.state === "off" ? "off" : c.state === "na" ? "not applicable" : c.findings.map((f, i) => <span key={i} style={{ display: "block", color: f.ok ? "var(--fg-3)" : "var(--warn)" }}>{f.text}{f.href ? <> <a href={f.href} target="_blank" rel="noreferrer">{f.href_label ?? "open"} ↗</a></> : null}{f.fix ? <> <button type="button" className="btn" style={{ padding: "2px 9px", fontSize: 12, marginLeft: 6 }} disabled={fix.isPending} onClick={async () => { try { const r = await fix.mutateAsync(f.fix!.action.replace("reregister_", "")); toast(r.note); } catch (e) { toast((e as Error).message, true); } }}>{f.fix.label}</button></> : null}</span>)}</span></span><span className="d"></span></div>)}</div>}
    <Sec>Recently resolved</Sec>
    {resolved.length === 0 ? <Empty>Nothing resolved recently.</Empty> : <div className="rows">{resolved.map((a) => <div key={a.id} className="row"><Ic state="ok" /><span className="mid"><span className="nm" style={{ whiteSpace: "normal" }}>{a.text}</span><span className="sub"><span>opened {when(a.first_seen, co.timezone)}</span></span></span><span className="d tnum">{when(a.resolved_at, co.timezone)}</span></div>)}</div>}
    <Sec>Jev's reads</Sec>
    <p>Jev's reads this month: {jev.reviewed} reviewed, {jev.agreed} agreed ({pct(jev.agreed, jev.reviewed)}).</p>
    {jev.by_intent.length ? <Fold title="By what Jev read"><div className="rows">{jev.by_intent.map((r) => <div key={r.predicted} className="row noicon"><span className="mid"><span className="nm">Predicted {intent(r.predicted)}</span><span className="sub"><span>{r.reviewed} reviewed, {r.agreed} agreed</span></span></span><span className="d tnum">{pct(r.agreed, r.reviewed)}</span></div>)}</div></Fold> : null}
    <Fold title="What can start a workflow"><p className="note">Every fact the engine records is an event. A workflow's first step picks one. Count = seen here in the last 30 days.</p>
      <div className="rows">{starts.map((e) => <div key={e.event} className={`row noicon ${e.workflows.length ? "" : "off"}`}><span className="mid"><span className="nm">{e.label}</span><span className="sub"><span className="mono">{e.event}</span>{e.workflows.map((w) => <Link key={w.id} to={`/app/c/${slug}/w/${w.id}`}>{w.name}{w.enabled ? "" : " (off)"}</Link>)}</span></span><span className="d">{e.seen || ""}</span></div>)}</div></Fold>
  </>;
}
