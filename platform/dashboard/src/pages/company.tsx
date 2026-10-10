import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, usePage, useAction, MODES, MODE_ABOUT, type Mode, type CompanyPage, type WorkflowRow } from "~/api";
import { Counts, Crumb, Empty, NameLine, Sec, Skeleton, Switch, Tag, toast } from "~/ui/pieces";
import { ago } from "~/fmt";

type Filter = "all" | "on" | "off" | "look";
export function Company() {
  const { slug = "" } = useParams();
  const key = ["company", slug];
  const q = usePage<CompanyPage>(key, `/api/v1/companies/${slug}`);
  const [filter, setFilter] = useState<Filter>("all");
  const flip = useAction<{ id: string; enabled: boolean }>((v) => api(`/api/v1/workflows/${v.id}/enabled`, { method: "POST", json: { enabled: v.enabled } }), [key]);
  const mode = useAction<{ mode: Mode }, { cleared?: { runs: number } }>((v) => api(`/api/v1/companies/${slug}/mode`, { method: "POST", json: v }), [key, ["companies"]]);
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={8} />;
  const { company: co, stages, workflows, alerts_open } = q.data;
  const looks = (w: WorkflowRow) => w.needs_hand > 0 || !w.ready;
  const shown = workflows.filter((w) => filter === "all" ? true : filter === "on" ? w.enabled : filter === "off" ? !w.enabled : looks(w));
  const groups = [...stages.map((s) => ({ id: s.id, label: s.label, items: shown.filter((w) => w.stage === s.id) })), { id: "other", label: "Other", items: shown.filter((w) => !stages.some((s) => s.id === w.stage)) }].filter((g) => g.items.length);
  const setMode = async (next: Mode) => {
    if (next === co.mode) return;
    if (next === "live" && !confirm("Go live? Enabled workflows will send real messages and write to the CRM, for everyone. Every run born before live is cleared: it was rehearsal.")) return;
    try { const r = await mode.mutateAsync({ mode: next }); toast(next === "live" ? `Live.${r?.cleared?.runs ? ` ${r.cleared.runs} rehearsal run${r.cleared.runs === 1 ? "" : "s"} cleared.` : ""}` : `Now in ${next}: ${MODE_ABOUT[next]}.`); } catch (e) { toast((e as Error).message, true); }
  };
  return <>
    <Crumb items={[{ to: "/app", label: "Companies" }]} />
    <NameLine name={co.name} control={<div className="steps" role="radiogroup" aria-label="mode">{MODES.map((m) => <button key={m} type="button" role="radio" aria-checked={co.mode === m} className={`step ${co.mode === m ? "on" : ""} ${m}`} onClick={() => setMode(m)} disabled={mode.isPending} title={MODE_ABOUT[m]}>{m === "live" && co.mode !== "live" ? "Go live" : m}</button>)}</div>} />
    <div className="tagline"><Tag kind={co.mode}>{co.mode}</Tag><span>{MODE_ABOUT[co.mode]}</span><span>·</span><span>{co.timezone}</span>
      <span>·</span><Link to={`/app/c/${slug}/health`} style={{ color: alerts_open ? "var(--warn)" : "var(--fg-3)" }}>{alerts_open ? `${alerts_open} open alert${alerts_open === 1 ? "" : "s"}` : "health: all clear"}</Link><span>·</span><Link to={`/app/c/${slug}/eod`} style={{ color: "var(--fg-3)" }}>end of day</Link><span>·</span><a href={`/c/${slug}/settings`} style={{ color: "var(--fg-3)" }}>settings</a></div>
    <div className="filt">{([["all", "All", workflows.length], ["on", "On", workflows.filter((w) => w.enabled).length], ["off", "Off", workflows.filter((w) => !w.enabled).length], ["look", "Needs a look", workflows.filter(looks).length]] as [Filter, string, number][]).map(([id, label, n]) => <button key={id} type="button" className="fb" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label} · {n}</button>)}</div>
    {groups.length === 0 ? <Empty>Nothing here.</Empty> : <div className="rail">{groups.map((g) => <div key={g.id} className={`grp ${g.items.some((w) => w.enabled) ? "live" : ""}`}><span className="stg">{g.label}</span><div className="rows">{g.items.map((w) => <Link key={w.id} to={`/app/c/${slug}/w/${w.id}`} className={`row ctl ${w.enabled ? "" : "off"}`}>
      <span className="mid"><span className="nm">{w.name}</span><span className="sub">{w.origin === "spec" ? <Tag kind="spec">your spec</Tag> : <Tag kind="def">default</Tag>}{!w.ready ? <Tag kind="warn">{w.parse_error ? "needs reinstall" : w.missing.length ? `missing ${w.missing.length} setting${w.missing.length === 1 ? "" : "s"}` : "not built yet"}</Tag> : null}<span>{w.enabled ? (w.last_ran ? `last ran ${ago(w.last_ran)}` : "never ran") : "off"}</span>{w.schedule ? <span>· {w.schedule}</span> : null}</span></span>
      <Counts people={w.people} in_flight={w.in_flight} needs_hand={w.needs_hand} />
      <Switch on={w.enabled} label={`${w.name} on or off`} onChange={async (next) => { try { await flip.mutateAsync({ id: w.id, enabled: next }); } catch (e) { toast((e as Error).message, true); throw e; } }} />
    </Link>)}</div></div>)}</div>}
    <div className="tagline more"><Link to={`/app/c/${slug}/setup`}>Setup</Link><span>·</span><Link to={`/app/c/${slug}/wrap-ups`}>Wrap-ups</Link><span>·</span><Link to={`/app/c/${slug}/eod`}>End of day</Link></div>
  </>;
}
