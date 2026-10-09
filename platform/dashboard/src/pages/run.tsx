import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePage, type RunPage } from "~/api";
import { Crumb, Empty, Fold, NameLine, Sec, Sheet, Skeleton, Tag } from "~/ui/pieces";
import { FlowChart, Legend, NodeWords } from "~/ui/chart";
import { Steps } from "~/ui/steps";
import { callTime, when } from "~/fmt";
import { Check, Clock, Stop, Warn } from "~/ui/icons";

export function Run() {
  const { slug = "", id = "" } = useParams();
  const q = usePage<RunPage>(["run", id], `/api/v1/runs/${id}`);
  const [pop, setPop] = useState<{ id: string; el: Element } | null>(null);
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={8} />;
  const { company: co, workflow: w, run: r, feed, next, chart, states } = q.data;
  const pill = r.state === "ok" ? <Tag kind="ok"><Check />Finished</Tag> : r.state === "here" ? <Tag kind="here"><Clock />Waiting · {r.at.replace(/^in flight$/, "in flight")}</Tag> : r.state === "warn" ? <Tag kind="warn"><Warn />{r.at.replace(/^failed: /, "Failed at ")}</Tag> : <Tag><Stop />{r.at}</Tag>;
  return <>
    <Crumb items={[{ to: `/app/c/${slug}`, label: co.name }, { to: `/app/c/${slug}/w/${w.id}`, label: w.name }]} />
    <NameLine name={r.who} control={r.contact_id ? <Link className="btn" to={`/app/c/${slug}/contacts/${r.contact_id}`}>Open the contact</Link> : undefined} />
    <div className="tagline">{pill}{r.shadow ? <Tag kind="shadow">shadow</Tag> : null}<span>started {when(r.started_at, co.timezone)}</span>{r.appointment ? <><span>·</span><span>call {callTime(r.appointment.starts_at, co.timezone)}{r.appointment.closer ? ` with ${r.appointment.closer}` : ""}{r.appointment.status !== "confirmed" && r.appointment.status !== "booked" ? ` (${r.appointment.status})` : ""}</span></> : null}</div>
    {r.state === "ok" && r.at !== "done" ? <p className="desc">{r.at.replace(/^done · /, "Done: ").replace(/^./, (c) => c.toUpperCase())}.</p> : null}
    <Sec>What happened</Sec>
    {feed.length ? <Steps items={feed} tz={co.timezone} /> : <Empty>Nothing yet.</Empty>}
    <Sec>What happens next</Sec>
    {next.length ? <Steps items={next} tz={co.timezone} /> : <p className="note">{r.state === "ok" ? "Nothing more: this run is finished." : r.state === "warn" ? "Nothing more: the run stopped at the failed step." : r.state === "here" ? "It moves the moment something arrives." : "Nothing more."}</p>}
    <Sec small="tap a step for its words, or open the workflow">On the chart</Sec>
    {chart ? <><FlowChart chart={chart} states={states} pathOnly={typeof window !== "undefined" && window.innerWidth < 700} onOpen={(nid, el) => setPop({ id: nid, el })} /><Legend run /><div style={{ marginTop: 10 }}><Link className="btn" to={`/app/c/${slug}/w/${w.id}`}>Open the workflow</Link></div></> : <Empty>The chart cannot be drawn: this workflow needs a reinstall.</Empty>}
    <Fold title="Advanced · raw steps and context"><pre className="raw">{JSON.stringify(q.data.raw, null, 2)}</pre></Fold>
    {pop && chart ? <Sheet anchor={pop.el} onClose={() => setPop(null)}><NodeWords chart={chart} id={pop.id} state={states[pop.id] ?? "next"} extra={<>{feed.find((f) => f.node_id === pop.id)?.note ? <p className="m" style={{ marginTop: 8 }}>{feed.find((f) => f.node_id === pop.id)!.note}</p> : null}{feed.find((f) => f.node_id === pop.id)?.words ? <div className="q">{feed.find((f) => f.node_id === pop.id)!.words}</div> : null}</>} /></Sheet> : null}
  </>;
}
