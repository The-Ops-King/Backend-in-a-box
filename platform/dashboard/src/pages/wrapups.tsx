import { Link, useParams } from "react-router-dom";
import { usePage, type WrapUpsPage } from "~/api";
import { Crumb, Empty, Fold, Ic, NameLine, Skeleton, Tag } from "~/ui/pieces";
import { when } from "~/fmt";

/** Every wrap-up the engine built, newest first, as Slack got it (or would have, in shadow). */
export function WrapUps() {
  const { slug = "" } = useParams();
  const q = usePage<WrapUpsPage>(["wrap-ups", slug], `/api/v1/companies/${slug}/wrap-ups`, { every: 60_000 });
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={8} />;
  const { company: co, reports, workflow: wf } = q.data;
  return <>
    <Crumb items={[{ to: `/app/c/${slug}`, label: co.name }]} />
    <NameLine name="Wrap-ups" />
    <div className="tagline">{wf ? <><Link to={`/app/c/${slug}/w/${wf.id}`}>{wf.name}</Link><span>·</span><span>{wf.enabled && wf.when ? wf.when : "off"}</span></> : <span>no wrap-up workflow installed</span>}</div>
    {reports.length === 0 ? <Empty>No wrap-ups yet.</Empty> : <div className="rows">{reports.map((r) => <div key={r.id} className="row noicon" style={{ display: "block" }}>
      <Fold title={<><Ic state={r.status === "sent" ? "ok" : r.status === "shadow" ? "ghost" : "skip"} /> <b style={{ textTransform: "capitalize" }}>{r.kind}</b> <span className="sub" style={{ display: "inline" }}>{r.period_start}{r.period_end !== r.period_start ? ` → ${r.period_end}` : ""} · {when(r.generated_at, co.timezone)}</span> {r.status === "sent" ? <Tag kind="ok">posted</Tag> : r.status === "shadow" ? <Tag kind="shadow">shadow</Tag> : <Tag>{r.status ?? "not posted"}</Tag>}{r.on_demand ? <Tag>on demand</Tag> : null}</>}>
        <pre className="pre">{r.body}</pre>
      </Fold>
    </div>)}</div>}
  </>;
}
