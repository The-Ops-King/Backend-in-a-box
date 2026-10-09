import { useEffect, useRef, useState, type ReactNode } from "react";
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

/** The strip: one segment per step on the path, full width. */
export function Strip({ path, note }: { path: { state: string }[]; note?: string }) {
  return <span className="prog"><span className="bars">{path.map((p, i) => <i key={i} className={p.state === "next" ? "" : p.state} />)}</span>{note ? <small>{note}</small> : null}</span>;
}

/** Counts on a row: people / in flight / failed, folding into a short note on a phone. */
export function Counts({ people, in_flight, failed }: { people: number; in_flight: number; failed: number }) {
  const bits: ReactNode[] = []; if (in_flight) bits.push(<span key="h"><b>{in_flight}</b> in flight</span>); if (failed) bits.push(<span key="f"><i>{failed}</i> failed</span>); if (!bits.length && people) bits.push(<span key="p">{people} people</span>);
  return <>
    <span className="cnt tnum"><span className={people ? "" : "z"}><b>{people}</b> people</span><span className={`h ${in_flight ? "" : "z"}`}><b>{in_flight}</b> in flight</span><span className={`f ${failed ? "" : "z"}`}><b>{failed}</b> failed</span></span>
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

/** A floating panel on a laptop, a bottom sheet on a phone; flips upward when it would fall off the bottom; closes on scroll. */
export function Sheet({ anchor, onClose, children }: { anchor: Element | null; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (window.innerWidth >= 700 && anchor) { const r = anchor.getBoundingClientRect(); const h = el.offsetHeight, w = el.offsetWidth; const left = Math.min(Math.max(16, r.left + r.width / 2 - w / 2), window.innerWidth - w - 16); const below = r.bottom + 8, above = r.top - 8 - h; setPos({ left, top: Math.max(12, below + h > window.innerHeight - 12 && above > 12 ? above : below) }); } else setPos(null);
    // closes on a real scroll, not on the small settle that follows the tap itself
    const born = Date.now(); const y0 = window.scrollY; const close = () => { if (Date.now() - born > 400 && Math.abs(window.scrollY - y0) > 24) onClose(); }; window.addEventListener("scroll", close, { passive: true }); const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", key);
    return () => { window.removeEventListener("scroll", close); window.removeEventListener("keydown", key); };
  }, [anchor, onClose]);
  return <><div className="scrim" onClick={onClose} /><div ref={ref} className="sheet" role="dialog" style={pos ? { left: pos.left, top: pos.top } : undefined}><button type="button" className="x" aria-label="Close" onClick={onClose}>×</button>{children}</div></>;
}

export const Skeleton = ({ lines = 4 }: { lines?: number }) => <div>{Array.from({ length: lines }, (_, i) => <div key={i} className="skel" style={{ width: `${[60, 90, 75, 40, 85][i % 5]}%` }} />)}</div>;
