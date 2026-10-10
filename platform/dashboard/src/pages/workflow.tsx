import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, usePage, useAction, type WorkflowPage, type RunListRow } from "~/api";
import { Crumb, Empty, Ic, NameLine, Sec, Sheet, Skeleton, Strip, Switch, Tag, Tiles, toast } from "~/ui/pieces";
import { FlowChart, Legend, NodeWords } from "~/ui/chart";
import { Steps } from "~/ui/steps";
import { ago, shortDate } from "~/fmt";

export function Workflow() {
  const { slug = "", id = "" } = useParams();
  const key = ["workflow", id];
  const q = usePage<WorkflowPage>(key, `/api/v1/workflows/${id}`);
  const flip = useAction<boolean>((enabled) => api(`/api/v1/workflows/${id}/enabled`, { method: "POST", json: { enabled } }), [key, ["company", slug]]);
  const fire = useAction<void, { note: string }>(() => api(`/api/v1/workflows/${id}/fire`, { method: "POST" }), [key]);
  const [pop, setPop] = useState<{ id: string; el: Element } | null>(null);
  const [row, setRow] = useState<{ r: RunListRow; el: HTMLElement } | null>(null);
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={8} />;
  const { company: co, workflow: w, tiles, chart, runs, ready } = q.data;
  const control = <Switch big word on={w.enabled} label="On or off" onChange={async (next) => { try { await flip.mutateAsync(next); } catch (e) { toast((e as Error).message, true); throw e; } }} />;
  return <>
    <Crumb items={[{ to: `/app/c/${slug}`, label: co.name }]} />
    <NameLine name={w.name} control={control} />
    <div className="tagline">{w.stage ? <Tag>{w.stage.replace(/_/g, "-")}</Tag> : null}{w.origin === "spec" ? <Tag kind="spec">your spec</Tag> : <Tag kind="def">default</Tag>}{co.mode === "shadow" ? <Tag kind="shadow">shadow</Tag> : null}{!ready.ready ? <Tag kind="warn">{ready.missing.length ? `missing ${ready.missing.join(", ")}` : ready.gaps.length ? "not built yet" : "needs reinstall"}</Tag> : null}<span>{w.last_ran ? `last ran ${ago(w.last_ran)}` : "never ran"}</span>{w.schedule ? <><span>·</span><span>{w.schedule}</span>{w.enabled ? <button type="button" className="btn" style={{ padding: "3px 10px", fontSize: 12 }} disabled={fire.isPending} onClick={async () => { try { const r = await fire.mutateAsync(); toast(r.note); } catch (e) { toast((e as Error).message, true); } }}>Run now</button> : null}</> : null}</div>
    {w.description ? <p className="desc">{w.description}</p> : null}
    {ready.gaps.length || ready.issues.length ? <div style={{ marginTop: 10 }}>{[...ready.gaps.map((g) => ({ level: "warning", text: g })), ...ready.issues].map((i, k) => <div key={k} className="issue"><Tag kind={i.level === "blocker" ? "warn" : ""}>{i.level === "blocker" ? "blocks" : "note"}</Tag><span>{i.text}</span></div>)}</div> : null}
    <Tiles items={[{ n: tiles.people, word: "people" }, { n: tiles.in_flight, word: "in flight", kind: "h" }, { n: tiles.finished, word: "finished" }, { n: tiles.needs_hand, word: tiles.needs_hand === 1 ? "needs a hand" : "need a hand", kind: "f" }]} />
    <Sec small="tap a step for what it does and the words it sends">The flow</Sec>
    {chart ? <><FlowChart chart={chart} onOpen={(nid, el) => setPop({ id: nid, el })} /><Legend /></> : <div className="issue"><Tag kind="warn">needs reinstall</Tag><span>This workflow's stored definition no longer runs on the current engine. {w.parse_error}</span></div>}
    <Sec small={runs.length === 100 ? "the latest 100" : undefined}>Who went through it</Sec>
    {runs.length === 0 ? <Empty>Nobody yet.</Empty> : <div className="rows">{runs.map((r) => <button key={r.id} type="button" className="row" onClick={(e) => setRow({ r, el: e.currentTarget })}>
      <Ic state={r.state} />
      <span className="mid"><span className="nm">{r.who}</span><Strip path={r.path} note={r.at} /></span>
      <span className="d tnum">{shortDate(r.started_at, co.timezone)}</span>
    </button>)}</div>}
    {pop && chart ? <Sheet anchor={pop.el} onClose={() => setPop(null)}><NodeWords chart={chart} id={pop.id} /></Sheet> : null}
    {row ? <Sheet anchor={row.el} onClose={() => setRow(null)}><RunSheet r={row.r} tz={co.timezone} slug={slug} /></Sheet> : null}
  </>;
}

/** A person's run, in brief: the steps as a list, then the way to the run and the contact. The full feed with words is the run page. */
function RunSheet({ r, tz, slug }: { r: RunListRow; tz: string; slug: string }) {
  const q = usePage<import("~/api").RunPage>(["run", r.id], `/api/v1/runs/${r.id}`, { every: 30_000 });
  return <>
    <h4>{r.who}</h4>
    <p className="m">{r.at} · started {shortDate(r.started_at, tz)}{q.data?.run.appointment ? ` · call ${shortDate(q.data.run.appointment.starts_at, tz)}` : ""}</p>
    {q.data ? <Steps items={[...q.data.feed, ...q.data.next]} tz={tz} /> : <Skeleton />}
    <div className="foot"><Link className="btn" to={`/app/c/${slug}/r/${r.id}`}>Open this run</Link>{r.contact_id ? <Link className="btn" to={`/app/c/${slug}/contacts/${r.contact_id}`}>Open the contact</Link> : null}</div>
  </>;
}
