import type { PoolClient } from "pg";
import { one } from "@/db/client";
import { dispatchEvent, emitEvent } from "./dispatch";

export type DispositionInput = { companyId: string; appointmentId: string; outcomeTermId: string; callOutcomeTermId?: string | null; notes?: string; userId?: string | null };

/** D8/D12: the disposition form writes the outcome onto OUR appointment row (never GHL), then the journey gets appointment.outcome and, if they showed, call.held. */
export async function recordDisposition(c: PoolClient, d: DispositionInput): Promise<{ events: number; runs: number }> {
  const a = await one<{ id: string; contact_id: string; opportunity_id: string | null; appointment_term: string; term_category: string }>(c,
    "select a.id, a.contact_id, a.opportunity_id, a.appointment_term, t.category as term_category from appointments a join company_terms t on t.id=a.appointment_term where a.id=$1 and a.company_id=$2", [d.appointmentId, d.companyId]);
  if (!a) throw new Error("appointment not found");
  const outcome = await one<{ category: string; name: string }>(c, "select category, name from company_terms where id=$1 and company_id=$2 and domain='appointment_outcome'", [d.outcomeTermId, d.companyId]);
  if (!outcome) throw new Error("outcome term not found");
  const callOutcome = d.callOutcomeTermId ? await one<{ category: string }>(c, "select category from company_terms where id=$1 and company_id=$2 and domain='call_outcome'", [d.callOutcomeTermId, d.companyId]) : null;

  // one default disposition form per company per call type, created on first use
  let form = await one<{ id: string; version: number }>(c, "select id, version from forms where company_id=$1 and purpose='disposition' and appointment_term=$2", [d.companyId, a.appointment_term]);
  if (!form) form = await one<{ id: string; version: number }>(c, `insert into forms (company_id, purpose, appointment_term, name, fields) values ($1,'disposition',$2,'Disposition',$3) returning id, version`,
    [d.companyId, a.appointment_term, JSON.stringify([{ key: "outcome", label: "Did they show?", type: "enum", required: true }, { key: "call_outcome", label: "How did the call go?", type: "enum" }, { key: "notes", label: "Notes", type: "text" }])]);
  const sub = await one<{ id: string }>(c, `insert into form_submissions (company_id, form_id, form_version, contact_id, appointment_id, submitted_by, answers) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [d.companyId, form!.id, form!.version, a.contact_id, a.id, d.userId ?? null, { outcome: outcome.category, call_outcome: callOutcome?.category ?? null, notes: d.notes ?? "" }]);
  await c.query("update appointments set outcome_term=$2, call_outcome_term=$3, disposition_id=$4, dispositioned_at=now(), dispositioned_by=$5 where id=$1", [a.id, d.outcomeTermId, d.callOutcomeTermId ?? null, sub!.id, d.userId ?? null]);

  const base = { company_id: d.companyId, contact_id: a.contact_id, opportunity_id: a.opportunity_id, appointment_id: a.id, source: "disposition" as const };
  const ctx = { contact: { id: a.contact_id }, appointment: { id: a.id, term: { category: a.term_category } } };
  let events = 0, runs = 0;
  const ev1 = await emitEvent(c, { ...base, event_type: "appointment.outcome", data: { outcome: outcome.category, label: outcome.name } }); events++;
  runs += (await dispatchEvent(c, ev1, ctx)).length;
  if (outcome.category === "showed") {
    const ev2 = await emitEvent(c, { ...base, event_type: "call.held", data: { type: a.term_category, outcome: callOutcome?.category ?? null, notes: d.notes ? d.notes.slice(0, 500) : undefined } }); events++;
    runs += (await dispatchEvent(c, ev2, ctx)).length;
    if (callOutcome?.category === "lost" && a.opportunity_id) {
      await c.query("update opportunities set status='lost', lost_at=now() where id=$1 and status='open'", [a.opportunity_id]);
      await emitEvent(c, { ...base, event_type: "opportunity.lost", data: { by: "closer_marks" } }); events++;
    }
  }
  return { events, runs };
}
