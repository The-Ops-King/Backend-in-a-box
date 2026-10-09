import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { parseDefinition, indexDefinition } from "./definition";
import { evaluate } from "./predicate";
import { reentryKey, windowInterval } from "./reentry";

export type EventRow = { id: number; company_id: string; contact_id: string | null; opportunity_id: string | null; appointment_id: string | null; event_type: string; occurred_at: Date; source: string; data: Record<string, unknown> };

export async function emitEvent(c: PoolClient, e: Omit<EventRow, "id" | "occurred_at"> & { occurred_at?: Date; run_id?: string | null }): Promise<EventRow> {
  const row = await one<EventRow>(c, `insert into events (company_id, contact_id, opportunity_id, appointment_id, run_id, event_type, occurred_at, source, data)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [e.company_id, e.contact_id, e.opportunity_id, e.appointment_id, e.run_id ?? null, e.event_type, e.occurred_at ?? new Date(), e.source, e.data]);
  return row!;
}

/** Creates a run unless the reentry policy says this contact/appointment already has one. Returns null when suppressed. */
export async function startRun(c: PoolClient, args: { companyId: string; workflowId: string; triggerId?: string | null; triggerNodeId: string; event: EventRow; contactId: string | null; userId?: string | null; appointmentId?: string | null; opportunityId?: string | null; schedule?: string }): Promise<string | null> {
  const wf = await one<{ current_version: number; enabled: boolean }>(c, "select current_version, enabled from workflows where id=$1", [args.workflowId]);
  if (!wf?.enabled) return null;
  const ver = await one<{ definition: unknown }>(c, "select definition from workflow_versions where workflow_id=$1 and version=$2", [args.workflowId, wf.current_version]);
  const def = parseDefinition(ver!.definition);
  const key = reentryKey(def, { contactId: args.contactId, userId: args.userId, appointmentId: args.appointmentId, opportunityId: args.opportunityId, eventId: args.event.id, now: new Date(), schedule: args.schedule });
  if (def.reentry === "once_per_contact_per_window" && args.contactId && !args.schedule) {   // sliding window, not epoch buckets: any run for this contact inside the window blocks a new one
    const recent = await one(c, `select 1 from runs where workflow_id=$1 and contact_id=$2 and started_at > now() - $3::interval limit 1`, [args.workflowId, args.contactId, windowInterval(def.reentry_window ?? "90d")]);
    if (recent) return null;
  }
  const row = await one<{ id: string }>(c, `insert into runs (company_id, workflow_id, workflow_version, contact_id, user_id, opportunity_id, appointment_id, trigger_id, triggered_by_event, status, current_node, next_run_at, context, reentry_key)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,now(),$11,$12)
    on conflict (workflow_id, reentry_key) do nothing returning id`,
    [args.companyId, args.workflowId, wf.current_version, args.contactId, args.userId ?? null, args.opportunityId ?? null, args.appointmentId ?? null, args.triggerId ?? null, args.event.id, args.triggerNodeId, { event: { ...args.event.data, _type: args.event.event_type, _source: args.event.source }, vars: {} }, key]);
  if (!row) {
    if (args.schedule) return null;   // this period already ran: nothing to remember
    // the key is held by a run still in flight: remember this trigger on it. If that run stops at a gate it replays us (D30: payment and signature in the same minute).
    await c.query(`update runs set pending_events = pending_events || $3::jsonb where workflow_id=$1 and reentry_key=$2 and status in ('active','waiting')`,
      [args.workflowId, key, JSON.stringify([{ event_id: args.event.id, trigger_id: args.triggerId ?? null, trigger_node_id: args.triggerNodeId, contact_id: args.contactId, appointment_id: args.appointmentId ?? null, opportunity_id: args.opportunityId ?? null }])]);
    return null;
  }
  // D45: a person is in a workflow once at a time; the newest run wins. An older run parked for this person (a pre-call for a
  // booking they replaced) exits; one mid-step (claimed inside the lease) is left to finish.
  if (args.contactId) {
    const older = await many<{ id: string; appointment_id: string | null }>(c, `update runs set status='exited', exit_reason='superseded: a newer run for this person', finished_at=now(), next_run_at=null, wake_on_reply=false
      where workflow_id=$1 and contact_id=$2 and id<>$3 and status in ('active','waiting') and (claimed_at is null or claimed_at < now() - interval '5 minutes') returning id, appointment_id`, [args.workflowId, args.contactId, row.id]);
    for (const o of older) await emitEvent(c, { company_id: args.companyId, contact_id: args.contactId, opportunity_id: null, appointment_id: o.appointment_id, run_id: o.id, event_type: "run.exited", source: "engine", data: { reason: "superseded", by_run: row.id } });
  }
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
    let nodes: ReturnType<typeof indexDefinition>["nodes"];
    // one workflow whose stored definition no longer parses (an old template version, a bad edit) must not take the whole poll down with it
    try { nodes = indexDefinition(parseDefinition(ver!.definition)).nodes; }
    catch (err) { await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'workflow.unparseable','workflow',$2,$3)", [e.company_id, t.workflow_id, { event: e.event_type, error: String((err as Error).message).slice(0, 300) }]); continue; }
    const node = nodes.get(t.node_id);
    if (!node || node.type !== "trigger") continue;
    if (node.match && !evaluate(node.match, { ...matchCtx, event: { ...e.data, _source: e.source, _type: e.event_type } })) continue;
    // an event about a person rather than a contact (eod.filed) names them in its data; one with neither has nothing to be about
    const userId = typeof e.data.user_id === "string" ? e.data.user_id : null;
    if (!e.contact_id && !userId) continue;
    const id = await startRun(c, { companyId: e.company_id, workflowId: t.workflow_id, triggerId: t.id, triggerNodeId: t.node_id, event: e, contactId: e.contact_id, userId, appointmentId: e.appointment_id, opportunityId: e.opportunity_id });
    if (id) started.push(id);
  }
  return started;
}
