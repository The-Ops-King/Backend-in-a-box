import { DateTime } from "luxon";
import { asOperator, many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { bookingFor } from "@/adapters/types";
import { parseDefinition, indexDefinition, type Definition } from "./definition";
import { buildContext, loadCompany, type RunRow } from "./context";
import { executeNode, type ExecDeps } from "./executor";
import { deferIntoWindow } from "./waitrule";
import { emitEvent, startRun, type EventRow } from "./dispatch";

const LEASE_MIN = 5, MAX_STEPS = 50, BATCH = 100;
export const RECOVERY_AFTER_MIN = 10;          // D5b: a gap longer than this means we were down
const RECOVERY_SEND_CAP = 20;                  // per company per tick while catching up: never burst one client's inbox, never let one client's backlog starve another's

type PendingTrigger = { event_id: number; trigger_id: string | null; trigger_node_id: string; contact_id: string; appointment_id: string | null; opportunity_id: string | null };
export type TickReport = { claimed: number; completed: number; waiting: number; exited: number; failed: number; paused: number; recovery: boolean; staleExits: number; sends: number; replayed?: number };

/** D5b premise check — reads the booking source live, never the replica. */
async function premiseAlive(def: Definition, d: Omit<ExecDeps, "edgesFrom" | "ctx" | "now">): Promise<{ ok: true } | { ok: false; why: string }> {
  const chk = def.premise.check;
  if (chk === "none") return { ok: true };
  if (chk === "contact_exists") return (await one(d.c, "select 1 from contacts where id=$1 and merged_into is null", [d.run.contact_id])) ? { ok: true } : { ok: false, why: "contact gone" };
  if (chk === "opportunity_open") return (await one(d.c, "select 1 from opportunities where id=$1 and status='open'", [d.run.opportunity_id])) ? { ok: true } : { ok: false, why: "opportunity not open" };
  const a = await one<{ external_id: string; source: string; status: string; starts_at: Date }>(d.c, "select external_id, source, status, starts_at from appointments where id=$1", [d.run.appointment_id]);
  if (!a) return { ok: false, why: "appointment missing" };
  // a simulated appointment (D23) exists only in our table: our row is the truth
  if (a.source === "test") return chk === "appointment_exists" ? { ok: true } : a.status === "cancelled" ? { ok: false, why: "appointment cancelled" } : a.starts_at <= new Date() ? { ok: false, why: "appointment already happened" } : { ok: true };
  if (a.source !== d.adapterCompany.booking.source) return { ok: false, why: `appointment belongs to booking source ${a.source}; company now uses ${d.adapterCompany.booking.source}` };
  const live = await bookingFor(d.adapters, d.adapterCompany).getAppointment(d.adapterCompany, a.external_id);
  if (!live) return { ok: false, why: "appointment deleted at the booking source" };
  await d.c.query("update appointments set status=$2, starts_at=$3, ends_at=$4, source_updated_at=now() where id=$1", [d.run.appointment_id, live.status, live.startTime, live.endTime]);
  if (live.status === "invalid") return { ok: false, why: "appointment invalid" };
  // appointment_exists: the appointment merely has to be real — cancellation rebook and no-show recovery run precisely BECAUSE it was cancelled or missed
  if (chk === "appointment_exists") return { ok: true };
  // appointment_in_future: a reminder for a cancelled or past call is moot
  if (live.status === "cancelled") return { ok: false, why: "appointment cancelled" };
  if (DateTime.fromISO(live.startTime) <= DateTime.now()) return { ok: false, why: "appointment already happened" };
  return { ok: true };
}

/** `onlyCompanyId` limits the claim to one company (tests share a database; an operator may want one company run now). */
export async function tick(adapters: Adapters, now = DateTime.now(), onlyCompanyId?: string): Promise<TickReport> {
  const report: TickReport = { claimed: 0, completed: 0, waiting: 0, exited: 0, failed: 0, paused: 0, recovery: false, staleExits: 0, sends: 0 };
  const claimedBy = `tick-${now.toMillis()}`;

  const runs = await asOperator(async (c) => {
    const st = await one<{ value: { last_tick?: string } }>(c, "select value from engine_state where key='scheduler'");
    const last = st?.value.last_tick ? DateTime.fromISO(st.value.last_tick) : undefined;
    report.recovery = !!last && now.diff(last, "minutes").minutes > RECOVERY_AFTER_MIN;
    await c.query("insert into engine_state (key, value, updated_at) values ('scheduler', $1, now()) on conflict (key) do update set value=$1, updated_at=now()", [{ last_tick: now.toISO(), recovery: report.recovery }]);
    // Due-ness is decided by the database clock, the same clock that wrote next_run_at. Comparing against a JS
    // timestamp (ms) lost a race against Postgres now() (µs) when a wake and a tick landed in the same millisecond.
    return many<RunRow>(c, `update runs set claimed_at=now(), claimed_by=$1 where id in (
        select id from runs where status in ('active','waiting') and next_run_at <= now()
          and (claimed_at is null or claimed_at < now() - interval '${LEASE_MIN} minutes') and ($2::uuid is null or company_id=$2)
        order by next_run_at limit ${BATCH} for update skip locked) returning *`, [claimedBy, onlyCompanyId ?? null]);
  });
  report.claimed = runs.length;
  const sendsThisTick = new Map<string, number>();   // company → sends this tick (recovery cap is per company)

  for (const run of runs) {
    try {
      await asOperator(async (c) => {
        const { row: company, adapterCompany, bindings } = await loadCompany(c, run.company_id);
        const ver = await one<{ definition: unknown }>(c, "select definition from workflow_versions where workflow_id=$1 and version=$2", [run.workflow_id, run.workflow_version]);
        const def = parseDefinition(ver!.definition);
        const { nodes, edgesFrom } = indexDefinition(def);
        const finish = async (status: string, exit_reason?: string, next_run_at?: Date | null, current_node?: string | null, ctx?: Record<string, unknown>, wakeOnReply = false) =>
          c.query("update runs set status=$2, exit_reason=coalesce($3, exit_reason), next_run_at=$4, current_node=coalesce($5,current_node), context=coalesce($6,context), wake_on_reply=$7, claimed_at=null, claimed_by=null, finished_at=case when $2 in ('completed','exited','failed') then now() end where id=$1",
            [run.id, status, exit_reason ?? null, next_run_at ?? null, current_node ?? null, ctx ?? null, wakeOnReply]);

        // 1. premise — the always-on moot check
        const alive = await premiseAlive(def, { c, adapters, company, adapterCompany, bindings, run });
        if (!alive.ok) {
          await finish("exited", report.recovery ? `stale_after_outage: ${alive.why}` : `moot: ${alive.why}`);
          await emitEvent(c, { company_id: run.company_id, contact_id: run.contact_id, opportunity_id: run.opportunity_id, appointment_id: run.appointment_id, run_id: run.id, event_type: "run.exited", source: "engine", data: { reason: alive.why, recovery: report.recovery } });
          report.exited++; if (report.recovery) report.staleExits++; return;
        }

        const ctx = await buildContext(c, run, company, bindings);
        const deps: ExecDeps = { c, adapters, company, adapterCompany, bindings, run, ctx, edgesFrom, now };
        let nodeId: string | null = run.current_node ?? def.nodes.find((n) => n.type === "trigger")!.id;

        for (let i = 0; i < MAX_STEPS && nodeId; i++) {
          const node = nodes.get(nodeId); if (!node) { await finish("failed", `unknown node ${nodeId}`); report.failed++; return; }

          // 2. send window — any send outside the company's hours waits for the next opening (D5d), then premise re-runs
          if (node.type === "send_sms" || node.type === "send_email") {
            const tz = (ctx.contact as { timezone?: string })?.timezone ?? company.timezone;
            // dark hours: a human-sounding message always waits for the window; a transactional one ("you're booked") goes out at once only if the company allows it
            const w = node.kind === "transactional" && company.quiet_allow_transactional ? { deferred: false as const, at: now } : deferIntoWindow(now, tz, company.send_window_start, company.send_window_end);
            if (w.deferred) { await c.query("insert into run_steps (run_id,node_id,node_type,status,result,finished_at) values ($1,$2,$3,'waiting',$4,now())", [run.id, node.id, node.type, { quiet_hours_until: w.at.toISO() }]); await finish("waiting", undefined, w.at.toJSDate(), node.id, ctx); report.waiting++; return; }
            if (report.recovery && (sendsThisTick.get(run.company_id) ?? 0) >= RECOVERY_SEND_CAP) { await finish("waiting", undefined, now.plus({ minutes: 1 }).toJSDate(), node.id, ctx); report.waiting++; return; }
          }

          const step = await one<{ id: string }>(c, "insert into run_steps (run_id,node_id,node_type,status) values ($1,$2,$3,'waiting') returning id", [run.id, node.id, node.type]);
          // a node that throws (vendor error, bad template) must fail the run WITHOUT rolling back this tick's ledger rows:
          // sends that already went out stay recorded, which is what makes a retry safe
          let out: Awaited<ReturnType<typeof executeNode>>;
          try { out = await executeNode(deps, node); } catch (e) { out = { status: "failed", error: String((e as Error).message).slice(0, 500) }; }
          await c.query("update run_steps set status=$2, result=$3, error=$4, finished_at=now() where id=$1",
            [step!.id, out.status === "exit" || out.status === "paused" ? "ok" : out.status === "waiting" ? "waiting" : out.status, "result" in out ? out.result ?? {} : {}, "error" in out ? out.error : null]);
          if (out.status === "ok" && (node.type === "send_sms" || node.type === "send_email")) { sendsThisTick.set(run.company_id, (sendsThisTick.get(run.company_id) ?? 0) + 1); report.sends++; }

          if (out.status === "waiting") { await finish("waiting", undefined, out.until.toJSDate(), out.stay ? node.id : (edgesFrom(node.id).find((e) => e.label !== "timeout") ?? edgesFrom(node.id)[0])?.to ?? null, ctx, !!out.wakeOnReply); report.waiting++; return; }
          if (out.status === "exit") {
            // a run that stopped at a gate did nothing: release its once-per key so the next trigger (payment first, signature later) gets its turn (D30)
            if (out.gate) {
              await c.query("update runs set reentry_key = reentry_key || ':gate:' || id::text where id=$1", [run.id]);
              await finish("completed", out.reason, null, node.id, ctx); report.completed++;
              // triggers that arrived while this run held the key get their turn now, newest last; the first that starts wins the key
              const pending = (await one<{ pending_events: PendingTrigger[] }>(c, "select pending_events from runs where id=$1", [run.id]))?.pending_events ?? [];
              for (const p of pending) {
                const ev = await one<EventRow>(c, "select * from events where id=$1", [p.event_id]); if (!ev) continue;
                const started = await startRun(c, { companyId: run.company_id, workflowId: run.workflow_id, triggerId: p.trigger_id, triggerNodeId: p.trigger_node_id, event: ev, contactId: p.contact_id, appointmentId: p.appointment_id, opportunityId: p.opportunity_id });
                if (started) report.replayed = (report.replayed ?? 0) + 1;
              }
              return;
            }
            await finish("completed", out.reason, null, node.id, ctx); report.completed++; return;
          }
          if (out.status === "paused") { await finish("paused", out.reason, null, node.id, ctx); report.paused++; return; }
          if (out.status === "failed") { await finish("failed", out.error, null, node.id, ctx); report.failed++; return; }
          if (out.next === null) { await finish("failed", `node ${node.id} (${node.type}) has no outgoing edge`, null, node.id, ctx); report.failed++; return; }
          nodeId = out.next;
        }
        await finish("failed", `exceeded ${MAX_STEPS} steps in one tick`); report.failed++;
      });
    } catch (e) {
      report.failed++;
      await asOperator((c) => c.query("update runs set status='failed', exit_reason=$2, claimed_at=null where id=$1", [run.id, String((e as Error).message).slice(0, 500)])).catch(() => {});
    }
  }
  return report;
}
