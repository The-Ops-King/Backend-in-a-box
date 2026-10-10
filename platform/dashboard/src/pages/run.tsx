import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, useAction, usePage, type RunPage } from "~/api";
import { Crumb, Empty, Fold, NameLine, Sec, Sheet, Skeleton, Tag, toast } from "~/ui/pieces";
import { FlowChart, Legend, RunNodeWords } from "~/ui/chart";
import { Steps } from "~/ui/steps";
import { callTime, when } from "~/fmt";
import { Check, Clock, Stop, Warn } from "~/ui/icons";

export function Run() {
  const { slug = "", id = "" } = useParams();
  const q = usePage<RunPage>(["run", id], `/api/v1/runs/${id}`);
  const [pop, setPop] = useState<{ id: string; el: Element } | null>(null);
  // D66: the two hands on a paused run; the page refetches once the engine has answered
  const retry = useAction<void, { node: string | null }>(() => api(`/api/v1/runs/${id}/retry`, { method: "POST", json: {} }), [["run", id]]);
  const skip = useAction<void, { node: string | null; next?: string }>(() => api(`/api/v1/runs/${id}/skip`, { method: "POST", json: {} }), [["run", id]]);
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={8} />;
  const { company: co, workflow: w, run: r, feed, next, chart, states } = q.data;
  const stuck = r.status === "paused" || r.status === "failed";
  const pill = r.state === "ok" ? <Tag kind="ok"><Check />Finished</Tag> : r.state === "here" ? <Tag kind="here"><Clock />Waiting · {r.at.replace(/^in flight$/, "in flight")}</Tag> : r.state === "warn" ? <Tag kind="warn"><Warn />{r.at.replace(/^failed: /, "Failed at ").replace(/^paused: /, "Needs a hand at ")}</Tag> : <Tag><Stop />{r.at}</Tag>;
  const act = async (which: "retry" | "skip") => { try { const out = which === "retry" ? await retry.mutateAsync() : await skip.mutateAsync(); toast(which === "retry" ? `Retrying step ${out.node ?? ""} now.` : `Step ${out.node ?? ""} skipped; the run goes on.`); } catch (e) { toast((e as Error).message, true); } };
  return <>
    <Crumb items={[{ to: `/app/c/${slug}`, label: co.name }, { to: `/app/c/${slug}/w/${w.id}`, label: w.name }]} />
    <NameLine name={r.who} control={r.contact_id ? <Link className="btn" to={`/app/c/${slug}/contacts/${r.contact_id}`}>Open the contact</Link> : undefined} />
    <div className="tagline">{pill}{r.shadow ? <Tag kind="shadow">shadow</Tag> : null}<span>started {when(r.started_at, co.timezone)}</span>{r.appointment ? <><span>·</span><span>call {callTime(r.appointment.starts_at, co.timezone)}{r.appointment.closer ? ` with ${r.appointment.closer}` : ""}{r.appointment.status !== "confirmed" && r.appointment.status !== "booked" ? ` (${r.appointment.status})` : ""}</span></> : null}{r.contact_truth?.fetched_at ? <><span>·</span><span>CRM read {when(r.contact_truth.fetched_at, co.timezone)}</span></> : r.contact_truth?.stale ? <><span>·</span><span>acted on the engine's copy; GHL did not answer</span></> : null}</div>
    {r.state === "ok" && r.at !== "done" ? <p className="desc">{r.at.replace(/^done · /, "Done: ").replace(/^./, (c) => c.toUpperCase())}.</p> : null}
    {stuck ? <div className="issue"><Tag kind="warn">{r.status === "paused" ? "needs a hand" : "engine failure"}</Tag><span>{r.step_error ?? r.exit_reason ?? "The run stopped."}{r.step_attempt > 1 ? ` (${r.step_attempt} tries)` : ""}</span>
      <span style={{ display: "flex", gap: 8, marginLeft: "auto" }}><button type="button" className="btn" disabled={retry.isPending || skip.isPending} onClick={() => act("retry")}>Retry this step</button>{r.can_skip ? <button type="button" className="btn" disabled={retry.isPending || skip.isPending} onClick={() => act("skip")}>Skip this step</button> : null}</span></div> : null}
    <Sec>What happened</Sec>
    {feed.length ? <Steps items={feed} tz={co.timezone} /> : <Empty>Nothing yet.</Empty>}
    <Sec>What happens next</Sec>
    {next.length ? <Steps items={next} tz={co.timezone} /> : <p className="note">{r.state === "ok" ? "Nothing more: this run is finished." : r.state === "warn" ? (stuck ? "Nothing until a person retries or skips the step it stopped at." : "Nothing more: the run stopped at the failed step.") : r.state === "here" ? "It moves the moment something arrives." : "Nothing more."}</p>}
    <Sec small="tap a step for its words, or open the workflow">On the chart</Sec>
    {chart ? <><FlowChart chart={chart} states={states} pathOnly={typeof window !== "undefined" && window.innerWidth < 700} onOpen={(nid, el) => setPop({ id: nid, el })} /><Legend run states={Object.values(states)} /><div style={{ marginTop: 10 }}><Link className="btn" to={`/app/c/${slug}/w/${w.id}`}>Open the workflow</Link></div></> : <Empty>The chart cannot be drawn: this workflow needs a reinstall.</Empty>}
    <Fold title="Advanced · raw steps and context"><pre className="raw">{JSON.stringify(q.data.raw, null, 2)}</pre></Fold>
    {pop && chart ? <Sheet anchor={pop.el} onClose={() => setPop(null)}><RunNodeWords chart={chart} id={pop.id} states={states} feed={feed} /></Sheet> : null}
  </>;
}
