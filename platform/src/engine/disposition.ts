import type { PoolClient } from "pg";
import { one } from "@/db/client";
import { dispatchEvent, emitEvent } from "./dispatch";

export type DispositionInput = { companyId: string; appointmentId: string; outcomeTermId: string; callOutcomeTermId?: string | null; notes?: string; userId?: string | null };
type OutcomeSource = "disposition" | "engine";

/**
 * The outcome is written onto OUR appointment row (never GHL), then the journey gets appointment.outcome and, if they
 * showed, call.held. Both the closer's form and a workflow step (a recording proves the show) land here.
 */
export async function applyOutcome(c: PoolClient, args: { companyId: string; appointmentId: string; outcomeTermId: string; callOutcomeTermId?: string | null; notes?: string; userId?: string | null; dispositionId?: string | null; source: OutcomeSource; runId?: string | null; by?: string }): Promise<{ events: number; runs: number; outcome: string }> {
  const a = await one<{ id: string; contact_id: string; opportunity_id: string | null; appointment_term: string; term_category: string }>(c,
    "select a.id, a.contact_id, a.opportunity_id, a.appointment_term, t.category as term_category from appointments a join company_terms t on t.id=a.appointment_term where a.id=$1 and a.company_id=$2", [args.appointmentId, args.companyId]);
  if (!a) throw new Error("appointment not found");
  const outcome = await one<{ category: string; name: string }>(c, "select category, name from company_terms where id=$1 and company_id=$2 and domain='appointment_outcome'", [args.outcomeTermId, args.companyId]);
  if (!outcome) throw new Error("outcome term not found");
  const callOutcome = args.callOutcomeTermId ? await one<{ category: string }>(c, "select category from company_terms where id=$1 and company_id=$2 and domain='call_outcome'", [args.callOutcomeTermId, args.companyId]) : null;
  await c.query("update appointments set outcome_term=$2, call_outcome_term=coalesce($3, call_outcome_term), disposition_id=coalesce($4, disposition_id), dispositioned_at=now(), dispositioned_by=coalesce($5, dispositioned_by) where id=$1",
    [a.id, args.outcomeTermId, args.callOutcomeTermId ?? null, args.dispositionId ?? null, args.userId ?? null]);
  const base = { company_id: args.companyId, contact_id: a.contact_id, opportunity_id: a.opportunity_id, appointment_id: a.id, source: args.source, run_id: args.runId ?? null };
  const ctx = { contact: { id: a.contact_id }, appointment: { id: a.id, term: { category: a.term_category } } };
  let events = 0, runs = 0;
  const ev1 = await emitEvent(c, { ...base, event_type: "appointment.outcome", data: { outcome: outcome.category, label: outcome.name, by: args.by ?? args.source } }); events++;
  runs += (await dispatchEvent(c, ev1, ctx)).length;
  if (outcome.category === "showed") {
    const ev2 = await emitEvent(c, { ...base, event_type: "call.held", data: { type: a.term_category, outcome: callOutcome?.category ?? null, notes: args.notes ? args.notes.slice(0, 500) : undefined, by: args.by ?? args.source } }); events++;
    runs += (await dispatchEvent(c, ev2, ctx)).length;
    if (callOutcome?.category === "lost" && a.opportunity_id) {
      await c.query("update opportunities set status='lost', lost_at=now() where id=$1 and status='open'", [a.opportunity_id]);
      await emitEvent(c, { ...base, event_type: "opportunity.lost", data: { by: "closer_marks" } }); events++;
    }
  }
  return { events, runs, outcome: outcome.category };
}

/** The outcome term a company uses for a core category (showed, noshow, …). */
export async function outcomeTermFor(c: PoolClient, companyId: string, category: string): Promise<string | null> {
  const t = await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_outcome' and category=$2 and active order by is_default desc, sort limit 1", [companyId, category]);
  return t?.id ?? null;
}

/** D8/D12: the disposition form. One default form per company per call type, created on first use. */
export async function recordDisposition(c: PoolClient, d: DispositionInput): Promise<{ events: number; runs: number }> {
  const a = await one<{ id: string; contact_id: string; appointment_term: string }>(c, "select id, contact_id, appointment_term from appointments where id=$1 and company_id=$2", [d.appointmentId, d.companyId]);
  if (!a) throw new Error("appointment not found");
  const outcome = await one<{ category: string }>(c, "select category from company_terms where id=$1 and company_id=$2 and domain='appointment_outcome'", [d.outcomeTermId, d.companyId]);
  if (!outcome) throw new Error("outcome term not found");
  const callOutcome = d.callOutcomeTermId ? await one<{ category: string }>(c, "select category from company_terms where id=$1 and company_id=$2 and domain='call_outcome'", [d.callOutcomeTermId, d.companyId]) : null;
  let form = await one<{ id: string; version: number }>(c, "select id, version from forms where company_id=$1 and purpose='disposition' and appointment_term=$2", [d.companyId, a.appointment_term]);
  if (!form) form = await one<{ id: string; version: number }>(c, `insert into forms (company_id, purpose, appointment_term, name, fields) values ($1,'disposition',$2,'Disposition',$3) returning id, version`,
    [d.companyId, a.appointment_term, JSON.stringify([{ key: "outcome", label: "Did they show?", type: "enum", required: true }, { key: "call_outcome", label: "How did the call go?", type: "enum" }, { key: "notes", label: "Notes", type: "text" }])]);
  const sub = await one<{ id: string }>(c, `insert into form_submissions (company_id, form_id, form_version, contact_id, appointment_id, submitted_by, answers) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [d.companyId, form!.id, form!.version, a.contact_id, a.id, d.userId ?? null, { outcome: outcome.category, call_outcome: callOutcome?.category ?? null, notes: d.notes ?? "" }]);
  const r = await applyOutcome(c, { companyId: d.companyId, appointmentId: d.appointmentId, outcomeTermId: d.outcomeTermId, callOutcomeTermId: d.callOutcomeTermId, notes: d.notes, userId: d.userId, dispositionId: sub!.id, source: "disposition" });
  return { events: r.events, runs: r.runs };
}
