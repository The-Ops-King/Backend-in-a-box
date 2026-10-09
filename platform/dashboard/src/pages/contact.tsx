import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, usePage, useAction, type ContactPage } from "~/api";
import { Crumb, Empty, Fold, Ic, NameLine, Skeleton, Strip, Tabs, Tag, toast } from "~/ui/pieces";
import { shortDate, when } from "~/fmt";

const SIM: [string, string][] = [["create", "Lead comes in"], ["book", "Setter books a call"], ["book-self", "Books themselves"], ["reschedule", "Reschedules"], ["cancel", "Cancels"], ["pay", "Pays"], ["record", "Call recorded"], ["reset", "Forget this person's runs"]];

export function Contact() {
  const { slug = "", id = "" } = useParams();
  const key = ["contact", id];
  const q = usePage<ContactPage>(key, `/api/v1/contacts/${id}`);
  const [tab, setTab] = useState<"runs" | "next">("runs");
  const sim = useAction<string, { runs_started: number }>((action) => api(`/api/v1/contacts/${id}/simulate`, { method: "POST", json: { action } }), [key]);
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={8} />;
  const { company: co, contact: ct, facts, identifiers, runs, next, harness } = q.data;
  return <>
    <Crumb items={[{ to: `/app/c/${slug}`, label: co.name }]} />
    <NameLine name={ct.name} control={ct.crm_url ? <a className="btn" href={ct.crm_url} target="_blank" rel="noreferrer">Open in GHL</a> : undefined} />
    <div className="tagline" style={{ color: "var(--fg-2)", fontSize: 13.5 }}>{ct.phone ? <span>{ct.phone}</span> : null}{ct.phone && ct.email ? <span>·</span> : null}{ct.email ? <a href={`mailto:${ct.email}`} style={{ color: "var(--fg-2)" }}>{ct.email}</a> : null}<span>·</span><span>{ct.timezone}</span></div>
    {ct.tags.length ? <div className="tagline">{ct.tags.map((t) => <Tag key={t}>{t}</Tag>)}</div> : null}
    {facts.length ? <div className="chips">{facts.map(([k, v]) => <span key={k}><b>{k}</b>{v}</span>)}</div> : null}
    <Tabs value={tab} onChange={setTab} items={[{ id: "runs", label: <>Workflows · {runs.length}</> }, { id: "next", label: <>Next · {next.length}</> }]} />
    {tab === "runs" ? (runs.length ? <div className="rows">{runs.map((r) => <Link key={r.id} to={`/app/c/${slug}/r/${r.id}`} className="row"><Ic state={r.state} /><span className="mid"><span className="nm">{r.workflow}</span><Strip path={r.path} note={r.at} /></span><span className="d tnum">{shortDate(r.started_at, co.timezone)}</span></Link>)}</div> : <Empty>Not in a workflow yet.</Empty>)
      : (next.length ? <div className="rows">{next.map((n, i) => <Link key={i} to={`/app/c/${slug}/r/${n.run_id}`} className="row noicon"><span className="mid"><span className="nm">{n.title}</span><span className="sub"><span>{n.workflow}</span>{n.note ? <span>· {n.note}</span> : null}</span></span><span className="d tnum">{n.at ? when(n.at, co.timezone) : "when it moves"}</span></Link>)}</div> : <Empty>Nothing planned.</Empty>)}
    <Fold title="Identifiers"><dl className="kv">{identifiers.map(([k, v]) => <div key={k + v} style={{ display: "contents" }}><dt>{k}</dt><dd className="mono">{v}</dd></div>)}<dt>since</dt><dd>{shortDate(ct.since, co.timezone)}</dd></dl></Fold>
    <Fold title="Test harness · stage a step for this person (shadow only)"><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{SIM.map(([a, label]) => <button key={a} type="button" className={`btn ${a === "reset" ? "warn" : ""}`} disabled={!harness.allowed || sim.isPending} onClick={async () => { try { const r = await sim.mutateAsync(a); toast(a === "reset" ? "Forgotten." : `Staged: ${r.runs_started} run${r.runs_started === 1 ? "" : "s"} started`); } catch (e) { toast((e as Error).message, true); } }}>{label}</button>)}</div><p className="note" style={{ marginTop: 8 }}>Nothing reaches GHL, Calendly or a Zap.{harness.allowed ? "" : " Refused while the company is live."}</p></Fold>
  </>;
}
