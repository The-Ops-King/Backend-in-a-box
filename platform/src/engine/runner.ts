import { DateTime } from "luxon";
import { asOperator, many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { parseDefinition, indexDefinition, type Definition } from "./definition";
import { buildContext, loadCompany, type RunRow } from "./context";
import { executeNode, type ExecDeps } from "./executor";
import { deferIntoWindow } from "./waitrule";
import { emitEvent } from "./dispatch";

const LEASE_MIN = 5, MAX_STEPS = 50, BATCH = 100;
export const RECOVERY_AFTER_MIN = 10;          // D5b: a gap longer than this means we were down
const RECOVERY_SEND_CAP = 20;                  // drip the backlog; never burst

export type TickReport = { claimed: number; completed: number; waiting: number; exited: number; failed: number; paused: number; recovery: boolean; staleExits: number; sends: number };

/** D5b premise check — reads GHL live, never the replica. */
async function premiseAlive(def: Definition, d: Omit<ExecDeps, "edgesFrom" | "ctx" | "now">): Promise<{ ok: true } | { ok: false; why: string }> {
  const chk = def.premise.check;
  if (chk === "none") return { ok: true };
  if (chk === "contact_exists") return (await one(d.c, "select 1 from contacts where id=$1 and merged_into is null", [d.run.contact_id])) ? { ok: true } : { ok: false, why: "contact gone" };
  if (chk === "opportunity_open") return (await one(d.c, "select 1 from opportunities where id=$1 and status='open'", [d.run.opportunity_id])) ? { ok: true } : { ok: false, why: "opportunity not open" };
  const a = await one<{ ghl_appointment_id: string }>(d.c, "select ghl_appointment_id from appointments where id=$1", [d.run.appointment_id]);
  if (!a) return { ok: false, why: "appointment missing" };
  const live = await d.adapters.read.getAppointment(d.adapterCompany, a.ghl_appointment_id);
  if (!live) return { ok: false, why: "appointment deleted in CRM" };
  if (live.status === "cancelled" || live.status === "invalid") return { ok: false, why: `appointment ${live.status}` };
  await d.c.query("update appointments set ghl_status=$2, starts_at=$3, ends_at=$4, ghl_updated_at=now() where id=$1", [d.run.appointment_id, live.status, live.startTime, live.endTime]);
  if (chk === "appointment_in_future" && DateTime.fromISO(live.startTime) <= DateTime.now()) return { ok: false, why: "appointment already happened" };
  return { ok: true };
}

export async function tick(adapters: Adapters, now = DateTime.now()): Promise<TickReport> {
  const report: TickReport = { claimed: 0, completed: 0, waiting: 0, exited: 0, failed: 0, paused: 0, recovery: false, staleExits: 0, sends: 0 };
  const claimedBy = `tick-${now.toMillis()}`;

  const runs = await asOperator(async (c) => {
    const st = await one<{ value: { last_tick?: string } }>(c, "select value from engine_state where key='scheduler'");
    const last = st?.value.last_tick ? DateTime.fromISO(st.value.last_tick) : undefined;
    report.recovery = !!last && now.diff(last, "minutes").minutes > RECOVERY_AFTER_MIN;
    await c.query("insert into engine_state (key, value, updated_at) values ('scheduler', $1, now()) on conflict (key) do update set value=$1, updated_at=now()", [{ last_tick: now.toISO(), recovery: report.recovery }]);
    return many<RunRow>(c, `update runs set claimed_at=now(), claimed_by=$1 where id in (
        select id from runs where status in ('active','waiting') and next_run_at <= $2
          and (claimed_at is null or claimed_at < $2::timestamptz - interval '${LEASE_MIN} minutes')
        order by next_run_at limit ${BATCH} for update skip locked) returning *`, [claimedBy, now.toJSDate()]);
  });
  report.claimed = runs.length;
  let sendsThisTick = 0;

  for (const run of runs) {
    try {
      await asOperator(async (c) => {
        const { row: company, adapterCompany, bindings } = await loadCompany(c, run.company_id);
        const ver = await one<{ definition: unknown }>(c, "select definition from workflow_versions where workflow_id=$1 and version=$2", [run.workflow_id, run.workflow_version]);
        const def = parseDefinition(ver!.definition);
        const { nodes, edgesFrom } = indexDefinition(def);
        const finish = async (status: string, exit_reason?: string, next_run_at?: Date | null, current_node?: string | null, ctx?: Record<string, unknown>) =>
          c.query("update runs set status=$2, exit_reason=coalesce($3, exit_reason), next_run_at=$4, current_node=coalesce($5,current_node), context=coalesce($6,context), claimed_at=null, claimed_by=null, finished_at=case when $2 in ('completed','exited','failed') then now() end where id=$1",
            [run.id, status, exit_reason ?? null, next_run_at ?? null, current_node ?? null, ctx ?? null]);

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
            const w = deferIntoWindow(now, tz, company.send_window_start, company.send_window_end);
            if (w.deferred) { await c.query("insert into run_steps (run_id,node_id,node_type,status,result,finished_at) values ($1,$2,$3,'waiting',$4,now())", [run.id, node.id, node.type, { quiet_hours_until: w.at.toISO() }]); await finish("waiting", undefined, w.at.toJSDate(), node.id, ctx); report.waiting++; return; }
            if (report.recovery && sendsThisTick >= RECOVERY_SEND_CAP) { await finish("waiting", undefined, now.plus({ minutes: 1 }).toJSDate(), node.id, ctx); report.waiting++; return; }
          }

          const step = await one<{ id: string }>(c, "insert into run_steps (run_id,node_id,node_type,status) values ($1,$2,$3,'waiting') returning id", [run.id, node.id, node.type]);
          const out = await executeNode(deps, node);
          await c.query("update run_steps set status=$2, result=$3, error=$4, finished_at=now() where id=$1",
            [step!.id, out.status === "exit" || out.status === "paused" ? "ok" : out.status === "waiting" ? "waiting" : out.status, "result" in out ? out.result ?? {} : {}, "error" in out ? out.error : null]);
          if (out.status === "ok" && (node.type === "send_sms" || node.type === "send_email")) { sendsThisTick++; report.sends++; }

          if (out.status === "waiting") { await finish("waiting", undefined, out.until.toJSDate(), out.stay ? node.id : (edgesFrom(node.id).find((e) => e.label !== "timeout") ?? edgesFrom(node.id)[0])?.to ?? null, ctx); report.waiting++; return; }
          if (out.status === "exit") { await finish("completed", out.reason, null, node.id, ctx); report.completed++; return; }
          if (out.status === "paused") { await finish("paused", out.reason, null, node.id, ctx); report.paused++; return; }
          if (out.status === "failed") { await finish("failed", out.error, null, node.id, ctx); report.failed++; return; }
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
