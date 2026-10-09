import { useParams } from "react-router-dom";
import { usePage, type EodListPage } from "~/api";
import { Crumb, Empty, Ic, NameLine, Sec, Skeleton } from "~/ui/pieces";
import { when } from "~/fmt";

export function EodList() {
  const { slug = "" } = useParams();
  const q = usePage<EodListPage>(["eod", slug], `/api/v1/companies/${slug}/eod`, { every: 30_000 });
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={8} />;
  const { company: co, reports, closers } = q.data;
  const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return <>
    <Crumb items={[{ to: `/app/c/${slug}`, label: co.name }]} />
    <NameLine name="End of day" />
    <p className="desc">Each closer gets a DM from the end-of-day reminder workflow on days they had calls, with their link. Filing starts the end-of-day filed workflow.</p>
    <Sec>Filed</Sec>
    {reports.length === 0 ? <Empty>Nothing yet.</Empty> : <div className="rows">{reports.map((r) => <div key={r.id} className="row"><Ic state={r.submitted_at ? "ok" : "here"} /><span className="mid"><span className="nm">{r.closer} · {day(r.day)}</span><span className="sub" style={{ display: "block" }}>{r.submitted_at ? <><span>filed {when(r.submitted_at, co.timezone)}</span>{r.totals ? <span> · {r.totals}</span> : null}{r.changes.length ? <span style={{ display: "block", color: "var(--fg-2)" }}>Corrected: {r.changes.map((ch) => `${ch.contact ? `${ch.contact}: ` : ""}${ch.field} ${String(ch.from)} → ${String(ch.to)}`).join(" · ")}</span> : <span style={{ display: "block" }}>Nothing corrected: the prefill matched.</span>}</> : <span>not filed{r.reminded_at ? ` · reminded ${when(r.reminded_at, co.timezone)}` : ""}</span>}</span></span><span className="d"></span></div>)}</div>}
    <Sec>Closer links</Sec>
    {closers.length === 0 ? <Empty>Nobody is marked as a closer yet. Set roles in settings.</Empty> : <div className="rows">{closers.map((u) => <div key={u.id} className="row noicon"><span className="mid"><span className="nm">{u.name}</span><span className="sub"><a href={u.url} style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>{u.url}</a></span></span><span className="d"></span></div>)}</div>}
  </>;
}
