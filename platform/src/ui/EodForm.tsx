"use client";
import { useState } from "react";
import type { CallEntry, EodPrefill } from "@/engine/eod";
import { submitEodAction } from "./eod-actions";

/**
 * The closer's day, prefilled and editable. A close shows revenue and cash; a follow-up shows the next date and steps.
 * Totals at the top follow the per-call answers unless the closer types their own.
 */
export function EodForm({ pre, token, tz }: { pre: EodPrefill; token: string; tz: string }) {
  const [calls, setCalls] = useState<CallEntry[]>(pre.calls);
  const [callsCount, setCallsCount] = useState(String(pre.calls_count));
  const [touched, setTouched] = useState<{ closes?: string; cash?: string; revenue?: string }>({});
  const closes = calls.filter((c) => c.outcome === "close").length;
  const cash = calls.reduce((s, c) => s + (c.outcome === "close" ? Number(c.cash ?? 0) : 0), 0);
  const revenue = calls.reduce((s, c) => s + (c.outcome === "close" ? Number(c.revenue ?? 0) : 0), 0);
  const set = (i: number, patch: Partial<CallEntry>) => setCalls((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  return <form action={submitEodAction} className="form eod">
    <input type="hidden" name="token" value={token} /><input type="hidden" name="day" value={pre.day} /><input type="hidden" name="appointments" value={calls.map((c) => c.appointment_id).join(",")} />
    <div className="card eod-top">
      <label>How many calls did you have today?<input type="number" name="calls_count" min={0} value={callsCount} onChange={(e) => setCallsCount(e.target.value)} /><span className="muted">{pre.calls_count} on your calendar</span></label>
      <label>Closes<input type="number" name="closes" min={0} value={touched.closes ?? String(closes)} onChange={(e) => setTouched((t) => ({ ...t, closes: e.target.value }))} /></label>
      <label>Cash collected ($)<input type="text" name="cash" inputMode="decimal" value={touched.cash ?? String(cash)} onChange={(e) => setTouched((t) => ({ ...t, cash: e.target.value }))} /><span className="muted">{pre.cash ? `$${pre.cash.toLocaleString("en-US")} seen in payments` : "nothing seen in payments today"}</span></label>
      <label>Revenue generated ($)<input type="text" name="revenue" inputMode="decimal" value={touched.revenue ?? String(revenue)} onChange={(e) => setTouched((t) => ({ ...t, revenue: e.target.value }))} /></label>
    </div>
    <h2>Your calls · {calls.length}</h2>
    {calls.length === 0 ? <div className="empty">No calls on your calendar for this day.</div> : null}
    {calls.map((c, i) => { const id = c.appointment_id; const nm = (k: string) => `c:${id}:${k}`;
      return <div key={id} className="card eod-call">
        <input type="hidden" name={nm("contact_id")} value={c.contact_id} /><input type="hidden" name={nm("contact")} value={c.contact} /><input type="hidden" name={nm("starts_at")} value={c.starts_at} />
        <div className="eod-call-hd"><strong>{i + 1}. {c.contact}</strong><span className="muted">{time(c.starts_at)}</span>{c.href_contact ? <a href={c.href_contact} target="_blank" rel="noreferrer">CRM ↗</a> : null}{c.recording_url ? <a href={c.recording_url} target="_blank" rel="noreferrer">Recording ↗</a> : null}</div>
        <div className="grid g2">
          <label>Did they show?<select name={nm("attendance")} value={c.attendance} onChange={(e) => { const v = e.target.value as CallEntry["attendance"]; set(i, { attendance: v, outcome: v === "no_show" ? "no_show" : c.outcome === "no_show" ? "" : c.outcome }); }}><option value="">—</option><option value="showed">Showed</option><option value="no_show">Didn't show</option></select></label>
          <label>What happened?<select name={nm("outcome")} value={c.outcome} onChange={(e) => set(i, { outcome: e.target.value as CallEntry["outcome"] })} disabled={c.attendance === "no_show"}><option value="">—</option><option value="close">Closed</option><option value="follow_up">Follow-up</option><option value="lost">Lost / not a fit</option><option value="no_show">No-show</option></select></label>
        </div>
        {c.outcome === "close" ? <div className="grid g2 eod-sub">
          <label>Revenue generated ($)<input type="text" inputMode="decimal" name={nm("revenue")} value={c.revenue ?? ""} onChange={(e) => set(i, { revenue: e.target.value === "" ? null : Number(e.target.value.replace(/[,$]/g, "")) || 0 })} /></label>
          <label>Cash collected ($)<input type="text" inputMode="decimal" name={nm("cash")} value={c.cash ?? ""} onChange={(e) => set(i, { cash: e.target.value === "" ? null : Number(e.target.value.replace(/[,$]/g, "")) || 0 })} /></label>
        </div> : null}
        {c.outcome === "follow_up" ? <div className="grid g2 eod-sub">
          <label>Next follow-up<input type="date" name={nm("next_date")} value={c.next_date ?? ""} onChange={(e) => set(i, { next_date: e.target.value || null })} /></label>
          <label>Next steps<input type="text" name={nm("next_steps")} value={c.next_steps} onChange={(e) => set(i, { next_steps: e.target.value })} /></label>
        </div> : null}
        {c.attendance !== "no_show" ? <div className="grid g3 eod-sub">
          <label>Pains<textarea name={nm("pains")} rows={2} value={c.pains} onChange={(e) => set(i, { pains: e.target.value })} /></label>
          <label>Goals<textarea name={nm("goals")} rows={2} value={c.goals} onChange={(e) => set(i, { goals: e.target.value })} /></label>
          <label>Objections<textarea name={nm("objections")} rows={2} value={c.objections} onChange={(e) => set(i, { objections: e.target.value })} /></label>
        </div> : null}
        <label>Notes<textarea name={nm("notes")} rows={2} value={c.notes} onChange={(e) => set(i, { notes: e.target.value })} /></label>
      </div>; })}
    <label>Anything else about today?<textarea name="general_notes" rows={2} /></label>
    <button className="btn btn-on eod-submit" type="submit">Submit my day</button>
  </form>;
}
