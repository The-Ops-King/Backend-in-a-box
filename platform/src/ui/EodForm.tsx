"use client";
import { useState } from "react";
import type { CallEntry, EodField, EodPrefill } from "@/engine/eod";
import { OUTCOMES, dayFields, fieldsFor, totalsOf, valueOf, type CallOutcome } from "@/engine/eod-form";
import { submitEodAction } from "./eod-actions";

/**
 * The closer's day, prefilled and editable. Each call asks one thing first, what happened, and the questions that
 * follow that answer appear once it is picked (the company's form, see eod-form.ts). Totals at the top follow the
 * per-call answers unless the closer types their own.
 */
export function EodForm({ pre, seen, fields, token, tz, dayAnswers }: { pre: EodPrefill; seen: { calls: number; cash: number }; fields: EodField[]; token: string; tz: string; dayAnswers: Record<string, string> }) {
  const [calls, setCalls] = useState<CallEntry[]>(pre.calls);
  const [callsCount, setCallsCount] = useState(String(pre.calls_count));
  const [touched, setTouched] = useState<{ closes?: string; deposits?: string; cash?: string; revenue?: string }>({});
  const t = totalsOf(calls);
  const set = (i: number, patch: Partial<CallEntry>) => setCalls((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const setField = (i: number, key: string, v: string) => {
    if (key === "revenue" || key === "cash") set(i, { [key]: v === "" ? null : Number(v.replace(/[,$]/g, "")) || 0 });
    else if (key === "next_date") set(i, { next_date: v || null });
    else if (key === "next_steps" || key === "dq_reason" || key === "dq_note" || key === "about" || key === "notes") set(i, { [key]: v });
    else setCalls((cs) => cs.map((c, j) => (j === i ? { ...c, extra: { ...c.extra, [key]: v } } : c)));
  };
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  const outcomeField = fields.find((f) => f.key === "outcome")!;
  const showDeposits = t.deposits > 0 || touched.deposits !== undefined;
  return <form action={submitEodAction} className="form eod">
    <input type="hidden" name="token" value={token} /><input type="hidden" name="day" value={pre.day} /><input type="hidden" name="appointments" value={calls.map((c) => c.appointment_id).join(",")} />
    <div className={`card eod-top ${showDeposits ? "five" : ""}`}>
      <label>How many calls did you have today?<input type="number" name="calls_count" min={0} value={callsCount} onChange={(e) => setCallsCount(e.target.value)} /><span className="muted">{seen.calls} on your calendar</span></label>
      <label>Closes<input type="number" name="closes" min={0} value={touched.closes ?? String(t.closes)} onChange={(e) => setTouched((x) => ({ ...x, closes: e.target.value }))} /></label>
      {showDeposits ? <label>Deposits<input type="number" name="deposits" min={0} value={touched.deposits ?? String(t.deposits)} onChange={(e) => setTouched((x) => ({ ...x, deposits: e.target.value }))} /></label> : <input type="hidden" name="deposits" value={String(t.deposits)} />}
      <label>Cash collected ($)<input type="text" name="cash" inputMode="decimal" value={touched.cash ?? String(t.cash)} onChange={(e) => setTouched((x) => ({ ...x, cash: e.target.value }))} /><span className="muted">{seen.cash ? `$${seen.cash.toLocaleString("en-US")} seen in payments` : "nothing seen in payments today"}</span></label>
      <label>Revenue generated ($)<input type="text" name="revenue" inputMode="decimal" value={touched.revenue ?? String(t.revenue)} onChange={(e) => setTouched((x) => ({ ...x, revenue: e.target.value }))} /></label>
    </div>
    <h2>Your calls · {calls.length}</h2>
    {calls.length === 0 ? <div className="empty">No calls on your calendar for this day.</div> : null}
    {calls.map((c, i) => { const id = c.appointment_id; const nm = (k: string) => `c:${id}:${k}`; const after = fieldsFor(fields, c.outcome);
      return <div key={id} className="card eod-call">
        <input type="hidden" name={nm("contact_id")} value={c.contact_id} /><input type="hidden" name={nm("contact")} value={c.contact} /><input type="hidden" name={nm("starts_at")} value={c.starts_at} />
        <div className="eod-call-hd"><strong>{i + 1}. {c.contact}</strong><span className="muted">{time(c.starts_at)}</span>{c.href_contact ? <a href={c.href_contact} target="_blank" rel="noreferrer">CRM ↗</a> : null}{c.recording_url ? <a href={c.recording_url} target="_blank" rel="noreferrer">Recording ↗</a> : null}</div>
        <label>{outcomeField.label}{outcomeField.required ? <span className="req"> *</span> : null}<select name={nm("outcome")} value={c.outcome} required={outcomeField.required} onChange={(e) => set(i, { outcome: e.target.value as CallOutcome })}><option value="">—</option>{OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
        {after.length ? <div className="eod-sub">{after.map((f) => <Field key={f.key} f={f} name={nm(f.key)} value={valueOf(c, f.key)} onChange={(v) => setField(i, f.key, v)} />)}</div> : null}
      </div>; })}
    {dayFields(fields).map((f) => <DayField key={f.key} f={f} initial={dayAnswers[f.key] ?? ""} />)}
    <button className="btn btn-on eod-submit" type="submit">Submit my day</button>
  </form>;
}

function Field({ f, name, value, onChange }: { f: EodField; name: string; value: string; onChange: (v: string) => void }) {
  const label = <>{f.label}{f.required ? <span className="req"> *</span> : null}{f.help ? <span className="muted"> · {f.help}</span> : null}</>;
  const wide = f.type === "textarea";
  return <label className={wide ? "wide" : ""}>{label}
    {f.type === "select" ? <select name={name} value={value} required={f.required} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
      : f.type === "textarea" ? <textarea name={name} rows={2} value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />
      : f.type === "money" ? <input type="text" inputMode="decimal" name={name} value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />
      : f.type === "number" ? <input type="number" name={name} value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />
      : f.type === "date" ? <input type="date" name={name} value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />
      : <input type="text" name={name} value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />}
  </label>;
}

function DayField({ f, initial }: { f: EodField; initial: string }) {
  const [v, setV] = useState(initial);
  return <div className="card eod-day"><Field f={f} name={`d:${f.key}`} value={v} onChange={setV} /></div>;
}
