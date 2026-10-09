import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Chart, PathItem } from "~/api";
import { Check, Clock, Cond, Skip, Warn } from "./icons";

/**
 * The flow chart (design guide §5): one vertical spine, every step its own node, the fork's outcomes as labelled groups
 * side by side, the groups that carry on curving back to the spine. Drawn by us, as SVG, from the chart words the API
 * sends. With a run's states, each node wears a small badge and the nodes not reached dim. Groups wrap into rows when
 * the container is narrow, so nothing scrolls sideways. On a phone with a run shown, only the path taken is drawn.
 */
type N = Chart["nodes"][number]; type St = PathItem["state"];
type Item = { id: string; n: N; waits?: string; cond?: string; outcomes?: { label: string; to: string }[] };
type Group = { label: string; items: Item[]; go: boolean; first: string | null };
type Row = { kind: "nodes"; items: Item[] } | { kind: "fork"; fork: Item; groups: Group[] };

const T = (k: string) => `var(--${k})`;
const TEXT_W = 7, PAD = 30, H = 34, GAP = 52;
const widthOf = (it: Item, max: number) => Math.min(max, Math.max(it.n.kind === "end" ? 64 : 96, Math.round(labelOf(it).length * TEXT_W + PAD + (it.waits ? 18 : 0) + (it.cond ? 18 : 0))));
const labelOf = (it: Item) => it.n.title + (it.n.meta && it.n.kind !== "send" ? ` · ${it.n.meta}` : "") + (it.waits ? ` · ${it.waits}` : "");
const trunc = (s: string, w: number) => { const max = Math.floor((w - PAD) / TEXT_W); return s.length > max ? `${s.slice(0, Math.max(3, max - 1))}…` : s; };

/** Read the chart into rows: straight runs of nodes, and forks with their groups. */
export function arrange(chart: Chart): Row[] {
  const byId = new Map(chart.nodes.map((n) => [n.id, n]));
  const outs = (id: string) => chart.edges.filter((e) => e.from === id);
  const ins = (id: string) => chart.edges.filter((e) => e.to === id);
  const hidden = new Set(chart.nodes.filter((n) => n.hidden).map((n) => n.id));
  const skip = (id: string): string => { let cur = id; for (let i = 0; i < 10 && hidden.has(cur); i++) { const o = outs(cur)[0]; if (!o) break; cur = o.to; } return cur; };
  // one item per visible node; a wait followed by one send folds into that send (a clock on the node)
  const folded = new Set<string>();
  const item = (id: string): Item => {
    const n = byId.get(id)!; const it: Item = { id, n };
    if (n.kind === "wait") { const o = outs(id); if (o.length === 1) { const nx = byId.get(skip(o[0].to)); if (nx && nx.kind === "send" && ins(nx.id).length === 1) { folded.add(id); return { id: nx.id, n: nx, waits: n.title, cond: nx.cond }; } } }
    if (n.cond && n.kind === "send") it.cond = n.cond;
    return it;
  };
  const rows: Row[] = []; const seen = new Set<string>();
  const trigs = chart.nodes.filter((n) => n.kind === "trig");
  let cur: string | null = null; let line: Item[] = [];
  if (trigs.length) { line.push(...trigs.map((t) => ({ id: t.id, n: t }))); trigs.forEach((t) => seen.add(t.id)); const firsts = new Set(trigs.map((t) => skip(outs(t.id)[0]?.to ?? ""))); cur = firsts.size === 1 ? [...firsts][0] : null; }
  const flush = () => { if (line.length) { rows.push({ kind: "nodes", items: line }); line = []; } };
  let guard = 0;
  while (cur && !seen.has(cur) && guard++ < 200) {
    const n = byId.get(cur); if (!n) break;
    seen.add(cur);
    const o = outs(cur).map((e) => ({ ...e, to: skip(e.to) }));
    // a conditional send: a branch with one "when" to a single step that rejoins where "otherwise" goes; a wait right before it folds in
    const condOf = (forkId: string): { step: N; cond: string; next: string } | null => {
      const f = byId.get(forkId); if (!f || f.kind !== "fork") return null;
      const fo = outs(forkId).map((e) => ({ ...e, to: skip(e.to) })); if (fo.length !== 2 || !fo.some((e) => e.else) || !fo.some((e) => !e.else)) return null;
      const yes = fo.find((e) => !e.else)!, no = fo.find((e) => e.else)!; const step = byId.get(yes.to); const after = step ? outs(step.id).map((e) => skip(e.to)) : [];
      return step && after.length === 1 && after[0] === no.to ? { step, cond: `Only when ${yes.label}`, next: no.to } : null;
    };
    if (n.kind === "fork") { const c = condOf(cur); if (c) { seen.add(c.step.id); line.push({ id: c.step.id, n: c.step, cond: c.cond }); cur = c.next; continue; } }
    if (n.kind === "wait" && o.length === 1) { const c = condOf(o[0].to); if (c) { seen.add(o[0].to); seen.add(c.step.id); line.push({ id: c.step.id, n: c.step, cond: c.cond, waits: n.title }); cur = c.next; continue; } }
    // a reply-wait with a timeout edge: the fork after the reply takes "No reply" as one more way out
    if (n.kind === "reply" && o.length === 2) {
      const replied = o.find((e) => e.label !== "no reply in time") ?? o[0], timeout = o.find((e) => e.label === "no reply in time");
      const forkId = skip(replied.to); const fork = byId.get(forkId);
      if (fork && fork.kind === "fork" && timeout) {
        line.push(item(cur)); flush(); seen.add(forkId);
        const ways = [...outs(forkId).map((e) => ({ label: e.label || "otherwise", to: skip(e.to) })), { label: "No reply", to: timeout.to }];
        const { groups, join } = groupsOf(ways);
        rows.push({ kind: "fork", fork: { id: forkId, n: fork, outcomes: ways }, groups }); cur = join; continue;
      }
    }
    if (o.length > 1) {
      flush();
      const ways = o.map((e) => ({ label: e.label || "otherwise", to: e.to }));
      const { groups, join } = groupsOf(ways);
      const last = line; void last;
      rows.push({ kind: "fork", fork: { id: cur, n, outcomes: ways }, groups }); cur = join; continue;
    }
    const it = item(cur);
    line.push(it);
    // a folded wait+send: carry on from after the send
    if (it.id !== cur) { seen.add(it.id); const after = outs(it.id).map((e) => skip(e.to)); cur = after[0] ?? null; continue; }
    cur = o[0] ? o[0].to : null;
  }
  flush();
  return rows;

  function groupsOf(ways: { label: string; to: string }[]): { groups: Group[]; join: string | null } {
    // each way's chain until the first node another way also reaches: that node is the join and the spine goes on from it
    const chains = ways.map((w) => { const c: string[] = []; let id: string | null = w.to; const s = new Set<string>(); for (let i = 0; id && i < 40 && !s.has(id); i++) { s.add(id); c.push(id); const nn = byId.get(id); if (!nn || nn.kind === "end") break; const oo: string[] = outs(id).map((e) => skip(e.to)); if (oo.length !== 1) break; id = oo[0]; } return c; });
    const count = new Map<string, number>(); for (const c of chains) for (const id of new Set(c)) count.set(id, (count.get(id) ?? 0) + 1);
    let join: string | null = null;
    for (const c of chains) { const j = c.find((id) => (count.get(id) ?? 0) > 1); if (j && (!join || c.indexOf(j) < c.indexOf(join))) join = j; }
    const groups: Group[] = ways.map((w, i) => { const c = chains[i]; const upto = join ? c.indexOf(join) : -1; const ids = upto >= 0 ? c.slice(0, upto) : c; ids.forEach((id) => seen.add(id)); const items = ids.map(item); return { label: w.label.replace(/^the reply is (a )?/i, "").replace(/[“”"]/g, "").replace(/^./, (ch) => ch.toUpperCase()), items, go: upto >= 0, first: ids[0] ?? null }; });
    return { groups, join };
  }
}

export function FlowChart({ chart, states, pathOnly, onOpen }: { chart: Chart; states?: Record<string, St>; pathOnly?: boolean; onOpen?: (id: string, el: SVGGElement) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setWidth(el.clientWidth || 600)); ro.observe(el); setWidth(el.clientWidth || 600); return () => ro.disconnect(); }, []);
  const rows = useMemo(() => arrange(chart), [chart]);
  const stateOf = (id: string): St | null => states ? states[id] ?? (Object.keys(states).length ? "next" : null) : null;
  const svg = useMemo(() => draw(rows, width, stateOf, !!pathOnly && !!states), [rows, width, states, pathOnly]);
  return <div className="chart" ref={box} onClick={(e) => { const g = (e.target as Element).closest("g.nd") as SVGGElement | null; if (g && onOpen) onOpen(g.dataset.id!, g); }}
    dangerouslySetInnerHTML={{ __html: svg }} />;
}

function draw(rows: Row[], W: number, stateOf: (id: string) => St | null, pathOnly: boolean): string {
  const out: string[] = []; const x = W / 2; let y = 30;
  const maxNodeW = Math.min(300, W - 24);
  let prevBottom: number | null = null;
  const link = (x1: number, y1: number, x2: number, y2: number) => { const my = (y1 + y2) / 2; out.push(`<path d="M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}" fill="none" stroke="${T("edge")}" stroke-width="1.6"/>`); };
  for (const row of rows) {
    if (row.kind === "nodes") {
      // triggers side by side when there are several; everything else down the spine
      const trigs = row.items.filter((it) => it.n.kind === "trig"); const rest = row.items.filter((it) => it.n.kind !== "trig");
      if (trigs.length > 1) { const w = Math.min(maxNodeW, (W - 24 - (trigs.length - 1) * 12) / trigs.length); const total = trigs.length * w + (trigs.length - 1) * 12; let tx = x - total / 2 + w / 2; const ys = y; for (const it of trigs) { out.push(node(it, tx, ys, w, stateOf(it.id))); link(tx, ys + H / 2, x, ys + GAP - H / 2); tx += w; tx += 12; } y += GAP; prevBottom = y - GAP + H / 2; prevBottom = null; }
      else if (trigs.length === 1) { const it = trigs[0]; if (prevBottom !== null) link(x, prevBottom, x, y - H / 2); out.push(node(it, x, y, widthOf(it, maxNodeW), stateOf(it.id))); prevBottom = y + H / 2; y += GAP; }
      for (const it of rest) { if (prevBottom !== null) link(x, prevBottom, x, y - H / 2); out.push(node(it, x, y, widthOf(it, maxNodeW), stateOf(it.id))); prevBottom = y + H / 2; y += GAP; }
      if (trigs.length > 1 && !rest.length) prevBottom = y - GAP + H / 2;
      continue;
    }
    // the fork node, then its groups in rows that fit the width
    const f = row.fork; if (prevBottom !== null) link(x, prevBottom, x, y - H / 2);
    out.push(node(f, x, y, widthOf(f, maxNodeW), stateOf(f.id))); const forkBottom = y + H / 2; y += GAP + 10;
    let groups = row.groups;
    if (pathOnly) { const taken = groups.filter((g) => g.first && stateOf(g.first) && stateOf(g.first) !== "next"); if (taken.length) groups = taken; }
    const gap = 14; const minG = 130;
    const fit = Math.max(1, Math.min(groups.length, Math.floor((W - 16 + gap) / (minG + gap))));
    const rowsN = Math.ceil(groups.length / fit); const perRow = Math.ceil(groups.length / rowsN);   // 5 groups on a laptop: 3 + 2, not 4 + 1
    const colW = Math.min(190, (W - 16 - (perRow - 1) * gap) / perRow);
    const bottoms: { x: number; y: number; go: boolean }[] = [];
    let from = forkBottom;
    for (let r = 0; r < groups.length; r += perRow) {
      const slice = groups.slice(r, r + perRow); const total = slice.length * colW + (slice.length - 1) * gap; let gx = x - total / 2 + colW / 2;
      const gh = 28 + Math.max(1, ...slice.map((g) => g.items.length)) * GAP - 18;
      if (r) { out.push(`<path d="M${x} ${from} V${y - 12}" fill="none" stroke="${T("edge")}" stroke-width="1.6"/>`); from = y - 12; }
      for (const g of slice) {
        const on = g.first ? stateOf(g.first) : null; const lit = on && on !== "next";
        out.push(`<rect x="${gx - colW / 2}" y="${y}" width="${colW}" height="${28 + Math.max(1, g.items.length) * GAP - 18}" rx="12" fill="${T("panel")}" stroke="${lit ? T("acc") : T("line")}" stroke-width="1.5"/>`);
        out.push(`<text class="cap" x="${gx}" y="${y + 16}" text-anchor="middle" fill="${lit ? T("acc") : T("fg-3")}">${esc(trunc(g.label.toUpperCase(), colW + 10))}</text>`);
        link(x, from, gx, y);
        let yy = y + 42;
        if (!g.items.length) out.push(`<text class="lbl" x="${gx}" y="${yy + 4}" text-anchor="middle">carries on</text>`);
        for (let i = 0; i < g.items.length; i++) { const it = g.items[i]; if (i) link(gx, yy - GAP + H / 2, gx, yy - H / 2); out.push(node(it, gx, yy, Math.min(widthOf(it, colW - 16), colW - 16), stateOf(it.id))); yy += GAP; }
        bottoms.push({ x: gx, y: y + 28 + Math.max(1, g.items.length) * GAP - 18, go: g.go });
        gx += colW + gap;
      }
      y += gh + 24; from = y - 24;
    }
    const goes = bottoms.filter((b) => b.go);
    if (goes.length) { y += 14; for (const b of goes) link(b.x, b.y, x, y - H / 2); prevBottom = null; }
    else prevBottom = null;
  }
  const Hh = Math.max(y - GAP + H / 2 + 20, 80);
  return `<svg viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" role="img" aria-label="Flow chart">${out.join("")}</svg>`;
}

function node(it: Item, x: number, y: number, w: number, st: St | null): string {
  const k = it.n.kind; const top = y - H / 2;
  const fill = k === "trig" ? T("acc") : k === "end" ? "none" : k === "fork" ? T("panel-3") : T("panel-2");
  const stroke = k === "trig" ? T("acc") : k === "end" ? T("fg-3") : T("edge"); const ink = k === "trig" ? T("acc-ink") : k === "end" ? T("fg-2") : T("fg");
  const dim = st === "skip" || st === "next"; const op = dim ? (st === "skip" ? 0.5 : 0.45) : 1;
  let g = `<g class="nd" tabindex="0" data-id="${it.id}" style="opacity:${op}"><rect class="b" x="${x - w / 2}" y="${top}" width="${w}" height="${H}" rx="${k === "end" ? 17 : 9}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  let tx = x - w / 2 + 14;
  if (it.waits) { g += `<g transform="translate(${tx - 2},${y - 8}) scale(.8)" style="color:${T("fg-2")}">${svgIcon("clock")}</g>`; tx += 18; }
  const label = trunc(labelOf(it), w - (it.waits ? 18 : 0) - (it.cond ? 18 : 0));
  g += `<text x="${tx}" y="${y + 4.5}" fill="${ink}">${esc(label)}</text>`;
  if (it.cond) g += `<g transform="translate(${x + w / 2 - 26},${y - 8}) scale(.8)" style="color:${T("cond")}">${svgIcon("cond")}</g>`;
  if (st && st !== "next") { const col = st === "ok" ? T("ok") : st === "here" ? T("wait") : st === "skip" ? T("cond") : st === "warn" ? T("warn") : T("fg-3"); const bg = st === "ok" ? T("ok-bg") : st === "here" ? T("wait-bg") : st === "skip" ? T("cond-bg") : st === "warn" ? T("warn-bg") : T("panel-3");
    g += `<g transform="translate(${x + w / 2 - 10},${top - 10})"><circle cx="10" cy="10" r="10" fill="${bg}"/><g style="color:${col}" transform="translate(3,3) scale(.7)">${svgIcon(st === "ok" ? "check" : st === "here" ? "clock" : st === "skip" ? "skip" : st === "warn" ? "warn" : "stop")}</g></g>`; }
  return g + "</g>";
}
const svgIcon = (k: string) => ({
  check: '<path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  clock: '<circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 6v4.5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  warn: '<path d="M10 3l8 14H2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10 9v3.5M10 14.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  cond: '<path d="M6 4v12M6 8c0 3 8 1 8 5M14 13l-2-2M14 13l2-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  skip: '<circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 10h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  stop: '<rect x="5" y="5" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>',
}[k] ?? "");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** The popover for a node: what it does, its condition in blue, the words it sends, its state on this run. */
export function NodeWords({ chart, id, state, extra }: { chart: Chart; id: string; state?: St | null; extra?: ReactNode }) {
  const n = chart.nodes.find((x) => x.id === id); if (!n) return null;
  const w = { ok: "Done", here: "Waiting here", warn: "Failed", skip: "Skipped: the condition said no", next: "Not reached", stop: "Stopped" }[state ?? "next"];
  return <>
    <h4>{n.title}{n.meta ? <span style={{ color: "var(--fg-2)", fontWeight: 500 }}> · {n.meta}</span> : null}</h4>
    {n.detail ? <p className="m">{n.detail}</p> : null}
    {n.kind === "fork" ? <p className="m">{chart.edges.filter((e) => e.from === id).map((e) => e.label || "otherwise").join(" · ")}</p> : null}
    {n.cond ? <div className="c"><Cond /><span>{n.cond}</span></div> : null}
    {n.quote ? <div className="q">{n.quote}</div> : null}
    {state ? <div className={`st ${state}`}>{state === "ok" ? <Check /> : state === "here" ? <Clock /> : state === "warn" ? <Warn /> : <Skip />}{w}</div> : null}
    {extra}
  </>;
}

/** The legend under a chart. */
export const Legend = ({ run }: { run?: boolean }) => <div className="legend">
  {run ? <><span style={{ color: "var(--ok)" }}><Check />done</span><span style={{ color: "var(--wait)" }}><Clock />waiting here</span><span style={{ color: "var(--cond)" }}><Skip />skipped by a condition</span><span style={{ color: "var(--warn)" }}><Warn />failed</span></> : <><span style={{ color: "var(--fg-2)" }}><Clock />waits first</span><span style={{ color: "var(--cond)" }}><Cond />only sometimes</span></>}
</div>;
