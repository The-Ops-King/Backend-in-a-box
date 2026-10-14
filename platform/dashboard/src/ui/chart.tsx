import { SlackMsg, emoji } from "./slack";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Chart, PathItem } from "~/api";
import { Title } from "./steps";
import { Check, Clock, Cond, Ghost, Skip, Warn, stateIcon } from "./icons";
import { STATE_ORDER, STATE_WORDS } from "./pieces";
import { arrange, type Group, type Item, type Row } from "./arrange";

/**
 * The flow chart (design guide §5): one vertical spine, every step its own node, the fork's outcomes as labelled groups
 * side by side, the groups that carry on curving back to the spine. Drawn by us, as SVG, from the chart words the API
 * sends. A group is drawn like the spine (D107): a fork inside it gets its own groups inside it. With a run's states,
 * each node wears a small badge and the nodes not reached dim. Groups that do not fit side by side stack in one column,
 * so nothing scrolls sideways. On a phone with a run shown, only the path taken is drawn. The layout is arrange.ts.
 */
type St = PathItem["state"];

const T = (k: string) => `var(--${k})`;
const TEXT_W = 7.6, PAD = 28, LINE = 16, VPAD = 9, H = 34, GAP = 18, IF_W = 6.2, IF_H = 19, IF_PAD = 16, DASH = "5 4";
/** Width of a title in px at the node font (13px, 600): per-glyph so "Appointment matched?" is not measured like "little if". */
function tw(s: string, per = TEXT_W): number {
  let w = 0;
  for (const ch of s) w += /[ilj.,:;'|!]/.test(ch) ? 0.42 : /[ftrI ()\-]/.test(ch) ? 0.55 : /[mwMW]/.test(ch) ? 1.25 : /[A-Z]/.test(ch) ? 0.9 : /[0-9]/.test(ch) ? 0.78 : /[→‹›“”]/.test(ch) ? 0.9 : 0.74;
  return w * per / 0.72;   // the 600-weight face runs a touch wider than the per-glyph table
}
// :shortcodes: in the words (the emoji a step waits for) are drawn as the emoji, the way Slack shows them
const labelOf = (it: Item) => (it.n.title + (it.n.meta && it.n.kind !== "send" ? ` · ${it.n.meta}` : "") + (it.waits ? ` · ${it.waits}` : "")).replace(/:([a-z0-9_+-]+):/g, (m, code) => emoji(code) ?? m);
/** Words onto lines no wider than `max` characters; two lines wanted, three at most, nothing cut. */
function wrap(text: string, max: number, most = 4): string[] {
  const words = text.split(/\s+/); const lines: string[] = []; let cur = "";
  const maxPx = max * TEXT_W;
  for (const w of words) { const next = cur ? `${cur} ${w}` : w; if (tw(next) <= maxPx || !cur) cur = next; else { lines.push(cur); cur = w; } }
  if (cur) lines.push(cur);
  const cut = (l: string, more = false) => { if (!more && tw(l) <= maxPx) return l; let k = l.length; while (k > 3 && tw(`${l.slice(0, k)}…`) > maxPx) k--; return `${l.slice(0, k).trimEnd()}…`; };
  // four lines at most (six in a narrow column); past that the last line is cut with an ellipsis rather than spilling out of the box
  if (lines.length > most) { const keep = lines.slice(0, most); keep[most - 1] = cut(keep[most - 1], true); return keep; }
  return lines.map((l) => cut(l));
}
/** The lines a node shows and the box they need, within the width allowed. */
type Size = { lines: string[]; w: number; h: number; chips?: { text: string; stage: boolean }[]; noIcon?: boolean };
function sizeOf(it: Item, maxW: number): Size {
  const s = sizeOfTitle(it, maxW); if (!it.when) return s;
  // the condition line under the title: as wide as it needs, up to the width allowed, cut with … past that
  return { ...s, w: Math.min(maxW, Math.max(s.w, Math.round(tw(ifLine(it), IF_W) + 16 + IF_PAD))), h: s.h + IF_H };
}
const ifLine = (it: Item) => `only if ${it.when}`;
function sizeOfTitle(it: Item, maxW: number): Size {
  // a node in a narrow column (a group inside a group) gives its logo's room to the words, and may run to six lines
  const narrow = maxW < 150; const most = narrow ? 6 : 4;
  const extra = (it.waits ? 22 : 0) + (it.cond && !it.when ? 18 : 0) + (kindIconOf(it) && !narrow ? 22 : 0);
  // “tags” and ‹stages› in the words become chips under the title
  const raw = labelOf(it); const found = raw.match(/“[^”]*”|‹[^›]*›/g);
  if (found) {
    const chips = found.flatMap((c) => { const text = c.slice(1, -1), stage = c.startsWith("‹"); if (stage && tw(text, 6.4) + 22 + PAD > maxW && text.includes(" → ")) { const [a, b] = text.split(" → "); return [{ text: `${a} →`, stage }, { text: b, stage }]; } return [{ text, stage }]; });
    const verb = raw.replace(/“[^”]*”|‹[^›]*›/g, "").replace(/\s*·\s*$/, "").replace(/,\s*/g, " ").replace(/\s+/g, " ").trim().replace(/ tag$/, chips.length > 1 ? " tags" : " tag");
    const maxChars = Math.max(8, Math.floor((maxW - PAD - extra) / TEXT_W));
    const lines = tw(verb) <= maxChars * TEXT_W ? [verb] : wrap(verb, maxChars, most);
    const w = Math.min(maxW, Math.max(96, Math.round(Math.max(...lines.map((l) => tw(l) + extra), ...chips.map((c) => tw(c.text, 6.4) + 22)) + PAD)));
    return { lines, chips, w, h: VPAD * 2 + lines.length * LINE + chips.length * 20, noIcon: narrow };
  }
  const label = raw; const maxChars = Math.max(8, Math.floor((maxW - PAD - extra) / TEXT_W));
  // two balanced lines when it does not fit on one; more only when it must
  let lines = tw(label) <= maxChars * TEXT_W ? [label] : wrap(label, Math.max(maxChars, Math.ceil(label.length / 2) + 2) <= maxChars ? Math.max(8, Math.ceil(label.length / 2) + 2) : maxChars, most);
  if (lines.some((l) => tw(l) > maxChars * TEXT_W)) lines = wrap(label, maxChars, most);
  const longest = Math.max(...lines.map((l) => tw(l)));
  const w = Math.min(maxW, Math.max(it.n.kind === "end" ? 64 : 96, Math.round(longest + PAD + extra)));
  return { lines, w, h: VPAD * 2 + lines.length * LINE, noIcon: narrow };
}
const trunc = (s: string, w: number, per = TEXT_W) => { const maxPx = w - PAD; if (tw(s, per) <= maxPx) return s; let k = s.length; while (k > 3 && tw(`${s.slice(0, k)}…`, per) > maxPx) k--; return `${s.slice(0, k)}…`; };

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

const G_GAP = 14, G_MIN = 130, G_COL = 190;
function draw(rows: Row[], W: number, stateOf: (id: string) => St | null, pathOnly: boolean): string {
  const out: string[] = [];
  const link = (x1: number, y1: number, x2: number, y2: number, dashed = false) => { const my = (y1 + y2) / 2; out.push(`<path d="M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}" fill="none" stroke="${T("edge")}" stroke-width="1.6"${dashed ? ` stroke-dasharray="${DASH}"` : ""}/>`); };
  // the node last put, so the edge out of a sometimes-step is dashed and the way around it ("otherwise") can be drawn
  type Placed = { it: Item; cx: number; top: number; bottom: number; w: number; above: boolean };
  let last: Placed | null = null;
  // one node at cx: draws it with its top at `top`, returns its bottom
  const put = (it: Item, cx: number, top: number, maxW: number, above = false) => { const sz = sizeOf(it, maxW); out.push(node(it, cx, top + sz.h / 2, sz, stateOf(it.id))); last = { it, cx, top, bottom: top + sz.h, w: sz.w, above }; return top + sz.h; };
  /**
   * The edge straight down from the node last put to the next thing at (x, y2), dashed into or out of a sometimes-step.
   * Out of one that had an edge straight into it, a thin blue way around its right side, "otherwise": skipped, the
   * run goes on. Drawn only when it fits left of `limit`.
   */
  const down = (x1: number, y1: number, y2: number, next: Item | null, limit: number) => {
    const p = last as Placed | null;
    link(x1, y1, x1, y2, !!(next?.when || (p && p.bottom === y1 && p.it.when)));
    if (!p || p.bottom !== y1 || !p.it.when || !p.above || p.cx !== x1) return;
    const rx = p.cx + p.w / 2 + 14; if (rx > limit) return;
    const a = p.top - GAP / 2, b = p.bottom + GAP / 2;
    out.push(`<path class="by" d="M${p.cx} ${a} Q${rx} ${a} ${rx} ${p.top + 8} V${p.bottom - 8} Q${rx} ${b} ${p.cx} ${b}" fill="none" stroke="${T("cond")}" stroke-width="1.4" stroke-opacity=".75"/>`);
    if (rx + 6 + tw("otherwise", IF_W) <= limit) out.push(`<text class="lbl" x="${rx + 6}" y="${(p.top + p.bottom) / 2 + 4}" style="fill:${T("cond")}">otherwise</text>`);
  };
  // on a phone with a run, only the groups the run took
  const shown = (gs: Group[]) => { if (!pathOnly) return gs; const taken = gs.filter((g) => g.first && stateOf(g.first) && stateOf(g.first) !== "next"); return taken.length ? taken : gs; };
  /** The width rows need to draw every fork in them with its groups side by side: at the narrowest, and at ease. */
  const needs = new Map<Row[], { min: number; want: number }>();
  const need = (rs: Row[]): { min: number; want: number } => {
    const had = needs.get(rs); if (had) return had;
    let min = 0, want = 0;
    for (const r of rs) if (r.kind === "fork") { const gs = shown(r.groups).map((g) => need(g.rows)); const pad = (gs.length - 1) * G_GAP + 16; min = Math.max(min, gs.reduce((a, g) => a + Math.max(G_MIN, g.min), 0) + pad); want = Math.max(want, gs.reduce((a, g) => a + Math.max(G_COL, g.want), 0) + pad); }
    const r = { min, want }; needs.set(rs, r); return r;
  };
  const capLines = (g: Group, colW: number) => g.bare ? [] : wrap(g.label.toUpperCase(), Math.max(8, Math.floor((colW - 12) / 6.4)), 2);
  const card = (g: Group, cx: number, top: number, colW: number, h: number, lit: boolean) => `<rect x="${cx - colW / 2}" y="${top}" width="${colW}" height="${h}" rx="12" fill="${T("panel")}" stroke="${lit ? T("acc") : T("line")}" stroke-width="1.5"/>` + capLines(g, colW).map((l, i) => `<text class="cap" x="${cx}" y="${top + 16 + i * 13}" text-anchor="middle" fill="${lit ? T("acc") : T("fg-3")}">${esc(l)}</text>`).join("");
  /**
   * One group's content inside its card (or bare), its top at `top`: returns the card's bottom and where the line back
   * to the join starts.
   */
  const inGroup = (g: Group, cx: number, top: number, colW: number): { bottom: number; exit: number } => {
    const head = g.bare ? 0 : 22 + (capLines(g, colW).length - 1) * 13 + 8;
    if (!g.rows.length) { out.push(`<text class="lbl" x="${cx}" y="${top + head + 14}" text-anchor="middle">carries on</text>`); return { bottom: top + head + 34, exit: top + head + 34 }; }
    const r = region(g.rows, cx, colW, Math.min(g.bare ? 300 : 344, colW - (g.bare ? 8 : 16)), cx + colW / 2 - 4, top + head, !g.bare);
    // the lines of a fork that ends the group meet at the card's bottom edge, and the group's own line goes on from there
    if (r.joined && !g.bare) out.push(`<path d="M${cx} ${r.exit} V${r.exit! + 10}" fill="none" stroke="${T("edge")}" stroke-width="1.6"/>`);
    const bottom = r.joined ? r.exit! + (g.bare ? 0 : 10) : g.bare ? r.bottom : r.bottom + 14;
    return { bottom, exit: g.bare ? r.exit ?? r.bottom : bottom };
  };

  /**
   * Rows down a spine at x in a region W wide. Returns the lowest point drawn, the top of whatever would come next, and
   * where the flow leaves at x: the bottom of the last node, or (joined) the point a fork's lines meet; null where it ends.
   */
  function region(rs: Row[], x: number, W: number, nodeW: number, limit: number, y: number, wayIn: boolean): { bottom: number; next: number; exit: number | null; joined: boolean } {
    let pb: number | null = null, px = x;      // the bottom (and x) of the node to link down from
    let joined = false;                        // the last thing was a fork whose lines meet at (x, y)
    let around: number | null = null;          // an entry trigger sits in the way in: the way in starts here and passes it
    let aroundTop = false;                     // …from the top of its group, under the label
    let bottom = y; let first = true; let entryLeft = x;
    const arrive = (it: Item | null, top: number) => {
      if (pb !== null) { if (px !== x) link(px, pb, x, top); else down(x, pb, top, it, limit); }
      if (around !== null) { const lx = entryLeft - 10; out.push(`<path d="${aroundTop ? `M${lx} ${around}` : `M${x} ${around} Q${lx} ${around} ${lx} ${around + 14}`} V${top - 14} Q${lx} ${top} ${x} ${top}" fill="none" stroke="${T("edge")}" stroke-width="1.6"/>`); around = null; }
    };
    const step = (it: Item) => {
      if (it.entry) {
        // a trigger that starts the run here: beside the way in, which curves around it; both meet at the next step
        const from = pb !== null && px === x ? pb : joined ? y : first && wayIn ? y - 6 : null;
        if (joined) y += GAP;
        aroundTop = pb === null && !joined && from !== null; around = from; pb = put(it, x + 14, y, nodeW - 36); px = x + 14; entryLeft = x + 14 - (last as Placed | null)!.w / 2; joined = false; y = pb + GAP; return;
      }
      arrive(it, y); const above = pb !== null && px === x;
      pb = put(it, x, y, nodeW, above); px = x; joined = false; y = pb + GAP;
    };
    for (const row of rs) {
      if (row.kind === "nodes") {
        // triggers side by side when there are several; everything else down the spine
        const trigs = row.items.filter((it) => it.n.kind === "trig" && !it.entry);
        if (trigs.length > 1) {
          const w = Math.min(nodeW, (W - 24 - (trigs.length - 1) * 12) / trigs.length); const total = trigs.length * w + (trigs.length - 1) * 12;
          let tx = x - total / 2 + w / 2; let b = y; for (const it of trigs) { b = Math.max(b, put(it, tx, y, w)); tx += w + 12; }
          tx = x - total / 2 + w / 2; for (let i = 0; i < trigs.length; i++) { link(tx, b, x, b + GAP); tx += w + 12; }
          pb = null; joined = true; y = b + GAP; bottom = b;
        }
        for (const it of row.items) if (trigs.length < 2 || !trigs.includes(it)) { step(it); bottom = pb!; }
      } else if (row.kind === "on") {
        // the flow goes on at a step drawn elsewhere: a short arrow and its name
        const from = pb !== null ? pb : joined ? y : first ? y - 2 : y - GAP + 2; const ax = pb !== null ? px : x;
        out.push(`<path d="M${ax} ${from} V${from + 14}" fill="none" stroke="${T("edge")}" stroke-width="1.6"/><path d="M${ax - 4} ${from + 10} L${ax} ${from + 15} L${ax + 4} ${from + 10}" fill="none" stroke="${T("edge")}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`);
        const lines = wrap(`on to “${row.title.replace(/[“”‹›]/g, "")}”`, Math.max(8, Math.floor((W - 16) / IF_W))).slice(0, 3);
        lines.forEach((l, i) => out.push(`<text class="lbl" x="${ax}" y="${from + 30 + i * 14}" text-anchor="middle">${esc(l)}</text>`));
        bottom = from + 34 + (lines.length - 1) * 14; pb = null; joined = false; y = bottom + GAP;
      } else if (row.kind === "more") {
        // steps listed in order in a dashed card: nested too deep to draw as branches, or not reached by the walk
        if (!row.linked) { pb = null; joined = false; y += GAP; }
        const colW = Math.min(nodeW + 16, W - 8); const caps = wrap(row.label.toUpperCase(), Math.max(8, Math.floor((colW - 12) / 6.4)), 2);
        if (row.linked) arrive(null, y);
        const at = out.length; const top = y; let yy = top + 22 + (caps.length - 1) * 13 + 8; let end: number | null = null;
        for (const it of row.items) { if (end !== null) down(x, end, yy, it, x + colW / 2 - 4); end = put(it, x, yy, colW - 16, end !== null); yy = end + GAP; }
        const h = (end ?? yy) + 14 - top;
        out.splice(at, 0, `<rect x="${x - colW / 2}" y="${top}" width="${colW}" height="${h}" rx="12" fill="${T("panel")}" stroke="${T("fg-3")}" stroke-width="1.5" stroke-dasharray="${DASH}"/>` + caps.map((l, i) => `<text class="cap" x="${x}" y="${top + 16 + i * 13}" text-anchor="middle">${esc(l)}</text>`).join(""));
        bottom = top + h; pb = row.linked ? bottom : null; px = x; joined = false; y = bottom + GAP;
      } else {
        let from = y;
        if (row.fork) { arrive(row.fork, y); from = put(row.fork, x, y, nodeW, pb !== null && px === x); y = from + GAP + 10; }
        const groups = shown(row.groups); const ns = groups.map((g) => need(g.rows));
        const mins = ns.map((n) => Math.max(G_MIN, n.min)), wants = ns.map((n) => Math.max(G_COL, n.want));
        const sum = (a: number[]) => a.reduce((s, v) => s + v, 0); const gaps = (groups.length - 1) * G_GAP; const avail = W - 16;
        if (sum(mins) + gaps > avail) {
          // more than fit side by side: one column, each group a card hung off a spine in the left gutter. Rows of
          // columns would send the join lines through the cards below them.
          const colW = Math.min(W - 16 - 28, Math.max(360, ...wants)); const gx = x + 14; const x0 = gx - colW / 2 - 14;
          if (row.fork) link(x, from, x0, y);
          let sy = y; let goesOn = false; let tick = y;
          for (const g of groups) {
            const on = g.first ? stateOf(g.first) : null; const lit = !!on && on !== "next";
            const at = out.length; const r = inGroup(g, gx, sy, colW);
            out.splice(at, 0, card(g, gx, sy, colW, r.bottom - sy, lit) + `<path d="M${x0} ${sy + 18} H${gx - colW / 2}" fill="none" stroke="${lit ? T("acc") : T("edge")}" stroke-width="1.6"/>`);
            tick = sy + 18; if (g.go) goesOn = true; sy = r.bottom + GAP;
          }
          const spineEnd = goesOn ? sy - GAP + 8 : tick;
          out.push(`<path d="M${x0} ${row.fork ? y : y + 18} V${spineEnd}" fill="none" stroke="${T("edge")}" stroke-width="1.6"/>`);
          bottom = sy - GAP; y = sy + 4;
          if (goesOn) link(x0, spineEnd, x, y);
          joined = goesOn;
        } else {
          let widths = wants;
          if (sum(wants) + gaps > avail) { const t = (avail - gaps - sum(mins)) / Math.max(1, sum(wants) - sum(mins)); widths = mins.map((m, i) => m + (wants[i] - m) * t); }
          const total = sum(widths) + gaps; let gx = x - total / 2;
          const ends: { x: number; y: number; go: boolean }[] = []; let low = y;
          groups.forEach((g, i) => {
            const colW = widths[i]; const cx = gx + colW / 2;
            const on = g.first ? stateOf(g.first) : null; const lit = !!on && on !== "next";
            const at = out.length; if (!g.bare) link(x, from, cx, y);
            const r = inGroup(g, cx, y, colW);
            if (!g.bare) out.splice(at, 0, card(g, cx, y, colW, r.bottom - y, lit));
            ends.push({ x: cx, y: r.exit, go: g.go }); low = Math.max(low, r.bottom);
            gx += colW + G_GAP;
          });
          bottom = low; y = low + 24;
          const goes = ends.filter((b) => b.go);
          if (goes.length) { y += 6; for (const b of goes) { if (b.y < low) out.push(`<path d="M${b.x} ${b.y} V${low}" fill="none" stroke="${T("edge")}" stroke-width="1.6"/>`); link(b.x, Math.max(b.y, low), x, y); } }
          joined = goes.length > 0;
        }
        pb = null; px = x;
      }
      first = false;
    }
    return { bottom, next: y, exit: pb !== null && px === x ? pb : joined ? y : null, joined: pb === null && joined };
  }
  const r = region(rows, W / 2, W, Math.min(300, W - 24), W - 4, 14, false);
  const Hh = Math.max(r.next + 10, 80);
  return `<svg viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" role="img" aria-label="Flow chart">${out.join("")}</svg>`;
}

function node(it: Item, x: number, y: number, sz: Size, st: St | null): string {
  const k = it.n.kind; const w = sz.w, h = sz.h; const top = y - h / 2;
  const fill = k === "trig" ? T("acc") : k === "end" ? "none" : k === "fork" || k === "check" ? T("panel-3") : T("panel-2");
  const stroke = k === "trig" ? T("acc") : k === "end" ? T("fg-3") : T("edge"); const ink = k === "trig" ? T("acc-ink") : k === "end" ? T("fg-2") : T("fg");
  const dim = st === "skip" || st === "blocked" || st === "next"; const op = dim ? (st === "next" ? 0.45 : 0.55) : 1;
  // a sometimes-step (D103): a dashed blue border, and its condition on a line of its own under the title
  let g = `<g class="nd${it.when ? " if" : ""}" tabindex="0" data-id="${it.id}" style="opacity:${op}"><rect class="b" x="${x - w / 2}" y="${top}" width="${w}" height="${h}" rx="${k === "end" ? Math.min(17, h / 2) : 9}" fill="${fill}" stroke="${it.when ? T("cond") : stroke}" stroke-width="1.5"${it.when ? ` stroke-dasharray="${DASH}"` : ""}/>`;
  // the title centred on up to three lines; a clock before the first line when it waits, the blue mark at the right when it may not fire
  const ki = sz.noIcon ? "" : kindIconOf(it); const leftW = (it.waits ? 22 : 0) + (ki ? 22 : 0);
  const shift = (leftW - (it.cond && !it.when ? 18 : 0)) / 2;
  const y0 = top + VPAD + 11.5;
  sz.lines.forEach((l, i) => { g += `<text x="${x + shift}" y="${y0 + i * LINE}" text-anchor="middle" fill="${ink}">${esc(l)}</text>`; });
  let lx = x + shift - Math.max(...sz.lines.map((l) => tw(l))) / 2 - leftW;
  const iconInk = k === "trig" ? T("acc-ink") : T("fg-2");
  if (ki) { g += `<g transform="translate(${lx},${y0 - 12}) scale(.8)" style="color:${iconInk}">${LOGO[ki] ?? LOGO.engine}</g>`; lx += 22; }
  if (it.waits) { g += `<g transform="translate(${lx},${y0 - 12}) scale(.8)" style="color:${T("fg-2")}">${svgIcon("clock")}</g>`; }
  if (sz.chips) { let cy = y0 + sz.lines.length * LINE - 4; for (const c of sz.chips) { const cw = tw(c.text, 6.4) + 14; g += `<rect x="${x - cw / 2}" y="${cy - 1}" width="${cw}" height="17" rx="6" fill="${c.stage ? T("cond-bg") : T("panel-3")}"/><text x="${x}" y="${cy + 11.5}" text-anchor="middle" fill="${c.stage ? T("cond") : T("fg")}" style="${c.stage ? "font-size:11px;font-weight:600" : "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:500"}">${esc(c.text)}</text>`; cy += 20; } }
  if (it.cond && !it.when) g += `<g transform="translate(${x + w / 2 - 24},${top + h / 2 - 8}) scale(.8)" style="color:${T("cond")}">${svgIcon("cond")}</g>`;
  if (it.when) {
    const room = w - 16 - IF_PAD; const full = ifLine(it);
    // in a narrow column "if …" before cutting the condition itself
    const line = tw(full, IF_W) <= room ? full : tw(`if ${it.when}`, IF_W) <= room ? `if ${it.when}` : trunc(`if ${it.when}`, room + PAD, IF_W); const lw = tw(line, IF_W) + 16; const cy = top + h - 8;
    g += `<g transform="translate(${x - lw / 2},${cy - 10.5}) scale(.65)" style="color:${T("cond")}">${svgIcon("cond")}</g><text x="${x - lw / 2 + 16}" y="${cy}" fill="${T("cond")}" style="font-size:11.5px;font-weight:600">${esc(line)}</text>`;
  }
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
    {run ? null : <><span style={{ color: "var(--fg-2)" }}><Clock />waits first</span><span style={{ color: "var(--cond)" }}><i className="dash" aria-hidden />only if …, otherwise skipped</span><span style={{ color: "var(--cond)" }}><Cond />may be skipped</span><span className="sep" aria-hidden /></>}
    {keys.map((k) => <span key={k} className="key" style={{ color: `var(--${STATE_INK[k]})` }}><i className={`swa ${k}`} />{k === "next" ? null : stateIcon(k)}{STATE_WORDS[k]}</span>)}
  </div>;
}
