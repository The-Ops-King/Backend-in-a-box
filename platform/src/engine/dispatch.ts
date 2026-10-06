import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { parseDefinition, indexDefinition } from "./definition";
import { evaluate } from "./predicate";
import { reentryKey } from "./reentry";

export type EventRow = { id: number; company_id: string; contact_id: string | null; opportunity_id: string | null; appointment_id: string | null; event_type: string; occurred_at: Date; source: string; data: Record<string, unknown> };

export async function emitEvent(c: PoolClient, e: Omit<EventRow, "id" | "occurred_at"> & { occurred_at?: Date; run_id?: string | null }): Promise<EventRow> {
  const row = await one<EventRow>(c, `insert into events (company_id, contact_id, opportunity_id, appointment_id, run_id, event_type, occurred_at, source, data)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [e.company_id, e.contact_id, e.opportunity_id, e.appointment_id, e.run_id ?? null, e.event_type, e.occurred_at ?? new Date(), e.source, e.data]);
  return row!;
}

/** Creates a run unless the reentry policy says this contact/appointment already has one. Returns null when suppressed. */
export async function startRun(c: PoolClient, args: { companyId: string; workflowId: string; triggerId?: string | null; triggerNodeId: string; event: EventRow; contactId: string; appointmentId?: string | null; opportunityId?: string | null }): Promise<string | null> {
  const wf = await one<{ current_version: number; enabled: boolean }>(c, "select current_version, enabled from workflows where id=$1", [args.workflowId]);
  if (!wf?.enabled) return null;
  const ver = await one<{ definition: unknown }>(c, "select definition from workflow_versions where workflow_id=$1 and version=$2", [args.workflowId, wf.current_version]);
  const def = parseDefinition(ver!.definition);
  const key = reentryKey(def, { contactId: args.contactId, appointmentId: args.appointmentId, opportunityId: args.opportunityId, eventId: args.event.id, now: new Date() });
  const row = await one<{ id: string }>(c, `insert into runs (company_id, workflow_id, workflow_version, contact_id, opportunity_id, appointment_id, trigger_id, triggered_by_event, status, current_node, next_run_at, context, reentry_key)
    values ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,now(),$10,$11)
    on conflict (workflow_id, reentry_key) do nothing returning id`,
    [args.companyId, args.workflowId, wf.current_version, args.contactId, args.opportunityId ?? null, args.appointmentId ?? null, args.triggerId ?? null, args.event.id, args.triggerNodeId, { event: args.event.data, vars: {} }, key]);
  if (!row) return null;
  await emitEvent(c, { company_id: args.companyId, contact_id: args.contactId, opportunity_id: args.opportunityId ?? null, appointment_id: args.appointmentId ?? null, run_id: row.id, event_type: "run.started", source: "engine", data: { workflow_id: args.workflowId, trigger_node: args.triggerNodeId } });
  return row.id;
}

/** Event in → every enabled trigger that matches → a run each (subject to reentry). */
export async function dispatchEvent(c: PoolClient, e: EventRow, matchCtx: Record<string, unknown>): Promise<string[]> {
  const triggers = await many<{ id: string; workflow_id: string; node_id: string; match: unknown }>(c, `
    select t.id, t.workflow_id, t.node_id, t.match from workflow_triggers t join workflows w on w.id=t.workflow_id
    where t.company_id=$1 and t.event_type=$2 and t.enabled and w.enabled`, [e.company_id, e.event_type]);
  const started: string[] = [];
  for (const t of triggers) {
    const ver = await one<{ definition: unknown }>(c, "select v.definition from workflow_versions v join workflows w on w.id=v.workflow_id and w.current_version=v.version where w.id=$1", [t.workflow_id]);
    const { nodes } = indexDefinition(parseDefinition(ver!.definition));
    const node = nodes.get(t.node_id);
    if (!node || node.type !== "trigger") continue;
    if (node.match && !evaluate(node.match, { ...matchCtx, event: { ...e.data, _source: e.source, _type: e.event_type } })) continue;
    if (!e.contact_id) continue;
    const id = await startRun(c, { companyId: e.company_id, workflowId: t.workflow_id, triggerId: t.id, triggerNodeId: t.node_id, event: e, contactId: e.contact_id, appointmentId: e.appointment_id, opportunityId: e.opportunity_id });
    if (id) started.push(id);
  }
  return started;
}
