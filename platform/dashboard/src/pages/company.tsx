import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, usePage, useAction, type CompanyPage, type WorkflowRow } from "~/api";
import { Counts, Crumb, Empty, NameLine, Sec, Skeleton, Switch, Tag, toast } from "~/ui/pieces";
import { ago } from "~/fmt";

type Filter = "all" | "on" | "off" | "look";
export function Company() {
  const { slug = "" } = useParams();
  const key = ["company", slug];
  const q = usePage<CompanyPage>(key, `/api/v1/companies/${slug}`);
  const [filter, setFilter] = useState<Filter>("all");
  const flip = useAction<{ id: string; enabled: boolean }>((v) => api(`/api/v1/workflows/${v.id}/enabled`, { method: "POST", json: { enabled: v.enabled } }), [key]);
  const mode = useAction<{ mode: "live" | "shadow" }>((v) => api(`/api/v1/companies/${slug}/mode`, { method: "POST", json: v }), [key, ["companies"]]);
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={8} />;
  const { company: co, stages, workflows, alerts_open } = q.data;
  const looks = (w: WorkflowRow) => w.failed > 0 || !w.ready;
  const shown = workflows.filter((w) => filter === "all" ? true : filter === "on" ? w.enabled : filter === "off" ? !w.enabled : looks(w));
  const groups = [...stages.map((s) => ({ id: s.id, label: s.label, items: shown.filter((w) => w.stage === s.id) })), { id: "other", label: "Other", items: shown.filter((w) => !stages.some((s) => s.id === w.stage)) }].filter((g) => g.items.length);
  const goLive = async () => { const next = co.mode === "live" ? "shadow" : "live"; if (next === "live" && !confirm("Go live? Enabled workflows will send real messages and write to the CRM.")) return; try { await mode.mutateAsync({ mode: next }); toast(next === "live" ? "Live. Enabled workflows now reach people." : "Back in shadow."); } catch (e) { toast((e as Error).message, true); } };
  return <>
    <Crumb items={[{ to: "/app", label: "Companies" }]} />
    <NameLine name={co.name} control={<button type="button" className="btn" onClick={goLive} disabled={mode.isPending}>{co.mode === "live" ? "Back to shadow" : "Go live"}</button>} />
    <div className="tagline">{co.mode === "live" ? <Tag kind="live">live</Tag> : <Tag kind="shadow">shadow</Tag>}<span>{co.mode === "live" ? "sends go out and the CRM is written" : "sends are written down, not delivered"}</span><span>·</span><span>{co.timezone}</span>
      <span>·</span><Link to={`/app/c/${slug}/health`} style={{ color: alerts_open ? "var(--warn)" : "var(--fg-3)" }}>{alerts_open ? `${alerts_open} open alert${alerts_open === 1 ? "" : "s"}` : "health: all clear"}</Link><span>·</span><Link to={`/app/c/${slug}/eod`} style={{ color: "var(--fg-3)" }}>end of day</Link><span>·</span><a href={`/c/${slug}/settings`} style={{ color: "var(--fg-3)" }}>settings</a></div>
    <div className="filt">{([["all", "All", workflows.length], ["on", "On", workflows.filter((w) => w.enabled).length], ["off", "Off", workflows.filter((w) => !w.enabled).length], ["look", "Needs a look", workflows.filter(looks).length]] as [Filter, string, number][]).map(([id, label, n]) => <button key={id} type="button" className="fb" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label} · {n}</button>)}</div>
    {groups.length === 0 ? <Empty>Nothing here.</Empty> : <div className="rail">{groups.map((g) => <div key={g.id} className={`grp ${g.items.some((w) => w.enabled) ? "live" : ""}`}><span className="stg">{g.label}</span><div className="rows">{g.items.map((w) => <Link key={w.id} to={`/app/c/${slug}/w/${w.id}`} className={`row ctl ${w.enabled ? "" : "off"}`}>
      <span className="mid"><span className="nm">{w.name}</span><span className="sub">{w.origin === "spec" ? <Tag kind="spec">your spec</Tag> : <Tag kind="def">default</Tag>}{!w.ready ? <Tag kind="warn">{w.parse_error ? "needs reinstall" : w.missing.length ? `missing ${w.missing.length} setting${w.missing.length === 1 ? "" : "s"}` : "not built yet"}</Tag> : null}<span>{w.enabled ? (w.last_ran ? `last ran ${ago(w.last_ran)}` : "never ran") : "off"}</span>{w.schedule ? <span>· {w.schedule}</span> : null}</span></span>
      <Counts people={w.people} in_flight={w.in_flight} failed={w.failed} />
      <Switch on={w.enabled} label={`${w.name} on or off`} onChange={async (next) => { try { await flip.mutateAsync({ id: w.id, enabled: next }); } catch (e) { toast((e as Error).message, true); throw e; } }} />
    </Link>)}</div></div>)}</div>}
    <details className="fold"><summary>Other pages</summary><div className="body note">Not yet redesigned, still useful: <a href={`/c/${slug}/appointments`}>appointments</a> · <a href={`/c/${slug}/payments`}>payments</a> · <a href={`/c/${slug}/recordings`}>recordings</a> · <a href={`/c/${slug}/reports`}>wrap-ups</a> · <a href={`/c/${slug}/sends`}>sends</a> · <a href={`/c/${slug}/triggers`}>triggers</a>.</div></details>
  </>;
}
