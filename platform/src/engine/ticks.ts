import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { asOperator, many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { emptyPollReport, pollCompany, type PollReport } from "./poll";
import { RECOVERY_AFTER_MIN, tick, type TickReport } from "./runner";
import { dispatchSchedules, type ClockReport } from "./clock";
import { announceDue, collectThisTick, ENGINE_SCOPE, raise, resolve } from "./alerts";
import { purgeOld } from "./retention";
import { companyLock, ENGINE_LOCK, LEGACY_LOCK, tickLockHeld, withTickLock } from "./lock";
import { liveProbes, syncFromGhl, SYNC_EVERY_MIN, type HealthProbes } from "./health";
import { loadCompany } from "./context";
import { runningSql } from "./running";

/**
 * D98. Each company ticks on its own: its own lease, its own poll, schedules, runs and alerts, its own clock
 * (`engine_state` `scheduler:<id>`). One client's slow vendor or big first import takes that client's minute, never anyone
 * else's. The engine's own minute (retention, its own alerts, the heartbeat the watchdog and /api/health read, and whether
 * any company has stopped ticking) is a tick of its own. The database scheduler fires all of them at once every minute.
 */
export const STALE_AFTER_MIN = 5;
export const STALE_KEY = "engine:company_stale";
export const companyClock = (companyId: string) => `scheduler:${companyId}`;
const TICKING = runningSql("co");
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);
const emptyTick = (): TickReport => ({ claimed: 0, completed: 0, waiting: 0, exited: 0, failed: 0, paused: 0, recovery: false, staleExits: 0, sends: 0 });

/** `scheduler:<id>`: the company's last own tick, with where its time went (ms): each poll read (`poll_ms`, by entity; `setup` is the bindings and calendars), the schedules, the runs, the alerts. */
export type CompanyClock = { last_tick?: string; since?: string; started_at?: string; ms?: number; poll_ms?: Record<string, number>; schedules_ms?: number; runs_ms?: number; alerts_ms?: number; claimed?: number; completed?: number; failed?: number; errors?: string[]; recovery?: boolean };
export type CompanyTick =
  | { company: string; slug?: string; busy: true; ms: number; why?: string }
  | { company: string; slug?: string; busy: false; skipped: string; ms: number }
  | { company: string; slug: string; busy: false; ms: number; timings: Pick<CompanyClock, "poll_ms" | "schedules_ms" | "runs_ms" | "alerts_ms">; poll: PollReport; clock: ClockReport; runs: TickReport; alerts: Record<string, unknown>; errors: string[] };

/** One company's minute under its own lease. `{ busy: true }` when its lease is held (its previous tick is still running), or while a pre-D98 deployment's single tick is finishing during a rollout. */
export async function tickCompany(adapters: Adapters, companyId: string, opts: { probes?: HealthProbes; leaseSeconds?: number } = {}): Promise<CompanyTick> {
  const t0 = Date.now(), startedAt = new Date().toISOString();
  const co = await asOperator((c) => one<{ id: string; slug: string; ticking: boolean }>(c, `select co.id, co.slug, ${TICKING} as ticking from companies co where co.id=$1`, [companyId]));
  if (!co) return { company: companyId, busy: false, skipped: "no such company", ms: Date.now() - t0 };
  if (!co.ticking) return { company: companyId, slug: co.slug, busy: false, skipped: "company is not active", ms: Date.now() - t0 };
  const key = companyClock(companyId);
  const out = await withTickLock(async (): Promise<CompanyTick> => {
    if (await tickLockHeld(LEGACY_LOCK)) return { company: companyId, slug: co.slug, busy: true, ms: Date.now() - t0, why: "the engine-wide tick of an older deployment is still running" };
    // a first tick that never finishes (killed at 300 s mid-import) still has a row, so the engine's staleness check sees it
    await asOperator((c) => c.query("insert into engine_state (key, value, updated_at) values ($1, $2, now()) on conflict (key) do nothing", [key, { since: startedAt }]));
    const poll_ms: Record<string, number> = {};
    const poll = await pollCompany(adapters, companyId, emptyPollReport(), poll_ms).catch((e) => { const r = emptyPollReport(); r.errors.push({ company: co.slug, entity: "*", error: msg(e) }); return r; });
    let t = Date.now();
    const clock: ClockReport = await asOperator((c) => dispatchSchedules(c, DateTime.now(), companyId)).catch((e) => ({ started: [], errors: [{ company: co.slug, workflow: "*", error: msg(e) }] }));
    const schedules_ms = Date.now() - t;
    const errors = [...poll.errors.map((e) => `poll ${e.entity}: ${e.error.slice(0, 160)}`), ...clock.errors.map((e) => `schedule ${e.workflow}: ${e.error.slice(0, 160)}`)];
    // D297: GHL compared and the engine brought into line every 10 minutes, quietly; a failure never fails the tick
    t = Date.now();
    await asOperator(async (c) => {
      const due = await one<{ ok: boolean }>(c, `insert into engine_state (key, value, updated_at) values ($1, '{}'::jsonb, now()) on conflict (key) do update set updated_at=now()
        where engine_state.updated_at <= now() - make_interval(mins => $2) returning true as ok`, [`ghl_sync:${companyId}`, SYNC_EVERY_MIN]);
      if (due) await syncFromGhl(c, (await loadCompany(c, companyId)).row, adapters, opts.probes ?? liveProbes);
    }).catch((e) => errors.push(`ghl sync: ${msg(e)}`));
    let runs: TickReport;
    t = Date.now();
    try { runs = await tick(adapters, DateTime.now(), companyId, opts.probes, key); } catch (e) { runs = emptyTick(); errors.push(`runs: ${msg(e)}`); }
    const runs_ms = Date.now() - t;
    const now = new Date(); t = Date.now();
    // the engine reports its own problems (D33); a failure here never fails the tick
    const alerts = await asOperator(async (c) => {
      const col = await collectThisTick(c, poll, runs, now, companyId);
      const ann = await announceDue(c, adapters, now, companyId);
      return { raised: col.raised, resolved: col.resolved, posted: ann.posted, repeated: ann.repeated, closed: ann.resolved };
    }).catch((e) => { errors.push(`alerts: ${msg(e)}`); return { error: msg(e) }; });
    const alerts_ms = Date.now() - t;
    const ms = Date.now() - t0;
    const state: CompanyClock = { last_tick: new Date().toISOString(), started_at: startedAt, ms, poll_ms, schedules_ms, runs_ms, alerts_ms, claimed: runs.claimed, completed: runs.completed, failed: runs.failed, errors: errors.slice(0, 5), recovery: runs.recovery };
    await asOperator((c) => c.query("insert into engine_state (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value=$2, updated_at=now()", [key, state]));
    return { company: companyId, slug: co.slug, busy: false, ms, timings: { poll_ms, schedules_ms, runs_ms, alerts_ms }, poll, clock, runs, alerts, errors };
  }, companyLock(companyId), opts.leaseSeconds);
  return out.busy ? { company: companyId, slug: co.slug, busy: true, ms: Date.now() - t0 } : out.result;
}

export type CompanyTickState = { id: string; slug: string; name: string; last_tick: string | null; ms: number | null; minutes: number; stale: boolean; errors: string[]; timings: Pick<CompanyClock, "poll_ms" | "schedules_ms" | "runs_ms" | "alerts_ms"> };
/** Every ticking company's last own tick: how long ago, how long it took, what failed in it. A company that never finished one counts from its first try, else from its creation. */
export async function companyTicks(c: PoolClient, now = new Date(), staleAfterMin = STALE_AFTER_MIN): Promise<CompanyTickState[]> {
  const rows = await many<{ id: string; slug: string; name: string; state: CompanyClock | null; ref: Date }>(c, `select co.id, co.slug, co.name, s.value as state,
      coalesce((s.value->>'last_tick')::timestamptz, (s.value->>'since')::timestamptz, co.created_at) as ref
    from companies co left join engine_state s on s.key = 'scheduler:' || co.id::text where ${TICKING} order by co.slug`);
  return rows.map((r) => {
    const minutes = Math.max(0, (now.getTime() - new Date(r.ref).getTime()) / 60e3);
    return { id: r.id, slug: r.slug, name: r.name, last_tick: r.state?.last_tick ?? null, ms: r.state?.ms ?? null, minutes: Math.round(minutes * 10) / 10, stale: minutes > staleAfterMin, errors: r.state?.errors ?? [],
      timings: { poll_ms: r.state?.poll_ms, schedules_ms: r.state?.schedules_ms, runs_ms: r.state?.runs_ms, alerts_ms: r.state?.alerts_ms } };
  });
}

/**
 * The engine's own alerts (D98): the recovery notice after the engine itself was down (company null), and a company whose
 * ticks have stopped (`engine:company_stale` on that company, open while its last tick is more than five minutes old,
 * resolved once it ticks again). Both go to the operator's webhook (`announceDue` with `ENGINE_SCOPE`).
 */
export async function collectEngine(c: PoolClient, recovery: { gapMin: number } | null, now = new Date(), staleAfterMin = STALE_AFTER_MIN): Promise<{ raised: number; resolved: number; stale: { slug: string; minutes: number }[] }> {
  let raised = 0, resolved = 0;
  if (recovery) { if ((await raise(c, { companyId: null, key: "engine:recovery", level: "warning", source: "engine", text: `Engine came back after a gap of ${Math.round(recovery.gapMin)} minutes and is catching up.` }, now)).isNew) raised++; }
  else if (await resolve(c, null, "engine:recovery", now, true)) resolved++;
  const ticks = await companyTicks(c, now, staleAfterMin);
  for (const t of ticks) {
    if (t.stale) {
      const text = `Has not ticked for ${Math.round(t.minutes)} minutes (${t.last_tick ? `last tick ${t.last_tick}` : "no tick yet"}): its polls, schedules and runs are not moving.${t.errors.length ? ` Last errors: ${t.errors.join("; ").slice(0, 300)}` : ""}`;
      if ((await raise(c, { companyId: t.id, key: STALE_KEY, level: "error", source: "engine", text, detail: { last_tick: t.last_tick, minutes: Math.round(t.minutes) }, href: `/app/c/${t.slug}` }, now)).isNew) raised++;
    } else if (await resolve(c, t.id, STALE_KEY, now)) resolved++;
  }
  // a company no longer ticking (archived, onboarding) is not stale: its alert closes without a word
  const gone = await many<{ company_id: string }>(c, `select a.company_id from alerts a join companies co on co.id=a.company_id where a.key=$1 and a.resolved_at is null and not ${TICKING}`, [STALE_KEY]);
  for (const g of gone) if (await resolve(c, g.company_id, STALE_KEY, now, true)) resolved++;
  return { raised, resolved, stale: ticks.filter((t) => t.stale).map((t) => ({ slug: t.slug, minutes: Math.round(t.minutes) })) };
}

export type EngineTick = { busy: true; ms: number } | { busy: false; ms: number; recovery: boolean; alerts: Record<string, unknown>; purged: Record<string, unknown> };
/** The engine's minute under its own lease: the heartbeat (`scheduler`, what /api/health and the in-database watchdog read), its own alerts, retention. */
export async function tickEngine(adapters: Adapters, opts: { leaseSeconds?: number } = {}): Promise<EngineTick> {
  const t0 = Date.now();
  const out = await withTickLock(async () => {
    const now = new Date();
    const gapMin = await asOperator(async (c) => {
      const st = await one<{ value: { last_tick?: string } }>(c, "select value from engine_state where key='scheduler'");
      const gap = st?.value.last_tick ? (now.getTime() - new Date(st.value.last_tick).getTime()) / 60e3 : 0;
      await c.query("insert into engine_state (key, value, updated_at) values ('scheduler', $1, now()) on conflict (key) do update set value=engine_state.value || $1, updated_at=now()", [{ last_tick: now.toISOString(), recovery: gap > RECOVERY_AFTER_MIN }]);
      return gap;
    });
    const recovery = gapMin > RECOVERY_AFTER_MIN;
    const alerts = await asOperator(async (c) => {
      const col = await collectEngine(c, recovery ? { gapMin } : null, now);
      const ann = await announceDue(c, adapters, now, ENGINE_SCOPE);
      return { raised: col.raised, resolved: col.resolved, stale: col.stale, posted: ann.posted, repeated: ann.repeated, closed: ann.resolved };
    }).catch((e) => ({ error: msg(e) }));
    // D38: what is past its retention goes; a failure here never fails the tick
    const purged = await asOperator((c) => purgeOld(c)).catch((e) => ({ error: msg(e) }));
    return { recovery, alerts, purged };
  }, ENGINE_LOCK, opts.leaseSeconds);
  return out.busy ? { busy: true, ms: Date.now() - t0 } : { busy: false, ms: Date.now() - t0, ...out.result };
}

/** Every ticking company in turn, each through its own `tickCompany` (a busy one is skipped and reported), then the engine's minute. What a call with no parameters does: the daily sweep, a hand call, and the database scheduler installed before D98. */
export async function tickEveryone(adapters: Adapters, opts: { probes?: HealthProbes; leaseSeconds?: number } = {}): Promise<{ companies: CompanyTick[]; busy: string[]; engine: EngineTick }> {
  const ids = await asOperator((c) => many<{ id: string }>(c, `select co.id from companies co where ${TICKING} order by co.slug`));
  const companies: CompanyTick[] = [];
  for (const { id } of ids) companies.push(await tickCompany(adapters, id, opts).catch((e): CompanyTick => ({ company: id, busy: false, skipped: `failed: ${msg(e)}`, ms: 0 })));
  const engine = await tickEngine(adapters, opts);
  return { companies, busy: companies.filter((x) => x.busy).map((x) => x.slug ?? x.company), engine };
}
