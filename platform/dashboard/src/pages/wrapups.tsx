import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePage, type MetricsPage, type SetterStats, type WrapUpsPage } from "~/api";
import { Crumb, Empty, Fold, Ic, NameLine, Sec, Skeleton, Tag, Tiles } from "~/ui/pieces";
import { when } from "~/fmt";

/** Every wrap-up the engine built, newest first, as Slack got it (or would have, in shadow); above them, the setters' numbers for any date range. */
export function WrapUps() {
  const { slug = "" } = useParams();
  const q = usePage<WrapUpsPage>(["wrap-ups", slug], `/api/v1/companies/${slug}/wrap-ups`, { every: 60_000 });
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={8} />;
  const { company: co, reports, workflow: wf } = q.data;
  return <>
    <Crumb items={[{ to: `/app/c/${slug}`, label: co.name }]} />
    <NameLine name="Wrap-ups" />
    <div className="tagline">{wf ? <><Link to={`/app/c/${slug}/w/${wf.id}`}>{wf.name}</Link><span>·</span><span>{wf.enabled && wf.when ? wf.when : "off"}</span></> : <span>no wrap-up workflow installed</span>}</div>
    <Setters slug={slug} tz={co.timezone} />
    <Sec>Posted</Sec>
    {reports.length === 0 ? <Empty>No wrap-ups yet.</Empty> : <div className="rows">{reports.map((r) => <div key={r.id} className="row noicon" style={{ display: "block" }}>
      <Fold title={<><Ic state={r.status === "sent" ? "ok" : r.status === "shadow" ? "ghost" : "skip"} /> <b style={{ textTransform: "capitalize" }}>{r.kind}</b> <span className="sub" style={{ display: "inline" }}>{r.period_start}{r.period_end !== r.period_start ? ` → ${r.period_end}` : ""} · {when(r.generated_at, co.timezone)}</span> {r.status === "sent" ? <Tag kind="ok">posted</Tag> : r.status === "shadow" ? <Tag kind="shadow">shadow</Tag> : <Tag>{r.status ?? "not posted"}</Tag>}{r.on_demand ? <Tag>on demand</Tag> : null}</>}>
        <pre className="pre">{r.body}</pre>
      </Fold>
    </div>)}</div>}
  </>;
}

/** Today's date in the company's zone, as YYYY-MM-DD; the week starts on Monday, like the weekly wrap-up. */
function localDate(tz: string, shiftDays = 0): string {
  const d = new Date(Date.now() + shiftDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function weekStart(tz: string): string {
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date());
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(dow);
  return localDate(tz, -Math.max(back, 0));
}
const mins = (m: number | null) => (m === null ? "—" : m < 60 ? `${Math.round(m)} min` : m < 1440 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} d`);
const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "—");

function Setters({ slug, tz }: { slug: string; tz: string }) {
  const [from, setFrom] = useState(() => weekStart(tz));
  const [to, setTo] = useState(() => localDate(tz));
  const q = usePage<MetricsPage>(["metrics", slug, from, to], `/api/v1/companies/${slug}/metrics?from=${from}&to=${to}`, { every: 60_000, enabled: from <= to });
  const t = q.data?.totals;
  return <>
    <Sec small={q.data ? `reached = connected ≥ ${q.data.reached_seconds}s · speed to lead = lead arrived → first dial` : undefined}>Setters</Sec>
    <form className="form filt" onSubmit={(e) => e.preventDefault()} style={{ alignItems: "end" }}>
      <label>From<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>To<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
      <span className="tabs" style={{ margin: 0 }}>
        <button type="button" aria-pressed={from === weekStart(tz) && to === localDate(tz)} onClick={() => { setFrom(weekStart(tz)); setTo(localDate(tz)); }}>this week</button>
        <button type="button" aria-pressed={from === localDate(tz) && to === localDate(tz)} onClick={() => { setFrom(localDate(tz)); setTo(localDate(tz)); }}>today</button>
        <button type="button" aria-pressed={from === localDate(tz, -29) && to === localDate(tz)} onClick={() => { setFrom(localDate(tz, -29)); setTo(localDate(tz)); }}>30 days</button>
      </span>
    </form>
    {!q.data ? (q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={3} />) : <>
      {t ? <Tiles items={[{ n: t.leads_assigned, word: "new leads" }, { n: t.dials, word: "dials" }, { n: t.connected, word: "connected" }, { n: t.contacts_reached, word: "people reached" }, { n: t.never_dialled, word: "never dialled", kind: t.never_dialled ? "f" : undefined }, { n: t.bookings, word: "bookings followed" }]} /> : null}
      {t ? <p className="note" style={{ marginTop: 8 }}>Speed to lead, everyone: median {mins(t.stl_median_min)} · average {mins(t.stl_avg_min)} over {t.leads_dialled_first} leads dialled.</p> : null}
      {q.data.setters.length === 0 ? <Empty>No dials in this range.</Empty> : <div className="rows">{q.data.setters.map((s) => <SetterRow key={s.id} s={s} />)}</div>}
    </>}
  </>;
}

function SetterRow({ s }: { s: SetterStats }) {
  return <div className="row noicon" style={{ display: "block" }}>
    <Fold title={<><b>{s.name}</b> <span className="sub" style={{ display: "inline" }}>{s.dials} dials · {s.connected} connected ({pct(s.connected, s.dials)}) · speed to lead {mins(s.stl_median_min)} median{s.never_dialled ? <> · <span style={{ color: "var(--warn)" }}>{s.never_dialled} never dialled</span></> : null}</span></>}>
      <dl className="kv">
        <dt>Leads assigned</dt><dd>{s.leads_assigned}{s.leads_assigned ? ` · ${s.never_dialled} never dialled by anyone` : ""}</dd>
        <dt>Dials</dt><dd>{s.dials} · {s.answered} answered · {s.connected} connected ({pct(s.connected, s.dials)}) · {Math.round(s.talk_sec / 60)} min talking</dd>
        <dt>People reached</dt><dd>{s.contacts_reached}</dd>
        <dt>Speed to lead</dt><dd>{s.leads_dialled_first ? `median ${mins(s.stl_median_min)} · average ${mins(s.stl_avg_min)} · over ${s.leads_dialled_first} leads they dialled first` : "no lead from this range had its first dial from them"}</dd>
        <dt>Bookings followed</dt><dd>{s.bookings}</dd>
      </dl>
    </Fold>
  </div>;
}
