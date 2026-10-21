import type { z } from "zod";
import { personView } from "@/projections/derived";
import { todayIn } from "@/reports/periods";
import { clockMinutes, toMs } from "@/workflow/duration";
import type { Schedule } from "@/workflow/primitives/trigger";
import { type Deps, definitionOf, fireSchedule } from "./interpreter";
import type { Tx } from "./store";
import { addDays, localToInstant, partsIn } from "./time";
import type { ScheduleTimer } from "./types";

/**
 * Schedule triggers, fired by the job runner (ADR 0003: no tick; every timer is a job with an exact time). Each enabled
 * workflow's schedule trigger has a timer row with its next time; when it comes, the trigger fires for the period it is
 * in, once per period per subject (the offer, or each person with the trigger's role, by the reentry key), and the next
 * time is set. As v1's clock.ts: a job that runs late still fires its period, once; a period the worker was down for
 * entirely is not made up (the next time is worked out from when the job ran).
 */

type Sched = z.infer<typeof Schedule>;

/** The period a schedule is in at `at` when it is due, else null (v1's periodOf): every N buckets the clock; at HH:MM is the local date once that time has passed, on its days. */
export function periodOf(s: Sched, at: Date, zone: string): string | null {
  if (s.every) return `every:${Math.floor(at.getTime() / toMs(s.every))}`;
  const p = partsIn(at, zone);
  if (p.h * 60 + p.mi < clockMinutes(s.at!)) return null;
  if (s.days?.length && !s.days.includes(p.weekday)) return null;
  if (s.dayOfMonth && p.d !== s.dayOfMonth) return null;
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** The first moment after `after` at which the schedule enters a period it was not in. */
export function nextFire(s: Sched, after: Date, zone: string): Date {
  if (s.every) { const ms = toMs(s.every); return new Date((Math.floor(after.getTime() / ms) + 1) * ms); }
  const mins = clockMinutes(s.at!), today = partsIn(after, zone);
  for (let i = 0; i < 400; i++) {
    const d = addDays(today, i);
    if (s.days?.length && !s.days.includes(d.weekday)) continue;
    if (s.dayOfMonth && d.d !== s.dayOfMonth) continue;
    const t = localToInstant(d.y, d.m, d.d, Math.floor(mins / 60), mins % 60, zone);
    if (t.getTime() > after.getTime()) return t;
  }
  throw new Error("the schedule never comes round");
}

/** The schedule triggers of a workflow's current version. */
async function triggersOf(tx: Tx, workflowId: string): Promise<{ node: string; schedule: Sched }[]> {
  const wf = await tx.workflow(workflowId);
  if (!wf?.currentVersionId) return [];
  const { def } = definitionOf((await tx.version(wf.currentVersionId))!);
  return def.nodes.flatMap((n) => (n.type === "trigger@1" && "schedule" in n.on ? [{ node: n.id, schedule: n.on.schedule }] : []));
}

/** Sets a workflow's schedule timers from its current version (when it is enabled or changes): next times from `now`; none while it is off. */
export async function armSchedules(tx: Tx, workflowId: string, now: Date): Promise<ScheduleTimer[]> {
  const wf = (await tx.workflow(workflowId))!;
  const offer = (await tx.offer(wf.offerId))!;
  const want = wf.enabled ? await triggersOf(tx, workflowId) : [];
  const have = await tx.scheduleTimers({ workflowId });
  for (const t of have) if (!want.some((w) => w.node === t.node)) await tx.deleteScheduleTimer(workflowId, t.node);
  const out: ScheduleTimer[] = [];
  for (const w of want) {
    const prior = have.find((t) => t.node === w.node);
    const row: ScheduleTimer = { workflowId, node: w.node, offerId: wf.offerId, nextAt: nextFire(w.schedule, now, offer.zone), lastPeriod: prior?.lastPeriod ?? null };
    await tx.setScheduleTimer(row);
    await tx.schedule({ kind: "schedule", workflowId, node: w.node, at: row.nextAt });
    out.push(row);
  }
  return out;
}

/**
 * A schedule trigger's period came: one run for the offer, or one for each active person with the trigger's role (from
 * the people projection, as the run's `person`), each at most once for the period.
 */
export async function firePeriod(deps: Deps, x: { workflowId: string; node: string; at: Date; period?: string }): Promise<string[]> {
  const wf = await deps.tx.workflow(x.workflowId);
  if (!wf?.enabled || !wf.currentVersionId) return [];
  const t = (await triggersOf(deps.tx, x.workflowId)).find((w) => w.node === x.node);
  if (!t) throw new Error(`${x.node} is not a schedule trigger`);
  const offer = (await deps.tx.offer(wf.offerId))!;
  const started: string[] = [];
  if (t.schedule.for === "offer") {
    const id = await fireSchedule(deps, { workflowId: x.workflowId, triggerNode: x.node, at: x.at, ...(x.period ? { period: x.period } : {}) });
    if (id) started.push(id);
    return started;
  }
  const role = t.schedule.for.role;
  const people = (await deps.tx.projFind("people", wf.offerId, { has: { roles: role } })).filter((p) => p.active);
  for (const p of people) {
    const day = todayIn(x.at, offer.zone);
    const person = { ...personView(p), id: p.id, eod: { day, filed: p.eodDays.includes(day) } };
    const id = await fireSchedule(deps, { workflowId: x.workflowId, triggerNode: x.node, at: x.at, person, ...(x.period ? { period: x.period } : {}) });
    if (id) started.push(id);
  }
  return started;
}

/** A timer came due (its job ran, perhaps late): fire its period once, then set its next time from now. */
export async function fireTimer(deps: Deps, workflowId: string, node: string): Promise<{ fired: boolean; started: string[] }> {
  const [timer] = (await deps.tx.scheduleTimers({ workflowId })).filter((t) => t.node === node);
  if (!timer || timer.nextAt.getTime() > deps.now.getTime()) return { fired: false, started: [] };
  const wf = await deps.tx.workflow(workflowId);
  const t = wf?.enabled ? (await triggersOf(deps.tx, workflowId)).find((w) => w.node === node) : undefined;
  if (!wf || !t) { await deps.tx.deleteScheduleTimer(workflowId, node); return { fired: false, started: [] }; }
  const offer = (await deps.tx.offer(wf.offerId))!;
  const period = periodOf(t.schedule, deps.now, offer.zone);
  const started = period && period !== timer.lastPeriod ? await firePeriod(deps, { workflowId, node, at: deps.now, period }) : [];
  const next: ScheduleTimer = { ...timer, nextAt: nextFire(t.schedule, deps.now, offer.zone), lastPeriod: period ?? timer.lastPeriod };
  await deps.tx.setScheduleTimer(next);
  await deps.tx.schedule({ kind: "schedule", workflowId, node, at: next.nextAt });
  return { fired: !!period && period !== timer.lastPeriod, started };
}
