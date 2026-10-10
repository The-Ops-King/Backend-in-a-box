import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Back, stateIcon } from "./icons";

/** The way back: `‹ Company` and, on a run page, `/ Workflow`. */
export function Crumb({ items }: { items: { to: string; label: string }[] }) {
  return <div className="crumb"><Back />{items.map((it, i) => <span key={it.to} style={{ display: "contents" }}>{i ? <span>/</span> : null}<Link to={it.to}>{it.label}</Link></span>)}</div>;
}
/** The name line: the page's name with its one control at the right, centred on the name even when it wraps. */
export function NameLine({ name, control }: { name: string; control?: ReactNode }) {
  return <div className="nameline"><h1 className="name">{name}</h1>{control}</div>;
}
export const Tag = ({ kind, children }: { kind?: string; children: ReactNode }) => <span className={`tag ${kind ?? ""}`}>{children}</span>;
export const Ic = ({ state }: { state: string }) => <span className={`ic ${state}`}>{stateIcon(state)}</span>;

/** Zapier's switch: a pill, a knob, the word beside it only when `word` is set. Optimistic: it moves first (design guide §2.7). */
export function Switch({ on, onChange, word, big, disabled, label }: { on: boolean; onChange: (next: boolean) => Promise<unknown> | void; word?: boolean; big?: boolean; disabled?: boolean; label?: string }) {
  const [shown, setShown] = useState(on);
  useEffect(() => setShown(on), [on]);
  const flip = async (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); const next = !shown; setShown(next); try { await onChange(next); } catch { setShown(!next); } };
  return <button type="button" className={`sw ${big ? "big" : ""}`} role="switch" aria-checked={shown} aria-label={label} onClick={flip} disabled={disabled}><span className="k" />{word ? <span className="w">{shown ? "On" : "Off"}</span> : null}</button>;
}

/** Four numbers on one line at every width. */
export function Tiles({ items }: { items: { n: number; word: string; kind?: "h" | "f" }[] }) {
  return <div className="tiles tnum">{items.map((t) => <div key={t.word} className={t.n ? t.kind ?? "" : "z"}><b>{t.n}</b><small>{t.word}</small></div>)}</div>;
}

/** What each step state means, in the words the legend and the tooltips use; one colour each, the same on the bars and the chart. */
export const STATE_WORDS: Record<string, string> = { ok: "ran", ghost: "ran in shadow", skip: "skipped: condition not met", blocked: "blocked: did not go out", here: "waiting here", warn: "failed or needs a hand", stop: "stopped", next: "not reached yet" };
export const STATE_ORDER = ["ok", "ghost", "skip", "blocked", "here", "warn", "stop", "next"];
type StripStep = { state: string; title?: string; meta?: string; note?: string };
/** One segment's tooltip: "Add “stat-new” tag — done in shadow: would have tagged “stat-new”". */
export function stepLine(p: StripStep): string {
  const name = `${(p.title ?? "A step").replace(/[‹›]/g, "")}${p.meta ? ` · ${p.meta.replace(/[‹›]/g, "")}` : ""}`;
  const note = (p.note ?? "").replace(/Didn't go out: /, "").replace(/Done in shadow: /, "").trim();
  const said = { ok: "ran", ghost: "done in shadow", skip: "skipped", blocked: "blocked, did not go out", here: "waiting here", warn: "failed", stop: "stopped", next: "not reached yet" }[p.state] ?? p.state;
  return `${name} — ${said}${note && p.state !== "next" ? `: ${note}` : p.state === "skip" ? ": its condition was not met" : ""}`;
}
/** The strip: one segment per step on the path, full width; each segment says what its step did when hovered. */
export function Strip({ path, note }: { path: StripStep[]; note?: string }) {
  return <span className="prog"><span className="bars">{path.map((p, i) => { const t = p.title ? stepLine(p) : undefined; return <i key={i} className={p.state} title={t} aria-label={t} />; })}</span>{note ? <small>{note}</small> : null}</span>;
}

/** Counts on a row: people / in flight / failed, folding into a short note on a phone. */
export function Counts({ people, in_flight, needs_hand }: { people: number; in_flight: number; needs_hand: number }) {
  const bits: ReactNode[] = []; if (in_flight) bits.push(<span key="h"><b>{in_flight}</b> in flight</span>); if (needs_hand) bits.push(<span key="f"><i>{needs_hand}</i> need a hand</span>); if (!bits.length && people) bits.push(<span key="p">{people} people</span>);
  return <>
    <span className="cnt tnum"><span className={people ? "" : "z"}><b>{people}</b> people</span><span className={`h ${in_flight ? "" : "z"}`}><b>{in_flight}</b> in flight</span><span className={`f ${needs_hand ? "" : "z"}`}><b>{needs_hand}</b> {needs_hand === 1 ? "needs" : "need"} a hand</span></span>
    {bits.length ? <span className="mini tnum">{bits.map((b, i) => <span key={i}>{i ? " · " : ""}{b}</span>)}</span> : null}
  </>;
}

export const Fold = ({ title, children, open }: { title: ReactNode; children: ReactNode; open?: boolean }) => <details className="fold" open={open}><summary>{title}</summary><div className="body">{children}</div></details>;
export const Sec = ({ children, small }: { children: ReactNode; small?: ReactNode }) => <h3 className="sec">{children}{small ? <small>{small}</small> : null}</h3>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

/** Tabs: pills in a row, the active one inverted. */
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode }[] }) {
  return <div className="tabs">{items.map((t) => <button key={t.id} type="button" aria-pressed={value === t.id} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>;
}

/* toasts: the one way a failed write is said */
type Toast = { id: number; text: string; warn?: boolean };
const listeners = new Set<(t: Toast) => void>(); let seq = 0;
export const toast = (text: string, warn = false) => { const t = { id: ++seq, text, warn }; listeners.forEach((l) => l(t)); };
export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => { const l = (t: Toast) => { setList((x) => [...x, t]); setTimeout(() => setList((x) => x.filter((y) => y.id !== t.id)), 5000); }; listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return <div className="toasts" aria-live="polite">{list.map((t) => <div key={t.id} className={`toast ${t.warn ? "warn" : ""}`}>{t.text}</div>)}</div>;
}

/**
 * A floating panel on a laptop, a bottom sheet on a phone. On a laptop it opens below its anchor, or above when that fits
 * better, never past the window's edges; past its room it scrolls inside, with a fade at the bottom while more is below.
 * Closes on a tap outside, Escape, or a real scroll of the page.
 */
export function Sheet({ anchor, onClose, children }: { anchor: Element | null; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null); const sc = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current, inner = sc.current; if (!el || !inner) return;
    const M = 12, G = 8;
    const place = () => {
      if (window.innerWidth >= 700 && anchor) {
        const r = anchor.getBoundingClientRect(); const w = el.offsetWidth, h = inner.scrollHeight, vh = window.innerHeight;
        const left = Math.min(Math.max(M, r.left + r.width / 2 - w / 2), window.innerWidth - w - M);
        const below = vh - r.bottom - G - M, above = r.top - G - M;
        if (h <= below) setPos({ left, top: r.bottom + G, maxHeight: below });
        else if (h <= above) setPos({ left, top: r.top - G - h, maxHeight: above });
        else if (Math.max(below, above) >= 240) setPos(below >= above ? { left, top: r.bottom + G, maxHeight: below } : { left, top: M, maxHeight: above });
        else setPos({ left, top: M, maxHeight: vh - 2 * M });
      } else setPos(null);
      setMore(inner.scrollHeight - inner.scrollTop - inner.clientHeight > 4);
    };
    place();
    const ro = new ResizeObserver(place); ro.observe(inner); window.addEventListener("resize", place);
    return () => { ro.disconnect(); window.removeEventListener("resize", place); };
  }, [anchor]);
  useEffect(() => {
    // closes on a real scroll, not on the small settle that follows the tap itself
    const born = Date.now(); const y0 = window.scrollY; const close = () => { if (Date.now() - born > 400 && Math.abs(window.scrollY - y0) > 24) onClose(); }; window.addEventListener("scroll", close, { passive: true }); const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", key);
    return () => { window.removeEventListener("scroll", close); window.removeEventListener("keydown", key); };
  }, [onClose]);
  const onScroll = () => { const i = sc.current; if (i) setMore(i.scrollHeight - i.scrollTop - i.clientHeight > 4); };
  return <><div className="scrim" onClick={onClose} /><div ref={ref} className="sheet" role="dialog" style={pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight } : undefined}><button type="button" className="x" aria-label="Close" onClick={onClose}>×</button><div ref={sc} className={`sc ${more ? "more" : ""}`} onScroll={onScroll}>{children}</div></div></>;
}

export const Skeleton = ({ lines = 4 }: { lines?: number }) => <div>{Array.from({ length: lines }, (_, i) => <div key={i} className="skel" style={{ width: `${[60, 90, 75, 40, 85][i % 5]}%` }} />)}</div>;
