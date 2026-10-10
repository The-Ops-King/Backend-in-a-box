import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { loadCompany } from "./context";
import { decrypt } from "./crypto";
import { dispatchEvent, emitEvent, type EventRow } from "./dispatch";
import { outcomeTermFor, recordDisposition } from "./disposition";

/**
 * D61: a card moved by a hand in the CRM (a closer dragging it, a CRM workflow), seen by the poll or by a run's read
 * of the contact's cards. The replica already took the CRM's stage (`foldCard`); this records the fact — a
 * `card.moved` event on the contact, a line in the booking post's thread — and, for the stages that name an outcome
 * (the closer's No Show / Cancelled, Lost, Disqualified; the setter's No-Show / Cancel / Reschedule), files that
 * outcome on the appointment the way the end-of-day form does, so the appointment data stays true. Follow Up and
 * Financing Pending are the closer's own stages: noted, nothing filed. Nothing here writes a card's status: the
 * replica took the status the CRM returned, and the owner's rule (setter lost on a no-show) is Call outcome filed's
 * step, which only ever marks an open card.
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

export async function handMoved(c: PoolClient, companyId: string, adapters: Adapters, m: HandMove): Promise<{ event: EventRow; posted: boolean; filed: string | null }> {
  const { row: company, bindings } = await loadCompany(c, companyId);
  const board = boardOf(bindings, m.pipelineId);
  const boardWords = board ?? "pipeline";
  const fromName = stageWords(bindings, board, m.fromStage), toName = stageWords(bindings, board, m.toStage);
  const mover = m.movedBy ? await one<{ id: string; name: string }>(c, "select id, name from users where company_id=$1 and ghl_user_id=$2", [companyId, m.movedBy]) : null;
  const who = mover?.name ?? "someone";
  // the booking the move is about: the contact's latest closing call that was not cancelled (the no-show / lost / DQ it names, the post its line goes under)
  const appt = await one<{ id: string; starts_at: Date; outcome: string | null; call_outcome: string | null }>(c, `select a.id, a.starts_at, ot.category as outcome, cot.category as call_outcome from appointments a join company_terms t on t.id=a.appointment_term
    left join company_terms ot on ot.id=a.outcome_term left join company_terms cot on cot.id=a.call_outcome_term where a.company_id=$1 and a.contact_id=$2 and t.category='closing' and a.status<>'cancelled' order by a.starts_at desc limit 1`, [companyId, m.contactId]);
  const stageChanged = m.fromStage !== m.toStage, statusChanged = m.fromStatus !== m.toStatus;
  const event = await emitEvent(c, { company_id: companyId, contact_id: m.contactId, opportunity_id: m.opportunityId, appointment_id: appt?.id ?? null, event_type: "card.moved", source: "ghl_poll", occurred_at: m.at,
    data: { pipeline: boardWords, pipeline_id: m.pipelineId, from_stage: m.fromStage, to_stage: m.toStage, from_name: fromName, to_name: toName, from_status: m.fromStatus, to_status: m.toStatus, by: "crm", mover: mover?.name ?? null, crm_card: m.crmCardId } });
  await dispatchEvent(c, event, { contact: { id: m.contactId }, ...(appt ? { appointment: { id: appt.id } } : {}) });
  const text = stageChanged ? `🗂️ ${who} moved the ${boardWords} card to ${toName}${statusChanged ? ` and marked it ${m.toStatus}` : ""}` : `🗂️ ${who} marked the ${boardWords} card ${m.toStatus}`;
  // the line goes under the booking post when there is one (booked before the engine, or Slack unbound: nothing to reply to); recorded in sends like every other message
  const post = appt ? await one<{ channel: string; ts: string }>(c, "select channel, ts from slack_posts where company_id=$1 and tag=$2", [companyId, `appointment:${appt.id}`]) : null;
  const conn = post ? await one<{ bot_token: Buffer }>(c, "select bot_token from slack_connections where company_id=$1", [companyId]) : null;
  const status = conn && post ? (company.mode === "shadow" ? "shadow" : "sent") : "suppressed";
  await c.query(`insert into sends (company_id, contact_id, run_id, channel, idempotency_key, rendered_body, status, suppressed_reason, scheduled_for, sent_at) values ($1,$2,null,'slack',$3,$4,$5,$6,now(),case when $5 in ('sent','shadow') then now() end)`,
    [companyId, m.contactId, `card-moved:${event.id}:${randomUUID()}`, text, status, status === "suppressed" ? (post ? "unbound: slack" : "no post to reply to") : null]);
  let posted = false;
  if (conn && post) { try { await adapters.notifier.post(decrypt(conn.bot_token), post.channel, text, { name: "Card moved", icon: ":card_index_dividers:" }, post.ts); posted = true; } catch { /* Slack down: the event and the replica are the record; the thread line is a courtesy */ } }
  // the stages that name an outcome file it, once the call time has passed (a future call dragged to No Show / Cancelled is a cancel, not a no-show; the calendar poll carries those)
  let filed: string | null = null;
  if (appt && appt.starts_at.getTime() <= Date.now() && stageChanged) {
    const want = board === "closer" ? (m.toStage === bindings["crm.stage_closer_cancelled"] ? { outcome: "noshow", call: null } : m.toStage === bindings["crm.stage_closer_lost"] ? { outcome: "showed", call: "lost" } : m.toStage === bindings["crm.stage_closer_disqualified"] ? { outcome: "showed", call: "unqualified" } : null)
      : board === "setter" && m.toStage === bindings["crm.stage_setter_cancelled"] ? { outcome: "noshow", call: null } : null;
    const already = want && (want.call ? appt.call_outcome === want.call : appt.outcome === want.outcome);
    if (want && !already) {
      const outcomeTermId = await outcomeTermFor(c, companyId, want.outcome);
      const callTermId = want.call ? (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category=$2 and active order by is_default desc, sort limit 1", [companyId, want.call]))?.id ?? null : null;
      if (outcomeTermId && (!want.call || callTermId)) {
        await recordDisposition(c, { companyId, appointmentId: appt.id, outcomeTermId, callOutcomeTermId: callTermId, notes: `Card moved to ${toName} in the CRM by ${who}`, userId: mover?.id ?? null });
        filed = want.call ?? want.outcome;
      }
    }
  }
  return { event, posted, filed };
}
