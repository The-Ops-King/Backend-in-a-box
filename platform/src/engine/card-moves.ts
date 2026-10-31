import type { PoolClient } from "pg";
import { one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { loadCompany } from "./context";
import { dispatchEvent, emitEvent, type EventRow } from "./dispatch";
import { standsSql } from "./held";

/**
 * D61: a card moved by a hand in the CRM (a closer dragging it, a CRM workflow), seen by the poll or by a run's read
 * of the contact's cards. The replica already took the CRM's stage (`foldCard`); this records the fact: a `card.moved`
 * event on the contact, about their latest closing call. What follows is the "Card moved by hand" workflow's (D88): the
 * line in the booking post's thread, and for the stages that name an outcome (the closer's No Show / Cancelled, Lost,
 * Disqualified; the setter's No-Show / Cancel / Reschedule) the outcome filed on the call once it has started, the way
 * the end-of-day form files it. Nothing here writes a card's status: the replica took the status the CRM returned.
 */
export type HandMove = { contactId: string; cardId: string; opportunityId: string; crmCardId: string; pipelineId: string; fromStage: string; toStage: string; fromStatus: string; toStatus: string; movedBy?: string; at: Date };

const titleWords = (s: string) => s.replace(/[_.-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (ch) => ch.toUpperCase());
/** The board a pipeline id is bound as (`crm.pipeline_closer` → closer), and a stage's words from its binding key (`crm.stage_closer_follow_up` → Follow Up). */
export const boardOf = (bindings: Record<string, string>, pipelineId: string): string | null => Object.entries(bindings).find(([k, v]) => k.startsWith("crm.pipeline_") && v === pipelineId)?.[0].slice("crm.pipeline_".length) ?? null;
export const stageWords = (bindings: Record<string, string>, board: string | null, stageId: string): string => {
  const prefix = `crm.stage_${board ?? ""}_`;
  const key = Object.entries(bindings).find(([k, v]) => k.startsWith(prefix) && v === stageId)?.[0];
  return key ? titleWords(key.slice(prefix.length)) : stageId;
};

export async function handMoved(c: PoolClient, companyId: string, _adapters: Adapters, m: HandMove): Promise<{ event: EventRow; runs: string[] }> {
  const { bindings } = await loadCompany(c, companyId);
  const board = boardOf(bindings, m.pipelineId);
  const boardWords = board ?? "pipeline";
  const fromName = stageWords(bindings, board, m.fromStage), toName = stageWords(bindings, board, m.toStage);
  const mover = m.movedBy ? await one<{ id: string; name: string }>(c, "select id, name from users where company_id=$1 and ghl_user_id=$2", [companyId, m.movedBy]) : null;
  // the booking the move is about: the contact's latest closing call not cancelled before its start (D275; the no-show / lost / DQ it names, the post its line goes under)
  const appt = await one<{ id: string }>(c, `select a.id from appointments a join company_terms t on t.id=a.appointment_term
    where a.company_id=$1 and a.contact_id=$2 and t.category='closing' and ${standsSql("a")} order by a.starts_at desc limit 1`, [companyId, m.contactId]);
  const event = await emitEvent(c, { company_id: companyId, contact_id: m.contactId, opportunity_id: m.opportunityId, appointment_id: appt?.id ?? null, event_type: "card.moved", source: "ghl_poll", occurred_at: m.at,
    data: { pipeline: boardWords, pipeline_id: m.pipelineId, from_stage: m.fromStage, to_stage: m.toStage, from_name: fromName, to_name: toName, from_status: m.fromStatus, to_status: m.toStatus, by: "crm", mover: mover?.name ?? null, mover_id: mover?.id ?? null, crm_card: m.crmCardId } });
  const runs = await dispatchEvent(c, event, { contact: { id: m.contactId }, ...(appt ? { appointment: { id: appt.id } } : {}) });
  return { event, runs };
}
