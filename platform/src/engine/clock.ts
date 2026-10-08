import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { many, one } from "@/db/client";
import { parseDefinition, indexDefinition, type Schedule } from "./definition";
import { periodOf } from "./when";
export { periodOf, everyMinutes, scheduleWords } from "./when";
import { emitEvent, startRun } from "./dispatch";

/**
 * D35: the clock is a trigger like any other. A trigger node with event "schedule" starts a run when its time comes,
 * once per period per subject (the company, or each closer), through the same startRun and reentry key as an event
 * would, so the run shows up on the workflow page, in the timeline and in the alerts like everything else. Nothing on
 * a timer lives outside a workflow any more: end-of-day reminders, the health sweep, the wrap-ups all hang off this.
 */
export type ClockReport = { started: { company: string; workflow: string; node: string; period: string; user?: string }[]; errors: { company: string; workflow: string; error: string }[] };

/** Every enabled schedule trigger whose period has come and has not run: a run per subject. Called every tick, before the runs advance, so the new run executes this tick. */
export async function dispatchSchedules(c: PoolClient, now = DateTime.now(), onlyCompanyId?: string): Promise<ClockReport> {
  const out: ClockReport = { started: [], errors: [] };
  const trigs = await many<{ id: string; workflow_id: string; node_id: string; company_id: string; slug: string; timezone: string; name: string }>(c, `
    select t.id, t.workflow_id, t.node_id, co.id as company_id, co.slug, co.timezone, w.name from workflow_triggers t join workflows w on w.id=t.workflow_id join companies co on co.id=t.company_id
    where t.event_type='schedule' and t.enabled and w.enabled and co.status in ('active','hosted') and ($1::uuid is null or co.id=$1) order by co.slug, w.name`, [onlyCompanyId ?? null]);
  for (const t of trigs) {
    try {
      const ver = await one<{ definition: unknown }>(c, "select v.definition from workflow_versions v join workflows w on w.id=v.workflow_id and w.current_version=v.version where w.id=$1", [t.workflow_id]);
      const node = indexDefinition(parseDefinition(ver!.definition)).nodes.get(t.node_id);
      if (!node || node.type !== "trigger" || !node.schedule) continue;
      const local = now.setZone(t.timezone);
      const period = periodOf(node.schedule, local); if (!period) continue;
      const subjects: { id: string | null; name?: string }[] = node.schedule.for === "closer"
        ? await many<{ id: string; name: string }>(c, "select id, name from users where company_id=$1 and active and role='closer' order by name", [t.company_id]) : [{ id: null }];
      for (const who of subjects) {
        const key = `schedule:${t.node_id}:${period}${who.id ? `:${who.id}` : ""}`;
        // this period ran, or is running; a run that stopped at a check carries a ":gate:" suffix on its key (D30) and still counts as run
        if (await one(c, "select 1 from runs where workflow_id=$1 and (reentry_key=$2 or reentry_key like $2 || ':gate:%')", [t.workflow_id, key])) continue;
        const ev = await emitEvent(c, { company_id: t.company_id, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "schedule", source: "engine",
          data: { node: t.node_id, workflow: t.name, period, local_date: local.toISODate(), local_time: local.toFormat("HH:mm"), fired_at: now.toISO(), ...(who.id ? { user_id: who.id } : {}) } });
        const id = await startRun(c, { companyId: t.company_id, workflowId: t.workflow_id, triggerId: t.id, triggerNodeId: t.node_id, event: ev, contactId: null, userId: who.id, schedule: `${t.node_id}:${period}` });
        if (id) out.started.push({ company: t.slug, workflow: t.name, node: t.node_id, period, ...(who.name ? { user: who.name } : {}) });
      }
    } catch (e) { out.errors.push({ company: t.slug, workflow: t.name, error: String((e as Error).message).slice(0, 200) }); }
  }
  return out;
}

/** The company's workflow that carries a step of this type (the health sweep is "the workflow with a health_check step"), by name, never by slug. */
export async function workflowWithStep(c: PoolClient, companyId: string, nodeType: string): Promise<{ id: string; name: string; enabled: boolean; schedule: Schedule | null; node: Record<string, unknown> | null } | null> {
  const rows = await many<{ id: string; name: string; enabled: boolean; definition: unknown }>(c, "select w.id, w.name, w.enabled, v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1 order by w.name", [companyId]);
  for (const r of rows) {
    let def; try { def = parseDefinition(r.definition); } catch { continue; }
    const node = def.nodes.find((n) => n.type === nodeType); if (!node) continue;
    const trig = def.nodes.find((n) => n.type === "trigger" && n.schedule);
    return { id: r.id, name: r.name, enabled: r.enabled, schedule: trig && trig.type === "trigger" ? trig.schedule ?? null : null, node: node as unknown as Record<string, unknown> };
  }
  return null;
}

/** Start a schedule trigger's run now, outside its period (the "sweep now" button, "send this week's wrap-up now"). The key carries the moment, so it never collides with the period's own run. */
export async function fireNow(c: PoolClient, companyId: string, workflowId: string, nodeId?: string, now = DateTime.now()): Promise<{ started: string[]; why?: string }> {
  const ver = await one<{ definition: unknown; name: string; timezone: string }>(c, "select v.definition, w.name, co.timezone from workflow_versions v join workflows w on w.id=v.workflow_id and w.current_version=v.version join companies co on co.id=w.company_id where w.id=$1 and w.company_id=$2", [workflowId, companyId]);
  if (!ver) return { started: [], why: "no such workflow" };
  const def = parseDefinition(ver.definition);
  const trig = def.nodes.find((n) => n.type === "trigger" && n.schedule && (!nodeId || n.id === nodeId));
  if (!trig || trig.type !== "trigger" || !trig.schedule) return { started: [], why: "no schedule trigger on this workflow" };
  const t = await one<{ id: string }>(c, "select id from workflow_triggers where workflow_id=$1 and node_id=$2", [workflowId, trig.id]);
  const local = now.setZone(ver.timezone), period = `manual:${now.toMillis()}`;
  const subjects: { id: string | null }[] = trig.schedule.for === "closer" ? await many<{ id: string }>(c, "select id from users where company_id=$1 and active and role='closer' order by name", [companyId]) : [{ id: null }];
  const started: string[] = [];
  for (const who of subjects) {
    const ev = await emitEvent(c, { company_id: companyId, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "schedule", source: "user",
      data: { node: trig.id, workflow: ver.name, period, local_date: local.toISODate(), local_time: local.toFormat("HH:mm"), fired_at: now.toISO(), manual: true, ...(who.id ? { user_id: who.id } : {}) } });
    const id = await startRun(c, { companyId, workflowId, triggerId: t?.id ?? null, triggerNodeId: trig.id, event: ev, contactId: null, userId: who.id, schedule: `${trig.id}:${period}` });
    if (id) started.push(id);
  }
  return { started };
}
