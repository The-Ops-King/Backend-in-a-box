import { SlackMsg, emoji } from "./slack";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Chart, PathItem } from "~/api";
import { Title } from "./steps";
import { Check, Clock, Cond, Ghost, Skip, Warn, stateIcon } from "./icons";
import { STATE_ORDER, STATE_WORDS } from "./pieces";

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
const TEXT_W = 7.6, PAD = 28, LINE = 16, VPAD = 9, H = 34, GAP = 18;
/** Width of a title in px at the node font (13px, 600): per-glyph so "Appointment matched?" is not measured like "little if". */
function tw(s: string, per = TEXT_W): number {
  let w = 0;
  for (const ch of s) w += /[ilj.,:;'|!]/.test(ch) ? 0.42 : /[ftrI ()\-]/.test(ch) ? 0.55 : /[mwMW]/.test(ch) ? 1.25 : /[A-Z]/.test(ch) ? 0.9 : /[0-9]/.test(ch) ? 0.78 : /[→‹›“”]/.test(ch) ? 0.9 : 0.74;
  return w * per / 0.72;   // the 600-weight face runs a touch wider than the per-glyph table
}
// :shortcodes: in the words (the emoji a step waits for) are drawn as the emoji, the way Slack shows them
const labelOf = (it: Item) => (it.n.title + (it.n.meta && it.n.kind !== "send" ? ` · ${it.n.meta}` : "") + (it.waits ? ` · ${it.waits}` : "")).replace(/:([a-z0-9_+-]+):/g, (m, code) => emoji(code) ?? m);
/** Words onto lines no wider than `max` characters; two lines wanted, three at most, nothing cut. */
function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/); const lines: string[] = []; let cur = "";
  const maxPx = max * TEXT_W;
  for (const w of words) { const next = cur ? `${cur} ${w}` : w; if (tw(next) <= maxPx || !cur) cur = next; else { lines.push(cur); cur = w; } }
  if (cur) lines.push(cur);
  const cut = (l: string) => { if (tw(l) <= maxPx) return l; let k = l.length; while (k > 3 && tw(`${l.slice(0, k)}…`) > maxPx) k--; return `${l.slice(0, k)}…`; };
  // four lines at most; past that the last line is cut with an ellipsis rather than spilling out of the box
  if (lines.length > 4) { const keep = lines.slice(0, 4); keep[3] = cut(keep[3]); return keep; }
  return lines.map(cut);
}
/** The lines a node shows and the box they need, within the width allowed. */
type Size = { lines: string[]; w: number; h: number; chips?: { text: string; stage: boolean }[] };
function sizeOf(it: Item, maxW: number): Size {
  const extra = (it.waits ? 22 : 0) + (it.cond ? 18 : 0) + (kindIconOf(it) ? 22 : 0);
  // “tags” and ‹stages› in the words become chips under the title
  const raw = labelOf(it); const found = raw.match(/“[^”]*”|‹[^›]*›/g);
  if (found) {
    const chips = found.flatMap((c) => { const text = c.slice(1, -1), stage = c.startsWith("‹"); if (stage && tw(text, 6.4) + 22 + PAD > maxW && text.includes(" → ")) { const [a, b] = text.split(" → "); return [{ text: `${a} →`, stage }, { text: b, stage }]; } return [{ text, stage }]; });
    const verb = raw.replace(/“[^”]*”|‹[^›]*›/g, "").replace(/\s*·\s*$/, "").replace(/,\s*/g, " ").replace(/\s+/g, " ").trim().replace(/ tag$/, chips.length > 1 ? " tags" : " tag");
    const maxChars = Math.max(8, Math.floor((maxW - PAD - extra) / TEXT_W));
    const lines = tw(verb) <= maxChars * TEXT_W ? [verb] : wrap(verb, maxChars);
    const w = Math.min(maxW, Math.max(96, Math.round(Math.max(...lines.map((l) => tw(l) + extra), ...chips.map((c) => tw(c.text, 6.4) + 22)) + PAD)));
    return { lines, chips, w, h: VPAD * 2 + lines.length * LINE + chips.length * 20 };
  }
  const label = raw; const maxChars = Math.max(8, Math.floor((maxW - PAD - extra) / TEXT_W));
  // two balanced lines when it does not fit on one; more only when it must
  let lines = tw(label) <= maxChars * TEXT_W ? [label] : wrap(label, Math.max(maxChars, Math.ceil(label.length / 2) + 2) <= maxChars ? Math.max(8, Math.ceil(label.length / 2) + 2) : maxChars);
  if (lines.some((l) => tw(l) > maxChars * TEXT_W)) lines = wrap(label, maxChars);
  const longest = Math.max(...lines.map((l) => tw(l)));
  const w = Math.min(maxW, Math.max(it.n.kind === "end" ? 64 : 96, Math.round(longest + PAD + extra)));
  return { lines, w, h: VPAD * 2 + lines.length * LINE };
}
const trunc = (s: string, w: number) => { const maxPx = w - PAD; if (tw(s) <= maxPx) return s; let k = s.length; while (k > 3 && tw(`${s.slice(0, k)}…`) > maxPx) k--; return `${s.slice(0, k)}…`; };

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
    // a group may end in a fork of its own (the team's tap after an unclear reply): it carries on when one of that fork's ways is the join
    const forksOn = (id: string | undefined) => !!id && byId.get(id)?.kind === "fork" && !!join && outs(id).some((e) => skip(e.to) === join);
    const groups: Group[] = ways.map((w, i) => { const c = chains[i]; const upto = join ? c.indexOf(join) : -1; const ids = upto >= 0 ? c.slice(0, upto) : c; ids.forEach((id) => seen.add(id)); const items = ids.map(item); return { label: w.label.replace(/^the reply is (a )?/i, "").replace(/[“”"]/g, "").replace(/^./, (ch) => ch.toUpperCase()), items, go: upto >= 0 || forksOn(ids[ids.length - 1]), first: ids[0] ?? null }; });
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
  const out: string[] = []; const x = W / 2; let y = 14;   // y is the top of the next thing to draw
  const maxNodeW = Math.min(300, W - 24);
  let prevBottom: number | null = null;
  const link = (x1: number, y1: number, x2: number, y2: number) => { const my = (y1 + y2) / 2; out.push(`<path d="M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}" fill="none" stroke="${T("edge")}" stroke-width="1.6"/>`); };
  // one node on the spine (or at cx): draws it at the current y, returns its bottom
  const put = (it: Item, cx: number, top: number, maxW: number) => { const sz = sizeOf(it, maxW); out.push(node(it, cx, top + sz.h / 2, sz, stateOf(it.id))); return top + sz.h; };
  for (const row of rows) {
    if (row.kind === "nodes") {
      // triggers side by side when there are several; everything else down the spine
      const trigs = row.items.filter((it) => it.n.kind === "trig"); const rest = row.items.filter((it) => it.n.kind !== "trig");
      if (trigs.length > 1) { const w = Math.min(maxNodeW, (W - 24 - (trigs.length - 1) * 12) / trigs.length); const total = trigs.length * w + (trigs.length - 1) * 12; let tx = x - total / 2 + w / 2; let bottom = y; for (const it of trigs) { bottom = Math.max(bottom, put(it, tx, y, w)); tx += w + 12; } tx = x - total / 2 + w / 2; for (let i = 0; i < trigs.length; i++) { link(tx, bottom, x, bottom + GAP); tx += w + 12; } prevBottom = null; y = bottom + GAP; }
      else if (trigs.length === 1) { if (prevBottom !== null) link(x, prevBottom, x, y); prevBottom = put(trigs[0], x, y, maxNodeW); y = prevBottom + GAP; }
      for (const it of rest) {
        if (prevBottom !== null) link(x, prevBottom, x, y);
        prevBottom = put(it, x, y, maxNodeW); y = prevBottom + GAP;
      }
      continue;
    }
    // the fork node, then its groups in rows that fit the width
    const f = row.fork; if (prevBottom !== null) link(x, prevBottom, x, y);
    const forkBottom = put(f, x, y, maxNodeW); y = forkBottom + GAP + 10;
    let groups = row.groups;
    if (pathOnly) { const taken = groups.filter((g) => g.first && stateOf(g.first) && stateOf(g.first) !== "next"); if (taken.length) groups = taken; }
    const gap = 14; const minG = 130;
    const fit = Math.max(1, Math.min(groups.length, Math.floor((W - 16 + gap) / (minG + gap))));
    const bottoms: { x: number; y: number; go: boolean }[] = [];
    if (fit < groups.length) {
      // more branches than fit side by side: one column, each branch a full-width card hung off a spine in the left gutter.
      // Rows of columns would send the join lines through the cards below them.
      const colW = Math.min(360, W - 16 - 28); const gx = x + 14; const x0 = gx - colW / 2 - 14; const innerW = colW - 16;
      const capLines = (g: Group) => wrap(g.label.toUpperCase(), Math.max(8, Math.floor((colW - 12) / 6.4))).slice(0, 2);
      const headH = (g: Group) => 22 + (capLines(g).length - 1) * 13;
      const heightOf = (g: Group) => headH(g) + 12 + (g.items.length ? g.items.reduce((a, it) => a + sizeOf(it, innerW).h, 0) + (g.items.length - 1) * GAP : 20) + 10;
      link(x, forkBottom, x0, y); let sy = y; let goesOn = false;
      for (const g of groups) {
        const on = g.first ? stateOf(g.first) : null; const lit = on && on !== "next"; const h = heightOf(g);
        out.push(`<rect x="${gx - colW / 2}" y="${sy}" width="${colW}" height="${h}" rx="12" fill="${T("panel")}" stroke="${lit ? T("acc") : T("line")}" stroke-width="1.5"/>`);
        capLines(g).forEach((l, i) => out.push(`<text class="cap" x="${gx}" y="${sy + 16 + i * 13}" text-anchor="middle" fill="${lit ? T("acc") : T("fg-3")}">${esc(l)}</text>`));
        out.push(`<path d="M${x0} ${sy + 18} H${gx - colW / 2}" fill="none" stroke="${lit ? T("acc") : T("edge")}" stroke-width="1.6"/>`);
        let yy = sy + headH(g) + 8;
        if (!g.items.length) out.push(`<text class="lbl" x="${gx}" y="${yy + 14}" text-anchor="middle">carries on</text>`);
        let last: number | null = null;
        for (const it of g.items) { if (last !== null) link(gx, last, gx, yy); last = put(it, gx, yy, innerW); yy = last + GAP; }
        if (g.go) goesOn = true;
        sy += h + GAP;
      }
      const spineEnd = goesOn ? sy - GAP + 8 : sy - GAP - 24;
      out.push(`<path d="M${x0} ${y} V${spineEnd}" fill="none" stroke="${T("edge")}" stroke-width="1.6"/>`);
      y = sy + 4;
      if (goesOn) link(x0, spineEnd, x, y);
      prevBottom = null;
      continue;
    }
    const rowsN = Math.ceil(groups.length / fit); const perRow = Math.ceil(groups.length / rowsN);
    const colW = Math.min(190, (W - 16 - (perRow - 1) * gap) / perRow);
    let from = forkBottom;
    for (let r = 0; r < groups.length; r += perRow) {
      const slice = groups.slice(r, r + perRow); const total = slice.length * colW + (slice.length - 1) * gap; let gx = x - total / 2 + colW / 2;
      const innerW = colW - 16;
      const capLines = (g: Group) => wrap(g.label.toUpperCase(), Math.max(8, Math.floor((colW - 12) / 6.4))).slice(0, 2);
      const headH = (g: Group) => 22 + (capLines(g).length - 1) * 13;
      const heightOf = (g: Group) => headH(g) + 12 + (g.items.length ? g.items.reduce((a, it) => a + sizeOf(it, innerW).h, 0) + (g.items.length - 1) * GAP : 20) + 10;
      const gh = Math.max(...slice.map(heightOf));
      if (r) { out.push(`<path d="M${x} ${from} V${y - 12}" fill="none" stroke="${T("edge")}" stroke-width="1.6"/>`); from = y - 12; }
      for (const g of slice) {
        const on = g.first ? stateOf(g.first) : null; const lit = on && on !== "next"; const h = heightOf(g);
        out.push(`<rect x="${gx - colW / 2}" y="${y}" width="${colW}" height="${h}" rx="12" fill="${T("panel")}" stroke="${lit ? T("acc") : T("line")}" stroke-width="1.5"/>`);
        capLines(g).forEach((l, i) => out.push(`<text class="cap" x="${gx}" y="${y + 16 + i * 13}" text-anchor="middle" fill="${lit ? T("acc") : T("fg-3")}">${esc(l)}</text>`));
        link(x, from, gx, y);
        let yy = y + headH(g) + 8;
        if (!g.items.length) out.push(`<text class="lbl" x="${gx}" y="${yy + 14}" text-anchor="middle">carries on</text>`);
        let last: number | null = null;
        for (const it of g.items) { if (last !== null) { link(gx, last, gx, yy); } last = put(it, gx, yy, innerW); yy = last + GAP; }
        bottoms.push({ x: gx, y: y + h, go: g.go });
        gx += colW + gap;
      }
      y += gh + 24; from = y - 24;
    }
    const goes = bottoms.filter((b) => b.go);
    if (goes.length) { y += 6; for (const b of goes) link(b.x, b.y, x, y); }
    prevBottom = null;
  }
  const Hh = Math.max(y + 10, 80);
  return `<svg viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" role="img" aria-label="Flow chart">${out.join("")}</svg>`;
}

function node(it: Item, x: number, y: number, sz: Size, st: St | null): string {
  const k = it.n.kind; const w = sz.w, h = sz.h; const top = y - h / 2;
  const fill = k === "trig" ? T("acc") : k === "end" ? "none" : k === "fork" || k === "check" ? T("panel-3") : T("panel-2");
  const stroke = k === "trig" ? T("acc") : k === "end" ? T("fg-3") : T("edge"); const ink = k === "trig" ? T("acc-ink") : k === "end" ? T("fg-2") : T("fg");
  const dim = st === "skip" || st === "blocked" || st === "next"; const op = dim ? (st === "next" ? 0.45 : 0.55) : 1;
  let g = `<g class="nd" tabindex="0" data-id="${it.id}" style="opacity:${op}"><rect class="b" x="${x - w / 2}" y="${top}" width="${w}" height="${h}" rx="${k === "end" ? Math.min(17, h / 2) : 9}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  // the title centred on up to three lines; a clock before the first line when it waits, the blue mark at the right when it is conditional
  const ki = kindIconOf(it); const leftW = (it.waits ? 22 : 0) + (ki ? 22 : 0);
  const shift = (leftW - (it.cond ? 18 : 0)) / 2;
  const y0 = top + VPAD + 11.5;
  sz.lines.forEach((l, i) => { g += `<text x="${x + shift}" y="${y0 + i * LINE}" text-anchor="middle" fill="${ink}">${esc(l)}</text>`; });
  let lx = x + shift - Math.max(...sz.lines.map((l) => tw(l))) / 2 - leftW;
  const iconInk = k === "trig" ? T("acc-ink") : T("fg-2");
  if (ki) { g += `<g transform="translate(${lx},${y0 - 12}) scale(.8)" style="color:${iconInk}">${LOGO[ki] ?? LOGO.engine}</g>`; lx += 22; }
  if (it.waits) { g += `<g transform="translate(${lx},${y0 - 12}) scale(.8)" style="color:${T("fg-2")}">${svgIcon("clock")}</g>`; }
  if (sz.chips) { let cy = y0 + sz.lines.length * LINE - 4; for (const c of sz.chips) { const cw = tw(c.text, 6.4) + 14; g += `<rect x="${x - cw / 2}" y="${cy - 1}" width="${cw}" height="17" rx="6" fill="${c.stage ? T("cond-bg") : T("panel-3")}"/><text x="${x}" y="${cy + 11.5}" text-anchor="middle" fill="${c.stage ? T("cond") : T("fg")}" style="${c.stage ? "font-size:11px;font-weight:600" : "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:500"}">${esc(c.text)}</text>`; cy += 20; } }
  if (it.cond) g += `<g transform="translate(${x + w / 2 - 24},${top + h / 2 - 8}) scale(.8)" style="color:${T("cond")}">${svgIcon("cond")}</g>`;
  if (st && st !== "next") { const [col, bg] = BADGE[st] ?? BADGE.stop;
    g += `<g transform="translate(${x + w / 2 - 10},${top - 10})"><title>${esc(STATE_WORDS[st] ?? st)}</title><circle cx="10" cy="10" r="10" fill="${T(bg)}"/><g style="color:${T(col)}" transform="translate(3,3) scale(.7)">${svgIcon(st === "ok" ? "check" : st === "ghost" ? "ghost" : st === "here" ? "clock" : st === "skip" || st === "blocked" ? "skip" : st === "warn" ? "warn" : "stop")}</g></g>`; }
  return g + "</g>";
}
/** A run state's badge on the chart, as [ink, fill] tokens: the same colours as the strip's segments. */
const BADGE: Record<string, [string, string]> = { ok: ["ok", "ok-bg"], ghost: ["ok", "ok-bg"], here: ["wait", "wait-bg"], skip: ["cond", "cond-bg"], blocked: ["warn", "warn-bg"], warn: ["warn", "warn-bg"], stop: ["fg-3", "panel-3"], next: ["fg-3", "panel-3"] };
/** The logo of the thing a step touches, at the left of its node, the way Zapier shows an app on every step. Drawn here, 20×20, in the brand's colour. */
const LOGO: Record<string, string> = {
  slack: '<rect x="2" y="7.5" width="7" height="2.6" rx="1.3" fill="#E01E5A"/><rect x="7.5" y="2" width="2.6" height="7" rx="1.3" fill="#36C5F0"/><rect x="11" y="9.9" width="7" height="2.6" rx="1.3" fill="#2EB67D"/><rect x="9.9" y="11" width="2.6" height="7" rx="1.3" fill="#ECB22E"/><circle cx="3.3" cy="12.2" r="1.3" fill="#E01E5A"/><circle cx="7.8" cy="3.3" r="1.3" fill="#36C5F0"/><circle cx="16.7" cy="7.8" r="1.3" fill="#2EB67D"/><circle cx="12.2" cy="16.7" r="1.3" fill="#ECB22E"/>',
  ghl: '<rect x="1.5" y="1.5" width="17" height="17" rx="4" fill="#1F6BFF"/><path d="M6 13.5l4-7 4 7M7.6 11h4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  calendly: '<circle cx="10" cy="10" r="8.5" fill="#006BFF"/><path d="M13.3 7.6a3.9 3.9 0 1 0 0 4.8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  fathom: '<rect x="1.5" y="1.5" width="17" height="17" rx="4" fill="#7C3AED"/><path d="M7 14V6h6M7 10h4.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  whop: '<rect x="1.5" y="1.5" width="17" height="17" rx="4" fill="#FF6243"/><path d="M4.5 6.5l2.2 7 2.3-5.5 2.3 5.5 2.2-7" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  sms: '<path d="M3 4.5h14a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H8l-4 3.5V14H3a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z" fill="#34C759"/><path d="M6.5 9.3h7" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
  email: '<rect x="1.5" y="4" width="17" height="12" rx="2.5" fill="#5B8DEF"/><path d="M3.5 6.5l6.5 5 6.5-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>',
  jev: '<rect x="1.5" y="1.5" width="17" height="17" rx="5" fill="#5B4BFF"/><path d="M12.2 5.5v6.2a2.7 2.7 0 0 1-5.4.4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  ai: '<path d="M10 2l1.9 5.3L17 9.2l-5.1 1.9L10 16.4l-1.9-5.3L3 9.2l5.1-1.9z" fill="#F0B429"/><path d="M15.5 13l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" fill="#F0B429"/>',
  clock: '<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 5.5v4.8l3.2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  reply: '<path d="M8 5L3 9.5 8 14M3 9.5h8a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  fork: '<path d="M10 3v5M10 8l-5 5v4M10 8l5 5v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  if: '<path d="M10 3v5M10 8l-5 5v4M10 8l5 5v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  end: '<rect x="5" y="5" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>',
  webhook: '<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2 10h16M10 2c3 3 3 13 0 16M10 2c-3 3-3 13 0 16" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  doc: '<path d="M5 2h7l4 4v12H5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 10h5M8 13h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  form: '<rect x="4" y="2.5" width="12" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 7h6M7 10.5h6M7 14h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  engine: '<circle cx="10" cy="10" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 2v3M10 15v3M2 10h3M15 10h3M4.3 4.3l2.2 2.2M13.5 13.5l2.2 2.2M4.3 15.7l2.2-2.2M13.5 6.5l2.2-2.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
const kindIconOf = (it: Item) => it.waits ? (it.n.logo && it.n.logo !== "clock" ? it.n.logo : "") : (it.n.logo ?? "");
const svgIcon = (k: string) => ({
  check: '<path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  clock: '<circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 6v4.5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  warn: '<path d="M10 3l8 14H2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10 9v3.5M10 14.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  cond: '<path d="M6 4v12M6 8c0 3 8 1 8 5M14 13l-2-2M14 13l2-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  skip: '<circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 10h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  stop: '<rect x="5" y="5" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>',
  ghost: '<path d="M4 17V9a6 6 0 0 1 12 0v8l-2-1.5L12 17l-2-1.5L8 17l-2-1.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 9.5h.01M12 9.5h.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
}[k] ?? "");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The popover for a node: what it does, its condition in blue, the words it sends, its state on this run. */
export function NodeWords({ chart, id, state, extra }: { chart: Chart; id: string; state?: St | null; extra?: ReactNode }) {
  const n = chart.nodes.find((x) => x.id === id); if (!n) return null;
  const w = { ok: "Done", ghost: "Done in shadow: nothing written or sent", here: "Waiting here", warn: "Failed", skip: "Skipped: its condition was not met", blocked: "Blocked: it did not go out", next: "Not reached", stop: "Stopped" }[state ?? "next"];
  return <>
    <h4><Title text={n.title} />{n.meta ? <span style={{ color: "var(--fg-2)", fontWeight: 500 }}> · {n.meta}</span> : null}</h4>
    {n.detail ? <p className="m">{n.detail}</p> : null}
    {n.kind === "fork" ? <p className="m">{chart.edges.filter((e) => e.from === id).map((e) => e.label || "otherwise").join(" · ")}</p> : null}
    {n.cond ? <div className="c"><Cond /><span>{n.cond}</span></div> : null}
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
    {run ? null : <><span style={{ color: "var(--fg-2)" }}><Clock />waits first</span><span style={{ color: "var(--cond)" }}><Cond />runs only sometimes</span><span className="sep" aria-hidden /></>}
    {keys.map((k) => <span key={k} className="key" style={{ color: `var(--${STATE_INK[k]})` }}><i className={`swa ${k}`} />{k === "next" ? null : stateIcon(k)}{STATE_WORDS[k]}</span>)}
  </div>;
}
