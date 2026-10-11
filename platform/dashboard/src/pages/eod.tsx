import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, usePage } from "~/api";
import type { CallEntry, EodField } from "@/engine/eod-form";
type EodPrefill = { day: string; calls_count: number; closes: number; deposits: number; cash: number; revenue: number; calls: CallEntry[] };
import { dayFields, fieldsFor, outcomeLabel, totalsOf, valueOf, type CallOutcome } from "@/engine/eod-form";
import { Skeleton } from "~/ui/pieces";

type Page = { closer: { first_name: string; name: string }; company: { name: string; timezone: string }; day: string; is_today: boolean; prev: string; next: string; filed: { at: string; changes: number } | null; pre: EodPrefill; seen: { calls: number; cash: number }; fields: EodField[]; day_answers: Record<string, string>; outcomes: { value: string; label: string }[] };

/**
 * The closer's end-of-day page (D34): bare, no nav, nothing but their day. One question per call first (what happened), then
 * only the fields that answer needs. Totals on top follow the calls unless the closer types their own.
 */
export function Eod() {
  const { token = "" } = useParams(); const [sp, setSp] = useSearchParams();
  const day = sp.get("day");
  const q = usePage<Page>(["closer-eod", token, day], `/api/eod/${token}${day ? `?day=${day}` : ""}`, { every: 0 });
  useEffect(() => { document.title = "End of day"; }, []);
  if (!q.data) return <div className="bare">{q.error ? <p className="note">{q.error.status === 404 ? "This link is not for anyone." : q.error.message}</p> : <Skeleton lines={6} />}</div>;
  const d = q.data;
  const label = new Date(`${d.day}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const short = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return <div className="bare">
    <div className="crumb" style={{ marginBottom: 6 }}>{d.company.name} · end of day</div>
    <h1 className="name">{d.closer.first_name}, your {d.is_today ? "day" : label.split(",")[0]}</h1>
    <div className="tagline"><a href="#" onClick={(e) => { e.preventDefault(); setSp({ day: d.prev }); }} style={{ color: "var(--fg-3)" }}>‹ {short(d.prev)}</a><span>·</span><b style={{ color: "var(--fg)" }}>{label}</b>{d.is_today ? <span>(today)</span> : <><span>·</span><a href="#" onClick={(e) => { e.preventDefault(); setSp({ day: d.next }); }} style={{ color: "var(--fg-3)" }}>{short(d.next)} ›</a></>}</div>
    {d.filed ? <div className="banner">Already filed at {new Date(d.filed.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: d.company.timezone })}. Submitting again replaces it.</div> : null}
    <p className="note" style={{ marginTop: 12 }}>Prefilled from your calendar, the recordings and the day's payments. Fix anything that's off, then submit.</p>
    <Form key={`${token}:${d.day}`} token={token} d={d} onFiled={() => q.refetch()} />
  </div>;
}

function Form({ token, d, onFiled }: { token: string; d: Page; onFiled: () => void }) {
  const [calls, setCalls] = useState<CallEntry[]>(d.pre.calls);
  const [callsCount, setCallsCount] = useState(String(d.pre.calls_count));
  const [touched, setTouched] = useState<{ closes?: string; deposits?: string; cash?: string; revenue?: string }>({});
  const [dayAnswers, setDayAnswers] = useState<Record<string, string>>(d.day_answers);
  const [busy, setBusy] = useState(false); const [done, setDone] = useState<{ recorded: number; changes: number } | null>(null); const [err, setErr] = useState<string | null>(null); const [editing, setEditing] = useState(false);
  const t = totalsOf(calls);
  const set = (i: number, patch: Partial<CallEntry>) => setCalls((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const setField = (i: number, key: string, v: string) => {
    if (key === "revenue" || key === "cash") set(i, { [key]: v === "" ? null : Number(v.replace(/[,$]/g, "")) || 0 });
    else if (key === "next_date") set(i, { next_date: v || null });
    else if (key === "next_steps" || key === "dq_reason" || key === "dq_note" || key === "about" || key === "notes") set(i, { [key]: v });
    else setCalls((cs) => cs.map((c, j) => (j === i ? { ...c, extra: { ...c.extra, [key]: v } } : c)));
  };
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: d.company.timezone });
  const outcomeField = d.fields.find((f) => f.key === "outcome")!;
  const showDeposits = t.deposits > 0 || touched.deposits !== undefined;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api<{ recorded: number; changes: number }>(`/api/eod/${token}`, { method: "POST", json: { day: d.day, calls_count: callsCount, closes: touched.closes ?? "", deposits: touched.deposits ?? String(t.deposits), cash: touched.cash ?? "", revenue: touched.revenue ?? "", calls, day_answers: dayAnswers } }); setDone(r); setEditing(false); onFiled(); }
    catch (x) { setErr((x as Error).message); }
    setBusy(false); window.scrollTo({ top: 0, behavior: "smooth" });
  };
  // filed: a thank-you page in place of the form, with what went in; the form comes back only if they choose to change something
  if (done && !editing) {
    const counts = Object.entries(calls.reduce<Record<string, number>>((m, c) => { const k = outcomeLabel(c.outcome); m[k] = (m[k] ?? 0) + 1; return m; }, {}));
    const dayWords = new Date(`${d.day}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    return <div className="thanks" style={{ marginTop: 14 }}>
      <h2>Thanks, {d.closer.first_name}. Your end of day for {dayWords} is in.</h2>
      <p>{calls.length} call{calls.length === 1 ? "" : "s"} filed{counts.length ? `: ${counts.map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ")}` : ""}.</p>
      {done.changes ? <p className="note">{done.changes} answer{done.changes === 1 ? "" : "s"} differed from what the engine had; the team will see the corrections.</p> : null}
      <button className="submit" type="button" onClick={() => setEditing(true)}>Change an answer</button>
    </div>;
  }
  return <form className="form" onSubmit={submit} style={{ marginTop: 14 }}>
    {err ? <div className="banner warn"><strong>Not saved.</strong> {err}. Your answers are still here; fix and press Submit again.</div> : null}
    <div className="call"><div className="g2" style={{ gridTemplateColumns: showDeposits ? "repeat(auto-fit, minmax(130px, 1fr))" : "repeat(auto-fit, minmax(150px, 1fr))" }}>
      <label>How many calls today?<input type="number" min={0} value={callsCount} onChange={(e) => setCallsCount(e.target.value)} /><span className="note">{d.seen.calls} on your calendar</span></label>
      <label>Closes<input type="number" min={0} value={touched.closes ?? String(t.closes)} onChange={(e) => setTouched((x) => ({ ...x, closes: e.target.value }))} /></label>
      {showDeposits ? <label>Deposits<input type="number" min={0} value={touched.deposits ?? String(t.deposits)} onChange={(e) => setTouched((x) => ({ ...x, deposits: e.target.value }))} /></label> : null}
      <label>Cash collected ($)<input type="text" inputMode="decimal" value={touched.cash ?? String(t.cash)} onChange={(e) => setTouched((x) => ({ ...x, cash: e.target.value }))} /><span className="note">{d.seen.cash ? `$${d.seen.cash.toLocaleString("en-US")} seen in payments` : "nothing seen in payments"}</span></label>
      <label>Revenue generated ($)<input type="text" inputMode="decimal" value={touched.revenue ?? String(t.revenue)} onChange={(e) => setTouched((x) => ({ ...x, revenue: e.target.value }))} /></label>
    </div></div>
    <h3 className="sec">Your calls <small>{calls.length}</small></h3>
    {calls.length === 0 ? <div className="empty">No calls on your calendar for this day.</div> : null}
    {calls.map((c, i) => { const after = fieldsFor(d.fields, c.outcome);
      return <div key={c.appointment_id} className="call">
        <div className="hd"><b>{i + 1}. {c.contact}</b><span className="note">{time(c.starts_at)}</span>{c.href_contact ? <a href={c.href_contact} target="_blank" rel="noreferrer">CRM ↗</a> : null}{c.recording_url ? <a href={c.recording_url} target="_blank" rel="noreferrer">Recording ↗</a> : null}{c.appointment_id.startsWith("ghl:") ? <span className="note">booked before the engine; your answer goes straight to its Sales Call</span> : null}</div>
        <label>{outcomeField.label}{outcomeField.required ? <span className="req"> *</span> : null}<select value={c.outcome} required={outcomeField.required} onChange={(e) => set(i, { outcome: e.target.value as CallOutcome })}><option value="">—</option>{d.outcomes.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
        {c.hint && !c.outcome ? <p className="hint">{c.hint}</p> : null}
        {after.length ? <div className="after">{after.map((f) => <Field key={f.key} f={f} value={valueOf(c, f.key)} onChange={(v) => setField(i, f.key, v)} />)}</div> : null}
      </div>; })}
    {dayFields(d.fields).map((f) => <div key={f.key} className="call"><Field f={f} value={dayAnswers[f.key] ?? ""} onChange={(v) => setDayAnswers((x) => ({ ...x, [f.key]: v }))} /></div>)}
    <button className="submit" type="submit" disabled={busy}>{busy ? "Filing…" : "Submit my day"}</button>
  </form>;
}

function Field({ f, value, onChange }: { f: EodField; value: string; onChange: (v: string) => void }) {
  const label = <>{f.label}{f.required ? <span className="req"> *</span> : null}{f.help ? <span className="note"> · {f.help}</span> : null}</>;
  return <label className={f.type === "textarea" ? "wide" : ""}>{label}
    {f.type === "select" ? <select value={value} required={f.required} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
      : f.type === "textarea" ? <textarea rows={2} value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />
      : f.type === "money" ? <input type="text" inputMode="decimal" value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />
      : f.type === "number" ? <input type="number" value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />
      : f.type === "date" ? <input type="date" value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />
      : <input type="text" value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />}
  </label>;
}
