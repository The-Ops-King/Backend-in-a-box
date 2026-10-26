import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, usePage } from "~/api";
import type { CallEntry, EodField } from "@/engine/eod-form";
type EodPrefill = { day: string; calls_count: number; closes: number; deposits: number; cash: number; revenue: number; calls: CallEntry[] };
import { dayFields, fieldsFor, isSetterCall, outcomeLabel, totalsOf, valueOf, DIAL_OUTCOMES, TRIAGE_OUTCOMES, type CallOutcome } from "@/engine/eod-form";
import { Skeleton } from "~/ui/pieces";

type Page = { closer: { first_name: string; name: string }; company: { name: string; timezone: string }; brand?: { name: string; logo_url: string | null; accent: string | null }; day: string; is_today: boolean; prev: string; next: string; filed: { at: string; changes: number } | null; pre: EodPrefill; seen: { calls: number; cash: number }; fields: EodField[]; day_answers: Record<string, string>; outcomes: { value: string; label: string }[] };

/**
 * The closer's end-of-day page (D34): bare, no nav, nothing but their day. One question per call first (what happened), then
 * only the fields that answer needs. Totals on top follow the calls unless the closer types their own.
 */
export function Eod() {
  const { token = "" } = useParams(); const [sp, setSp] = useSearchParams();
  const day = sp.get("day");
  const q = usePage<Page>(["closer-eod", token, day], `/api/eod/${token}${day ? `?day=${day}` : ""}`, { every: 0 });
  useEffect(() => { document.title = "End of day"; document.body.classList.add("eodx-body"); return () => document.body.classList.remove("eodx-body"); }, []);
  if (!q.data) return <div className="eodx"><div className="eodx-wrap">{q.error ? <p className="eodx-note">{q.error.status === 404 ? "This link isn't active. Ask your manager for a new one." : q.error.message}</p> : <Skeleton lines={6} />}</div></div>;
  const d = q.data;
  const brand = d.brand ?? { name: d.company.name, logo_url: null, accent: null };
  const label = new Date(`${d.day}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const short = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const go = (day: string) => (e: React.MouseEvent) => { e.preventDefault(); setSp({ day }); };
  // D220: the offer's own look (brand.*), light and phone-first; the accent is the offer's color, else a quiet default
  return <div className="eodx" style={brand.accent ? ({ "--brand": brand.accent } as React.CSSProperties) : undefined}><div className="eodx-wrap">
    <header className="eodx-top">
      {brand.logo_url ? <img className="eodx-logo" src={brand.logo_url} alt={brand.name} /> : <span className="eodx-mark">{brand.name}</span>}
      <span className="eodx-kicker">End of day</span>
    </header>
    <h1 className="eodx-h1">{d.is_today ? `How did today go, ${d.closer.first_name}?` : `${d.closer.first_name}, here's ${label.split(",")[0]}`}</h1>
    <nav className="eodx-days">
      <a href="#" onClick={go(d.prev)}>‹ {short(d.prev)}</a>
      <b>{d.is_today ? "Today" : label}</b>
      {d.is_today ? <span /> : <a href="#" onClick={go(d.next)}>{short(d.next)} ›</a>}
    </nav>
    {d.filed ? <div className="eodx-banner ok">You sent this day in at {new Date(d.filed.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: d.company.timezone })}. Change anything below and send it again to update it.</div> : null}
    <p className="eodx-note">We filled in what we could from your calendar, your call recordings and the day's payments. Check each call, fix anything that's off, then send it in.</p>
    <Form key={`${token}:${d.day}`} token={token} d={d} onFiled={() => q.refetch()} />
  </div></div>;
}

function Form({ token, d, onFiled }: { token: string; d: Page; onFiled: () => void }) {
  const [calls, setCalls] = useState<CallEntry[]>(d.pre.calls);
  const [callsCount, setCallsCount] = useState(String(d.pre.calls_count));
  const [touched, setTouched] = useState<{ closes?: string; deposits?: string; cash?: string; revenue?: string }>({});
  const [dayAnswers, setDayAnswers] = useState<Record<string, string>>(d.day_answers);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false); const [done, setDone] = useState<{ recorded: number; changes: number } | null>(null); const [err, setErr] = useState<string | null>(null); const [editing, setEditing] = useState(false);
  const t = totalsOf(calls, d.fields);
  // a call is done when it has its outcome and every required answer that outcome asks for; done calls fold to one line
  const complete = (c: CallEntry) => !!c.outcome && !c.moved && fieldsFor(d.fields, c.outcome, c.kind).every((f) => !f.required || String(valueOf(c, f.key) ?? "").trim() !== "");
  const set = (i: number, patch: Partial<CallEntry>) => setCalls((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const setField = (i: number, key: string, v: string) => {
    if (key === "revenue" || key === "cash") set(i, { [key]: v === "" ? null : Number(v.replace(/[,$]/g, "")) || 0 });
    else if (key === "next_date") set(i, { next_date: v || null });
    else if (key === "next_steps" || key === "dq_reason" || key === "dq_note" || key === "lost_reason" || key === "pitched" || key === "about" || key === "notes") set(i, { [key]: v });
    else setCalls((cs) => cs.map((c, j) => (j === i ? { ...c, extra: { ...c.extra, [key]: v } } : c)));
  };
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: d.company.timezone });
  const outcomeField = d.fields.find((f) => f.key === "outcome")!;
  const showDeposits = t.deposits > 0 || touched.deposits !== undefined;
  // D143: a day of triage calls only (a setter's) asks no money: closes, cash and revenue are the closing calls'; D156: outbound calls are a setter's too
  const closing = calls.length === 0 || calls.some((c) => !isSetterCall(c.kind));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api<{ recorded: number; changes: number }>(`/api/eod/${token}`, { method: "POST", json: { day: d.day, calls_count: callsCount, closes: touched.closes ?? "", deposits: touched.deposits ?? String(t.deposits), cash: touched.cash ?? "", revenue: touched.revenue ?? "", calls, day_answers: dayAnswers } }); setDone(r); setEditing(false); onFiled(); }
    catch (x) { setErr((x as Error).message); }
    setBusy(false); window.scrollTo({ top: 0, behavior: "smooth" });
  };
  // filed: a thank-you page in place of the form, with what went in; the form comes back only if they choose to change something
  if (done && !editing) {
    const counts = Object.entries(calls.reduce<Record<string, number>>((m, c) => { const k = outcomeLabel(c.outcome, d.fields, c.kind); m[k] = (m[k] ?? 0) + 1; return m; }, {}));
    const dayWords = new Date(`${d.day}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    return <div className="eodx-thanks">
      <div className="eodx-check" aria-hidden>✓</div>
      <h2>Thanks, {d.closer.first_name}. {dayWords} is in.</h2>
      <p>{calls.length} call{calls.length === 1 ? "" : "s"} sent{counts.length ? `: ${counts.map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ")}` : ""}.</p>
      {done.changes ? <p className="eodx-note">You changed {done.changes} answer{done.changes === 1 ? "" : "s"} from what we had filled in. The team will see your corrections.</p> : null}
      <button className="eodx-btn ghost" type="button" onClick={() => setEditing(true)}>Change an answer</button>
    </div>;
  }
  const indexed = calls.map((c, i) => ({ c, i }));
  const groups = [{ title: "Discovery calls", rows: indexed.filter((x) => isSetterCall(x.c.kind)) }, { title: "Closing calls", rows: indexed.filter((x) => !isSetterCall(x.c.kind)) }]
    .filter((g) => g.rows.length).map((g) => ({ ...g, left: g.rows.filter((x) => !complete(x.c)).length }));
  return <form className="eodx-form" onSubmit={submit}>
    {err ? <div className="eodx-banner warn"><strong>That didn't save.</strong> {err}. Your answers are still here, so fix that and send it again.</div> : null}
    <section className="eodx-card">
      <h2 className="eodx-h2">Your numbers</h2>
      <div className="eodx-totals">
        <label><span>Calls taken</span><input type="number" min={0} value={callsCount} onChange={(e) => setCallsCount(e.target.value)} /><small>{d.seen.calls} on your calendar</small></label>
        {closing ? <>
        <label><span>Closes</span><input type="number" min={0} value={touched.closes ?? String(t.closes)} onChange={(e) => setTouched((x) => ({ ...x, closes: e.target.value }))} /><small>&nbsp;</small></label>
        {showDeposits ? <label><span>Deposits</span><input type="number" min={0} value={touched.deposits ?? String(t.deposits)} onChange={(e) => setTouched((x) => ({ ...x, deposits: e.target.value }))} /><small>&nbsp;</small></label> : null}
        <label><span>Cash collected</span><div className="eodx-money"><i>$</i><input type="text" inputMode="decimal" value={touched.cash ?? String(t.cash)} onChange={(e) => setTouched((x) => ({ ...x, cash: e.target.value }))} /></div><small>{d.seen.cash ? `$${d.seen.cash.toLocaleString("en-US")} in payments today` : "No payments seen yet"}</small></label>
        <label><span>Revenue</span><div className="eodx-money"><i>$</i><input type="text" inputMode="decimal" value={touched.revenue ?? String(t.revenue)} onChange={(e) => setTouched((x) => ({ ...x, revenue: e.target.value }))} /></div><small>Total contract value</small></label>
        </> : null}
      </div>
    </section>
    {/* Tyler: one person can set and close the same day; their calls come in two sections, "Discovery calls" and "Closing calls" */}
    {calls.length === 0 ? <><h2 className="eodx-h2 out">Your calls</h2><div className="eodx-empty">No calls on your calendar this day.</div></> : null}
    {groups.map((g) => <div key={g.title}>
      <h2 className="eodx-h2 out">{g.title} <small>{g.left ? `${g.left} to go` : "all set"}</small></h2>
      {g.rows.map(({ c, i }, n) => { const after = fieldsFor(d.fields, c.outcome, c.kind), choices = c.kind === "triage" ? TRIAGE_OUTCOMES : c.kind === "dial" ? DIAL_OUTCOMES : d.outcomes;
      const done_ = complete(c), shown = !done_ || open[c.appointment_id];
      const kind = c.kind === "triage" ? "Triage call" : c.kind === "dial" ? "Outbound call" : null;
      return <section key={c.appointment_id} className={`eodx-call${done_ ? " done" : ""}`}>
        <button type="button" className="eodx-call-hd" onClick={() => done_ && setOpen((o) => ({ ...o, [c.appointment_id]: !o[c.appointment_id] }))} aria-expanded={!!shown}>
          <span className="eodx-dot" aria-hidden>{done_ ? "✓" : n + 1}</span>
          <span className="eodx-who"><b>{c.contact}</b><small>{time(c.starts_at)}{kind ? ` · ${kind}` : ""}</small></span>
          {done_ ? <span className="eodx-pill">{outcomeLabel(c.outcome, d.fields, c.kind)}</span> : null}
          {done_ ? <span className="eodx-edit">{shown ? "Close" : "Edit"}</span> : null}
        </button>
        {shown ? <div className="eodx-call-bd">
          {c.href_contact || c.recording_url ? <div className="eodx-links">{c.href_contact ? <a href={c.href_contact} target="_blank" rel="noreferrer">Open contact ↗</a> : null}{c.recording_url ? <a href={c.recording_url} target="_blank" rel="noreferrer">Recording ↗</a> : null}</div> : null}
          <label className="eodx-field"><span>{outcomeField.label}{outcomeField.required ? <em> *</em> : null}</span><select value={c.outcome} required={outcomeField.required} onChange={(e) => set(i, { outcome: e.target.value as CallOutcome })}><option value="">Choose one</option>{choices.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
          {c.hint && !c.outcome ? <p className="eodx-hint">{c.hint}</p> : null}
          {c.moved ? <p className="eodx-hint warn">{c.moved}</p> : null}
          {after.length ? <div className="eodx-after">{after.map((f) => <Field key={f.key} f={f} value={valueOf(c, f.key)} onChange={(v) => setField(i, f.key, v)} />)}</div> : null}
        </div> : null}
      </section>; })}
    </div>)}
    {dayFields(d.fields).map((f) => <section key={f.key} className="eodx-card"><Field f={f} value={dayAnswers[f.key] ?? ""} onChange={(v) => setDayAnswers((x) => ({ ...x, [f.key]: v }))} /></section>)}
    <div className="eodx-bar"><button className="eodx-btn" type="submit" disabled={busy}>{busy ? "Sending…" : d.filed ? "Update my day" : "Send my day"}</button></div>
  </form>;
}

function Field({ f, value, onChange }: { f: EodField; value: string; onChange: (v: string) => void }) {
  const label = <span>{f.label}{f.required ? <em> *</em> : null}{f.help ? <small> {f.help}</small> : null}</span>;
  return <label className={`eodx-field${f.type === "textarea" ? " wide" : ""}`}>{label}
    {f.type === "select" ? <select value={value} required={f.required} onChange={(e) => onChange(e.target.value)}><option value="">Choose one</option>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
      : f.type === "textarea" ? <textarea rows={3} value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />
      : f.type === "money" ? <input type="text" inputMode="decimal" value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />
      : f.type === "number" ? <input type="number" value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />
      : f.type === "date" ? <input type="date" value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />
      : <input type="text" value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />}
  </label>;
}
