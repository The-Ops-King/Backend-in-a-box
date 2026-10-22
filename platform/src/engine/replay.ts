import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { dispatchEvent, emitEvent } from "./dispatch";
import { ensureOpportunityForBooking } from "./lifecycle";

/**
 * D138: an upcoming booking handed to the booked-call workflows as the poll hands a new one (the same event and context), for a
 * booking that has none running: a run cleared by a move up the ladder (its call still ahead), or a booking from before the
 * engine's first read (the baseline, `baseline: true`). Its stored `appointment.booked` is dispatched again; a baseline booking
 * has none, so one is recorded (an engine event, `replay: true`). Refused: a call already started, a cancelled booking, one with a run.
 */
export type ReplayRow = { appointment_id: string; who: string; starts_at: string; call_type: string; event: string | null; would: "replay" | "restart" | "skip"; why?: string; runs_started?: number };
/**
 * `again` (D142): a booking whose runs are all over is handed on again (its workflows changed, and what the old runs made was taken back with runs/undo); one still running is refused.
 * `force` (D200) with `again`: what the earlier runs already sent the person is sent again; without it, it is not.
 * `workflowId` (D195): hand each booking to that one workflow only (its pre-call, when its sends are unlocked): a booking that has a run
 * of it still going is skipped; its other workflows' runs (the booked card, the records) are never started again.
 * `restart` (D210, with `workflowId` and named bookings): a run of that workflow still going is stopped (exited, `restarted by the operator`,
 * its re-entry key freed) and the booking handed to the workflow afresh, so it starts from its first step again (a booking text a lock
 * held back goes now).
 */
export async function replayBookings(c: PoolClient, companyId: string, appointmentIds: string[], opts: { dryRun: boolean; baseline?: boolean; again?: boolean; force?: boolean; workflowId?: string; restart?: boolean }): Promise<ReplayRow[]> {
  const rows = await many<{ id: string; contact_id: string; starts_at: Date; status: string; self_booked: boolean | null; set_by: string | null; calendar_external: string | null; term_name: string; term_category: string; who: string; runs: number; live: number; event_id: string | null }>(c, `
    select a.id, a.contact_id, a.starts_at, a.status, a.self_booked, a.set_by, cal.external_id as calendar_external, t.name as term_name, t.category as term_category,
      trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as who, (select count(*)::int from runs r where r.appointment_id=a.id and ($3::uuid is null or r.workflow_id=$3)) as runs, (select count(*)::int from runs r where r.appointment_id=a.id and r.status not in ('completed','exited','failed') and ($3::uuid is null or r.workflow_id=$3)) as live,
      (select e.id::text from events e where e.appointment_id=a.id and e.event_type='appointment.booked' order by e.occurred_at desc limit 1) as event_id
    from appointments a join contacts ct on ct.id=a.contact_id join company_terms t on t.id=a.appointment_term left join calendars cal on cal.id=a.calendar_id
    where a.company_id=$1 and a.id = any($2::uuid[]) order by a.starts_at`, [companyId, appointmentIds, opts.workflowId ?? null]);
  const out: ReplayRow[] = [];
  for (const a of rows) {
    const base = { appointment_id: a.id, who: a.who, starts_at: a.starts_at.toISOString(), call_type: a.term_name, event: a.event_id };
    const restarting = !!(opts.restart && opts.workflowId && a.live > 0 && a.starts_at.getTime() > Date.now() && a.status !== "cancelled");
    if (restarting && !opts.dryRun) {
      await c.query(`update runs set status='exited', exit_reason='restarted by the operator', finished_at=now(), next_run_at=null, wake_on_reply=false, wake_on_tag=null, wake_on_event=null,
        reentry_key = reentry_key || ':restarted:' || id::text where appointment_id=$1 and workflow_id=$2 and status not in ('completed','exited','failed')`, [a.id, opts.workflowId]);
      a.live = 0;
    }
    if (restarting && opts.dryRun) { out.push({ ...base, would: "restart" }); continue; }
    const why = a.starts_at.getTime() <= Date.now() ? "the call has started" : a.status === "cancelled" ? "cancelled" : a.live > 0 ? "a run of it is still going" : a.runs > 0 && !opts.again && !opts.workflowId ? "it already has runs (again: true hands it on anyway)" : !a.event_id && !opts.baseline && !opts.workflowId ? "a baseline booking (no event): replay it with baseline: true" : null;
    if (why) { out.push({ ...base, would: "skip", why }); continue; }
    if (opts.dryRun) { out.push({ ...base, would: "replay" }); continue; }
    const stored = a.event_id ? (await one<Parameters<typeof dispatchEvent>[1]>(c, "select * from events where id=$1", [a.event_id]))! : null;
    // handed on again (D142): a new engine event like the stored one, since a workflow takes one event once
    // D195: handed to one workflow, a booking whose event a go-live cleared gets a new one like the poll's
    const ev = stored && (a.runs > 0 || opts.workflowId)
      ? await emitEvent(c, { company_id: companyId, contact_id: a.contact_id, opportunity_id: null, appointment_id: a.id, event_type: "appointment.booked", source: "engine", data: { ...(stored.data as Record<string, unknown>), replay: true, again: true, replays: stored.id, ...(opts.force ? { force: true } : {}) } })
      : stored ?? await emitEvent(c, { company_id: companyId, contact_id: a.contact_id, opportunity_id: null, appointment_id: a.id, event_type: "appointment.booked", source: "engine", data: { replay: true, source: "replay", calendar_id: a.calendar_external, status: a.status, starts_at: a.starts_at.toISOString(), self_booked: a.self_booked } });
    const oppId = await ensureOpportunityForBooking(c, companyId, a.contact_id, a.id, ev);
    const ctx = { contact: { id: a.contact_id }, appointment: { id: a.id, starts_at: a.starts_at.toISOString(), term: { name: a.term_name, category: a.term_category }, status: a.status, self_booked: a.self_booked, set_by: a.set_by }, opportunity: { id: oppId } };
    const started = await dispatchEvent(c, { ...ev, opportunity_id: oppId || null }, ctx, opts.workflowId ? { workflowId: opts.workflowId } : undefined);
    await c.query("insert into audit_log (company_id, action, target_type, after) values ($1,'booking.replayed','appointment',$2)", [companyId, { appointment: a.id, event: ev.id, runs: started.length, baseline: !a.event_id, ...(a.runs > 0 ? { again: true } : {}), ...(opts.workflowId ? { workflow: opts.workflowId } : {}), ...(restarting ? { restarted: true } : {}) }]);
    out.push({ ...base, would: restarting ? "restart" : "replay", runs_started: started.length });
  }
  return out;
}
