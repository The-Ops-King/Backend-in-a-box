import { SlackMsg } from "./slack";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Chart, PathItem } from "~/api";
import { Title } from "./steps";
import { Check, Clock, Cond, Ghost, Skip, Warn, stateIcon } from "./icons";
import { STATE_ORDER, STATE_WORDS } from "./pieces";
import { arrange } from "@/chart/arrange";
import { pickLayout, tidyView, type Picked } from "@/chart/pick";
import type { St } from "@/chart/draw";

/**
 * The flow chart (design guide §5): one vertical spine, every step its own node, the fork's outcomes as labelled groups
 * side by side, the groups that carry on curving back to the spine. Drawn by us, as SVG, from the chart words the API
 * sends. A group is drawn like the spine (D107): a fork inside it gets its own groups inside it. With a run's states,
 * each node wears a small badge and the nodes not reached dim. Groups that do not fit side by side stack in one column,
 * so nothing scrolls sideways. On a phone with a run shown, only the path taken is drawn, and the page says so above it
 * with a way to show every step. The layout is arrange.ts, the drawing draw.ts (pure, shared with the server).
 * D111: the tidy layout is drawn only when it is exactly the workflow (exact.ts); otherwise the workflow is drawn as a
 * plain graph (ELK), and if even that is not exact, its steps are listed in order under a red line.
 */
export function FlowChart({ chart, states, pathOnly, onOpen }: { chart: Chart; states?: Record<string, St>; pathOnly?: boolean; onOpen?: (id: string, el: Element) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setWidth(el.clientWidth || 600)); ro.observe(el); setWidth(el.clientWidth || 600); return () => ro.disconnect(); }, []);
  // the page refetches the same chart and states as new objects: lay out again only when they changed
  const sig = useMemo(() => JSON.stringify(chart), [chart]);
  const stKey = useMemo(() => JSON.stringify(states ?? null), [states]);
  // a run's path alone (a phone with a run) is a view the page says it is, with a way to show every step
  const [all, setAll] = useState(false);
  const stateOf = (id: string): St | null => states ? states[id] ?? (Object.keys(states).length ? "next" : null) : null;
  const view = { width, stateOf, pathOnly: !!pathOnly && !!states && !all };
  const rows = useMemo(() => arrange(chart), [sig]);   // eslint-disable-line react-hooks/exhaustive-deps
  const tidy = useMemo(() => tidyView(chart, rows, view), [rows, width, stKey, view.pathOnly]);   // eslint-disable-line react-hooks/exhaustive-deps
  const tidyOk = tidy.tidy.exact && tidy.shown.check.exact;
  const [later, setLater] = useState<{ key: string; p: Picked } | null>(null);
  const key = `${sig}|${width}|${stKey}`;
  useEffect(() => {
    if (tidyOk) return;
    let live = true;
    pickLayout(chart, view).then((p) => { if (live) setLater({ key, p }); });
    return () => { live = false; };
  }, [key, tidyOk]);   // eslint-disable-line react-hooks/exhaustive-deps
  // a graph laid out for the last width or run stays up until the new one is ready
  const p: Picked | null = tidyOk ? { layout: "tidy", rows, ...tidy } : later && later.key.startsWith(`${sig}|`) ? later.p : null;
  const out = p && p.layout !== "list" ? p.shown : null;
  // a graph too wide to read at phone width pans in its own box, opened where the run starts
  const pane = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (out?.pan && pane.current) pane.current.scrollLeft = Math.max(0, (out.start ?? 0) - pane.current.clientWidth / 2); }, [out]);
  const open = (e: { target: EventTarget }) => { const g = (e.target as Element).closest("[data-id]") as HTMLElement | SVGGElement | null; if (g && onOpen) onOpen(g.dataset.id!, g); };
  return <div ref={box} onClick={open}>
    {p?.layout === "graph" ? <p className="chnote">Drawn as a plain graph: this workflow's shape is beyond the tidy chart.{out?.pan ? " Drag it sideways to see all of it." : ""}</p> : null}
    {out?.check.filtered ? <p className="chnote">Showing only the path this run took. <button type="button" className="lnk" onClick={(e) => { e.stopPropagation(); setAll(true); }}>Show every step</button></p> : null}
    {p?.layout === "list" ? <StepList chart={chart} stateOf={stateOf} /> : out ? <div ref={pane} className={`chart${out.pan ? " pan" : ""}`} dangerouslySetInnerHTML={{ __html: out.svg }} /> : <p className="chnote">Drawing the chart…</p>}
  </div>;
}

/**
 * The last resort (D111): no layout draws this workflow exactly, so nothing is drawn as a chart; every step is listed in the
 * order a run meets it, each with where it goes next and on what.
 */
function StepList({ chart, stateOf }: { chart: Chart; stateOf: (id: string) => St | null }) {
  const byId = new Map(chart.nodes.map((n) => [n.id, n]));
  const order: string[] = []; const seen = new Set<string>(); const q = chart.nodes.filter((n) => n.kind === "trig").map((n) => n.id);
  while (q.length) { const id = q.shift()!; if (seen.has(id)) continue; seen.add(id); order.push(id); for (const e of chart.edges) if (e.from === id) q.push(e.to); }
  for (const n of chart.nodes) if (!seen.has(n.id)) order.push(n.id);
  return <div className="chlist">
    <p className="chbad">This workflow could not be drawn exactly as a chart, so every step is listed in order with where it goes next.</p>
    <ol>{order.map((id) => { const n = byId.get(id)!; const st = stateOf(id); const outs = chart.edges.filter((e) => e.from === id);
      return <li key={id} data-id={id} className={n.helper ? "hp" : undefined}>
        <span className="t">{n.title}{n.meta ? <small> · {n.meta}</small> : null}{st && st !== "next" ? <small className={`st ${st}`}> · {STATE_WORDS[st] ?? st}</small> : null}</span>
        {n.onlyIf ? <small className="if">only if {n.onlyIf}; otherwise skipped</small> : null}
        {outs.length ? <ul>{outs.map((e, i) => <li key={i}>{e.label ? `${e.label}: ` : ""}then “{byId.get(e.to)?.title ?? e.to}”</li>)}</ul> : <ul><li>the run ends here</li></ul>}
      </li>; })}</ol>
  </div>;
}

/** The popover for a node: what it does, its condition in blue, the words it sends, its state on this run. */
export function NodeWords({ chart, id, state, extra }: { chart: Chart; id: string; state?: St | null; extra?: ReactNode }) {
  const n = chart.nodes.find((x) => x.id === id); if (!n) return null;
  const w = { ok: "Done", ghost: "Done in shadow: nothing written or sent", here: "Waiting here", warn: "Failed", skip: "Skipped: its condition was not met", blocked: "Blocked: it did not go out", next: "Not reached", stop: "Stopped" }[state ?? "next"];
  return <>
    <h4><Title text={n.title} />{n.meta ? <span style={{ color: "var(--fg-2)", fontWeight: 500 }}> · {n.meta}</span> : null}</h4>
    {n.detail ? <p className="m">{n.detail}</p> : null}
    {n.kind === "fork" ? <p className="m">{chart.edges.filter((e) => e.from === id).map((e) => e.label || "otherwise").join(" · ")}</p> : null}
    {n.cond ? <div className="c"><Cond /><span>{n.cond}{n.onlyIf ? ". Otherwise it is skipped and the run goes on." : null}</span></div> : null}
    {n.quote ? (n.channel === "slack" ? <SlackMsg face={n.face} text={n.quote} time="9:41 AM" thread={n.thread} reaction={n.react} offers={n.offer} /> : <div className="q">{n.quote}</div>) : null}
    {state ? <div className={`st ${state}`}>{state === "ok" ? <Check /> : state === "ghost" ? <Ghost /> : state === "here" ? <Clock /> : state === "warn" ? <Warn /> : <Skip />}{w}</div> : null}
    {extra}
  </>;
}
/** A node's popover on a chart drawn with one run: its words, its state on that run, and what the run noted there (the note, the words it sent). */
export function RunNodeWords({ chart, id, states, feed }: { chart: Chart; id: string; states: Record<string, St>; feed: PathItem[] }) {
  const f = [...feed].reverse().find((x) => x.node_id === id);
  return <NodeWords chart={chart} id={id} state={states[id] ?? "next"} extra={<>{f?.note ? <p className="m" style={{ marginTop: 8 }}>{f.note}</p> : null}{f?.words ? <div className="q">{f.words}</div> : null}</>} />;
}

const STATE_INK: Record<string, string> = { ok: "ok", ghost: "ok", skip: "cond", blocked: "warn", here: "wait", warn: "warn", stop: "fg-3", next: "fg-3" };
/**
 * The legend under a chart: the chart's own marks (without a run), then every state the bars and the run badges use that
 * is on the page, each with the bar's swatch and the badge's mark in the same colour.
 */
export function Legend({ run, states }: { run?: boolean; states?: Iterable<string> }) {
  const on = new Set(states ?? STATE_ORDER); on.add("ok");
  const keys = STATE_ORDER.filter((k) => on.has(k) || (k === "next" && run));
  return <div className="legend">
    {run ? null : <><span style={{ color: "var(--fg-2)" }}><i className="hp" aria-hidden />behind the scenes: a wait, a read, a value kept</span><span style={{ color: "var(--cond)" }}><i className="dash" aria-hidden />only if …, otherwise skipped</span><span style={{ color: "var(--cond)" }}><Cond />may be skipped</span><span className="sep" aria-hidden /></>}
    {keys.map((k) => <span key={k} className="key" style={{ color: `var(--${STATE_INK[k]})` }}><i className={`swa ${k}`} />{k === "next" ? null : stateIcon(k)}{STATE_WORDS[k]}</span>)}
  </div>;
}
