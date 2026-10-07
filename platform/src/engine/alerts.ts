import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { PollReport } from "./poll";
import type { TickReport } from "./runner";

/**
 * The engine tells the operator when it is unwell, without a human reading a dashboard: poll failures, failed runs,
 * workflow copies that no longer parse, a tick that found itself in recovery. Posted to OPERATOR_WEBHOOK_URL (any
 * JSON receiver: a Zap, a Slack incoming webhook, Make) and kept in engine_state so the dashboard shows the same list.
 * The same problem is announced once, then again every hour while it persists — never once a minute.
 */
export type Problem = { key: string; level: "error" | "warning"; text: string; company?: string };
const REPEAT_AFTER_MIN = 60;

export async function collectProblems(c: PoolClient, poll: PollReport, tick: TickReport): Promise<Problem[]> {
  const out: Problem[] = [];
  for (const e of poll.errors) out.push({ key: `poll:${e.company}:${e.entity}`, level: "error", company: e.company, text: `Poll failed for ${e.company} (${e.entity}): ${e.error.slice(0, 160)}` });
  const stuck = await many<{ slug: string; entity: string; consecutive_failures: number }>(c, "select co.slug, p.entity, p.consecutive_failures from poll_cursors p join companies co on co.id=p.company_id where p.consecutive_failures >= 5");
  for (const s of stuck) out.push({ key: `stuck:${s.slug}:${s.entity}`, level: "error", company: s.slug, text: `${s.slug} ${s.entity} has failed ${s.consecutive_failures} polls in a row` });
  const failed = await many<{ slug: string; workflow: string; n: number; sample: string | null }>(c, `select co.slug, w.name as workflow, count(*)::int as n, max(r.exit_reason) as sample from runs r join workflows w on w.id=r.workflow_id join companies co on co.id=r.company_id where r.status='failed' and r.finished_at > now() - interval '10 minutes' group by co.slug, w.name`);
  for (const f of failed) out.push({ key: `failed:${f.slug}:${f.workflow}`, level: "error", company: f.slug, text: `${f.n} run${f.n > 1 ? "s" : ""} of "${f.workflow}" failed for ${f.slug}: ${(f.sample ?? "").slice(0, 160)}` });
  const broken = await many<{ slug: string; n: number }>(c, "select co.slug, count(*)::int as n from audit_log a join companies co on co.id=a.company_id where a.action='workflow.unparseable' and a.at > now() - interval '10 minutes' group by co.slug");
  for (const b of broken) out.push({ key: `unparseable:${b.slug}`, level: "error", company: b.slug, text: `${b.slug}: a workflow copy no longer parses and is being skipped (${b.n} time${b.n > 1 ? "s" : ""} in 10 min). Re-run install.` });
  if (tick.recovery) out.push({ key: "recovery", level: "warning", text: `Engine came back after a gap: catching up (${tick.staleExits} stale runs exited this tick).` });
  return out;
}

/** Announce new problems and hourly repeats; remember what was said. Returns what was posted. */
export async function announce(c: PoolClient, problems: Problem[], now = new Date()): Promise<Problem[]> {
  const state = (await one<{ value: Record<string, string> }>(c, "select value from engine_state where key='alerts'"))?.value ?? {};
  const due = problems.filter((p) => { const last = state[p.key] ? new Date(state[p.key]) : null; return !last || now.getTime() - last.getTime() > REPEAT_AFTER_MIN * 60e3; });
  const next: Record<string, string> = {};
  for (const p of problems) next[p.key] = due.some((d) => d.key === p.key) ? now.toISOString() : state[p.key];
  await c.query("insert into engine_state (key, value, updated_at) values ('alerts', $1, now()) on conflict (key) do update set value=$1, updated_at=now()", [next]);
  await c.query("insert into engine_state (key, value, updated_at) values ('problems', $1, now()) on conflict (key) do update set value=$1, updated_at=now()", [JSON.stringify({ at: now.toISOString(), problems })]);
  if (due.length) await postToOperator(due);
  return due;
}

async function postToOperator(problems: Problem[]) {
  const url = process.env.OPERATOR_WEBHOOK_URL; if (!url) return;
  const text = problems.map((p) => `${p.level === "error" ? "🔴" : "🟡"} ${p.text}`).join("\n");
  try { await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, problems, at: new Date().toISOString(), source: "backend-in-a-box" }) }); }
  catch { /* the alert channel itself being down is reported by the external health check, not by us */ }
}

export const currentProblems = (c: PoolClient) => one<{ value: { at: string; problems: Problem[] } }>(c, "select value from engine_state where key='problems'");
