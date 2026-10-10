import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, usePage, useAction, type WorkflowPage, type RunListRow, type RunPage } from "~/api";
import { Crumb, Empty, Ic, NameLine, Sec, Sheet, Skeleton, Strip, Switch, Tag, Tiles, toast } from "~/ui/pieces";
import { FlowChart, Legend, NodeWords, RunNodeWords } from "~/ui/chart";
import { Ghost } from "~/ui/icons";
import { Title } from "~/ui/steps";
import { ago, callTime, shortDate, when } from "~/fmt";

export function Workflow() {
  const { slug = "", id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const sel = params.get("run");
  const [limit, setLimit] = useState(100);
  const key = ["workflow", id];
  const q = usePage<WorkflowPage>([...key, limit], `/api/v1/workflows/${id}${limit > 100 ? `?runs=${limit}` : ""}`, { keep: true });
  // the chosen person's run: the run page's own payload, so the chart wears exactly the states the run page draws
  const picked = usePage<RunPage>(["run", sel ?? ""], `/api/v1/runs/${sel}`, { enabled: !!sel, every: 30_000 });
  const flip = useAction<boolean>((enabled) => api(`/api/v1/workflows/${id}/enabled`, { method: "POST", json: { enabled } }), [key, ["company", slug]]);
  const fire = useAction<void, { note: string }>(() => api(`/api/v1/workflows/${id}/fire`, { method: "POST" }), [key]);
  const [pop, setPop] = useState<{ id: string; el: Element } | null>(null);
  const popOpen = useRef(false); popOpen.current = !!pop;
  const flow = useRef<HTMLDivElement>(null);
  const choose = (rid: string | null) => {
    setPop(null);
    setParams((p) => { const n = new URLSearchParams(p); if (rid) n.set("run", rid); else n.delete("run"); return n; }, { replace: true });
    if (rid) requestAnimationFrame(() => flow.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  useEffect(() => {
    if (!sel) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !popOpen.current) choose(null); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [sel]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={8} />;
  const { company: co, workflow: w, tiles, chart, runs, ready } = q.data;
  const control = <Switch big word on={w.enabled} label="On or off" onChange={async (next) => { try { await flip.mutateAsync(next); } catch (e) { toast((e as Error).message, true); throw e; } }} />;
  const run = sel && picked.data && picked.data.run.id === sel ? picked.data : null;
  const shown = run?.chart ?? chart;
  const narrow = typeof window !== "undefined" && window.innerWidth < 700;
  const listStates = new Set(runs.flatMap((r) => r.path.map((p) => p.state)));
  return <>
    <Crumb items={[{ to: `/app/c/${slug}`, label: co.name }]} />
    <NameLine name={w.name} control={control} />
    <div className="tagline">{w.stage ? <Tag>{w.stage.replace(/_/g, "-")}</Tag> : null}{w.origin === "spec" ? <Tag kind="spec">your spec</Tag> : <Tag kind="def">default</Tag>}{co.mode === "shadow" ? <Tag kind="shadow">shadow</Tag> : null}{!ready.ready ? <Tag kind="warn">{ready.missing.length ? `missing ${ready.missing.join(", ")}` : ready.gaps.length ? "not built yet" : "needs reinstall"}</Tag> : null}<span>{w.last_ran ? `last ran ${ago(w.last_ran)}` : "never ran"}</span>{w.schedule ? <><span>·</span><span>{w.schedule}</span>{w.enabled ? <button type="button" className="btn" style={{ padding: "3px 10px", fontSize: 12 }} disabled={fire.isPending} onClick={async () => { try { const r = await fire.mutateAsync(); toast(r.note); } catch (e) { toast((e as Error).message, true); } }}>Run now</button> : null}</> : null}</div>
    {w.description ? <p className="desc">{w.description}</p> : null}
    {ready.gaps.length || ready.issues.length ? <div style={{ marginTop: 10 }}>{[...ready.gaps.map((g) => ({ level: "warning", text: g })), ...ready.issues].map((i, k) => <div key={k} className="issue"><Tag kind={i.level === "blocker" ? "warn" : ""}>{i.level === "blocker" ? "blocks" : "note"}</Tag><span>{i.text}</span></div>)}</div> : null}
    <Tiles items={[{ n: tiles.people, word: "people" }, { n: tiles.in_flight, word: "in flight", kind: "h" }, { n: tiles.finished, word: "finished" }, { n: tiles.needs_hand, word: tiles.needs_hand === 1 ? "needs a hand" : "need a hand", kind: "f" }]} />
    <div ref={flow} className="flowtop">
      <Sec small={sel ? "tap a step for what happened there" : "tap a step for what it does and the words it sends"}>The flow</Sec>
      {sel ? <Picked sel={sel} row={runs.find((r) => r.id === sel) ?? null} page={run} error={picked.error?.message ?? null} tz={co.timezone} slug={slug} onClear={() => choose(null)} /> : null}
    </div>
    {shown ? <><FlowChart chart={shown} states={run?.states} pathOnly={!!run && narrow} onOpen={(nid, el) => setPop({ id: nid, el })} /><Legend run={!!run} states={run ? Object.values(run.states) : listStates} /></> : <div className="issue"><Tag kind="warn">needs reinstall</Tag><span>This workflow's stored definition no longer runs on the current engine. {w.parse_error}</span></div>}
    <Sec small={runs.length ? "latest first · tap someone to see their path on the chart" : undefined}>Who went through it</Sec>
    {runs.length === 0 ? <Empty>Nobody yet.</Empty> : <>
      <div className="rows">{runs.map((r) => <RunRow key={r.id} r={r} tz={co.timezone} on={r.id === sel} onPick={() => choose(r.id)} />)}</div>
      <p className="listend tnum">Showing {runs.length} of {Math.max(tiles.people, runs.length)}{runs.length < tiles.people ? <> · <button type="button" className="lnk" disabled={q.isFetching} onClick={() => setLimit((l) => Math.min(1000, l + 100))}>{q.isFetching && q.isPlaceholderData ? "loading…" : "load more"}</button></> : null}</p>
    </>}
    {pop && shown ? <Sheet anchor={pop.el} onClose={() => setPop(null)}>{run ? <RunNodeWords chart={shown} id={pop.id} states={run.states} feed={run.feed} /> : <NodeWords chart={shown} id={pop.id} />}</Sheet> : null}
  </>;
}

const inShadow = (path: { state: string }[]) => path.some((p) => p.state === "ghost");

function RunRow({ r, tz, on, onPick }: { r: RunListRow; tz: string; on: boolean; onPick: () => void }) {
  return <button type="button" className={`row ${on ? "sel" : ""}`} aria-pressed={on} onClick={onPick}>
    <Ic state={r.state} />
    <span className="mid"><span className="nm">{r.who}</span><Strip path={r.path} note={r.at} /></span>
    <span className="d tnum">{shortDate(r.started_at, tz)}{inShadow(r.path) ? <small className="sh"><Ghost />in shadow</small> : null}</span>
  </button>;
}

/**
 * The bar above the chart while a person's run is shown: whose run, when, how it ended, the steps that did not fire and
 * why, and the ways out (the full run, the contact, back to the plain chart).
 */
function Picked({ sel, row, page, error, tz, slug, onClear }: { sel: string; row: RunListRow | null; page: RunPage | null; error: string | null; tz: string; slug: string; onClear: () => void }) {
  const who = page?.run.who ?? row?.who;
  const steps: { state: string; title: string; meta?: string; note?: string }[] = page?.feed ?? row?.path ?? [];
  const ghost = inShadow(steps);
  const at = page?.run.at ?? row?.at ?? "";
  const status = ghost ? (at.startsWith("done") ? at.replace(/^done/, "done in shadow") : `${at} · in shadow`) : at;
  const missed = steps.filter((s) => s.state === "skip" || s.state === "blocked" || s.state === "warn" || s.state === "stop");
  const appt = page?.run.appointment;
  const contact = page?.run.contact_id ?? row?.contact_id;
  return <div className={`picked ${ghost ? "ghost" : ""}`} role="status">
    <div className="ph">
      <span className="what">{who ? <><b>Showing {who}'s run</b>{page || row ? <> · {when(page?.run.started_at ?? row?.started_at, tz)}</> : null}{status ? <> · <span className="stt">{ghost ? <Ghost /> : null}{status}</span></> : null}</> : error ? <b>That run could not be loaded: {error}</b> : <b>Loading the run…</b>}</span>
      <span className="acts"><Link className="btn" to={`/app/c/${slug}/r/${sel}`}>Open the full run</Link>{contact ? <Link className="btn" to={`/app/c/${slug}/contacts/${contact}`}>Open the contact</Link> : null}<button type="button" className="btn" onClick={onClear} title="Back to the plain chart (Esc)">Clear</button></span>
    </div>
    {appt ? <p className="m">Call {callTime(appt.starts_at, tz)}{appt.closer ? ` with ${appt.closer}` : ""}{appt.status !== "confirmed" && appt.status !== "booked" ? ` (${appt.status})` : ""}</p> : null}
    {missed.length ? <ul className="missed">{missed.slice(0, 6).map((s, i) => <li key={i}><Ic state={s.state} /><span><b><Title text={s.title + (s.meta ? ` · ${s.meta}` : "")} /></b> <span className={`w ${s.state}`}>{s.state === "skip" ? "skipped" : s.state === "blocked" ? "did not go out" : s.state === "warn" ? "failed" : "stopped"}</span>{s.note ? `: ${s.note.replace(/^Didn't go out: /, "")}` : ""}</span></li>)}{missed.length > 6 ? <li className="m">and {missed.length - 6} more on the full run</li> : null}</ul> : page || row ? <p className="m">Every step it reached ran{ghost ? ", in shadow" : ""}.</p> : null}
  </div>;
}
