import type { PoolClient } from "pg";
import { one } from "@/db/client";

/**
 * D66. The create ledger: a step whose vendor write has no key of its own (a note, a task, a document, a card, a record)
 * claims a row here BEFORE calling the vendor and marks it done after. A retry that finds the claim knows the write may
 * already be there: done → reuse what the vendor gave back; still pending (the vendor never answered) → not asked twice.
 * A vendor that answered with an error did not write, so the runner releases the pending claim and the retry starts clean.
 */
export type EffectKind = "note" | "task" | "document" | "card" | "record";
export type Claim = { fresh: true } | { fresh: false; done: boolean; external_id: string | null };

export async function claimEffect(c: PoolClient, companyId: string, runId: string, nodeId: string, kind: EffectKind): Promise<Claim> {
  const row = await one<{ id: string }>(c, "insert into step_effects (company_id, run_id, node_id, kind) values ($1,$2,$3,$4) on conflict (run_id, node_id, kind) do nothing returning id", [companyId, runId, nodeId, kind]);
  if (row) return { fresh: true };
  const ex = await one<{ external_id: string | null; done_at: Date | null }>(c, "select external_id, done_at from step_effects where run_id=$1 and node_id=$2 and kind=$3", [runId, nodeId, kind]);
  return { fresh: false, done: !!ex?.done_at, external_id: ex?.external_id ?? null };
}

export const markEffect = (c: PoolClient, runId: string, nodeId: string, kind: EffectKind, externalId?: string | null) =>
  c.query("update step_effects set done_at=now(), external_id=coalesce($4, external_id) where run_id=$1 and node_id=$2 and kind=$3", [runId, nodeId, kind, externalId ?? null]);

/** The vendor answered with an error: nothing was written, so the claim comes off and the next try may ask again. */
export const releasePending = (c: PoolClient, runId: string, nodeId: string) => c.query("delete from step_effects where run_id=$1 and node_id=$2 and done_at is null", [runId, nodeId]);

/** The words for a step that found its own claim: what it reused, or why it did not ask twice. */
export const PENDING_WHY = "asked the CRM once already and never heard back; not written twice (check the CRM, then retry or skip)";
