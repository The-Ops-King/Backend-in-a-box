import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters, Company, LiveCard } from "@/adapters/types";
import { handMoved, type HandMove } from "./card-moves";

/**
 * D41: the CRM is the truth about cards. Before the engine reads a contact's cards it asks the CRM what is open for
 * them and folds that into `pipeline_cards`: a card the engine never made (a GHL workflow, a human) is adopted; a
 * known card takes the stage, name and status the CRM shows. Rows are never deleted on absence (the CRM's search
 * index lags a few seconds behind a create), so a card the engine just made is still there on the next read.
 * In shadow the engine's own cards have no CRM id; a live card on the same board outranks them (see `pickCard`).
 * D61: a known card whose stage or status differs from the replica, with a CRM stamp newer than our last write to
 * it, was moved by a hand (or a CRM workflow), never by us: `foldCard` reports it and `handMoved` records it.
 */
export type CardRow = { id: string; ghl_opportunity_id: string | null; opportunity_id: string; ghl_stage_id: string; name: string; status: string };

/** One live card into the replica: adopted when unknown (and open), updated when known. Returns the hand move it revealed, if any. */
export async function foldCard(c: PoolClient, companyId: string, contactId: string, card: LiveCard): Promise<HandMove | null> {
  const owner = card.assignedUserId ? await one<{ id: string }>(c, "select id from users where company_id=$1 and ghl_user_id=$2", [companyId, card.assignedUserId]) : null;
  const known = await one<{ id: string; updated_at: Date; ghl_stage_id: string; status: string; opportunity_id: string }>(c, "select id, updated_at, ghl_stage_id, status, opportunity_id from pipeline_cards where company_id=$1 and ghl_opportunity_id=$2", [companyId, card.id]);
  if (known) {
    // the CRM's search index lags its writes by a few seconds: a snapshot older than our last write to that card is the past, not the truth
    const liveAt = Date.parse(card.updatedAt); if (Number.isFinite(liveAt) && liveAt < known.updated_at.getTime()) return null;
    // a card marked gone on a 404 that the CRM lists again was never a hand's move: the replica takes it back quietly
    const moved = known.status !== "gone" && (known.ghl_stage_id !== card.stageId || known.status !== card.status);
    await c.query("update pipeline_cards set ghl_pipeline_id=$2, ghl_stage_id=$3, name=$4, status=$5, assigned_user_id=coalesce($6, assigned_user_id), updated_at=now() where id=$1", [known.id, card.pipelineId, card.stageId, card.name, card.status, owner?.id ?? null]);
    return moved ? { contactId, cardId: known.id, opportunityId: known.opportunity_id, crmCardId: card.id, pipelineId: card.pipelineId, fromStage: known.ghl_stage_id, toStage: card.stageId, fromStatus: known.status, toStatus: card.status, movedBy: card.updatedBy, at: Number.isFinite(liveAt) ? new Date(liveAt) : new Date() } : null;
  }
  if (card.status !== "open") return null;   // a closed card the engine never touched is history, not state
  // the pursuit the adopted card belongs to: the contact's open one, else a new one opened by the CRM
  let oppId = (await one<{ id: string }>(c, "select id from opportunities where company_id=$1 and contact_id=$2 and status='open' order by opened_at desc limit 1", [companyId, contactId]))?.id;
  if (!oppId) oppId = (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, opened_by) values ($1,$2,'crm') returning id", [companyId, contactId]))!.id;
  await c.query("insert into pipeline_cards (company_id, opportunity_id, contact_id, ghl_opportunity_id, ghl_pipeline_id, ghl_stage_id, name, assigned_user_id, status) values ($1,$2,$3,$4,$5,$6,$7,$8,'open')", [companyId, oppId, contactId, card.id, card.pipelineId, card.stageId, card.name, owner?.id ?? null]);
  return null;
}

export async function syncCards(c: PoolClient, company: { id: string }, adapterCompany: Company, adapters: Adapters, contactId: string, ghlContactId: string | null | undefined): Promise<LiveCard[]> {
  if (!ghlContactId) return [];
  const live = await adapters.read.openCards(adapterCompany, ghlContactId);
  for (const card of live) {
    const move = await foldCard(c, company.id, contactId, card);
    if (move) await handMoved(c, company.id, adapters, move);
  }
  return live;
}

/** The contact's open card on a board: one the CRM knows first, then the newest. */
export async function pickCard(c: PoolClient, companyId: string, contactId: string, pipelineId: string): Promise<CardRow | null> {
  return (await one<CardRow>(c, "select id, ghl_opportunity_id, opportunity_id, ghl_stage_id, name, status from pipeline_cards where company_id=$1 and contact_id=$2 and ghl_pipeline_id=$3 and status='open' order by (ghl_opportunity_id is not null) desc, updated_at desc, created_at desc limit 1", [companyId, contactId, pipelineId])) ?? null;
}

export const openCardRows = (c: PoolClient, companyId: string, contactId: string) => many<CardRow & { ghl_pipeline_id: string }>(c, "select id, ghl_opportunity_id, opportunity_id, ghl_pipeline_id, ghl_stage_id, name, status from pipeline_cards where company_id=$1 and contact_id=$2 and status='open'", [companyId, contactId]);

/** The contact's most recent card on a board, open or closed (never one the CRM said is gone): what a changed answer moves back. */
export async function latestCard(c: PoolClient, companyId: string, contactId: string, pipelineId: string): Promise<CardRow | null> {
  return (await one<CardRow>(c, "select id, ghl_opportunity_id, opportunity_id, ghl_stage_id, name, status from pipeline_cards where company_id=$1 and contact_id=$2 and ghl_pipeline_id=$3 and status<>'gone' order by (ghl_opportunity_id is not null) desc, updated_at desc, created_at desc limit 1", [companyId, contactId, pipelineId])) ?? null;
}
