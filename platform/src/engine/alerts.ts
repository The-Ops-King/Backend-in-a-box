import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import type { PollReport } from "./poll";
import type { TickReport } from "./runner";
import { decrypt } from "./crypto";
import { resendSend } from "@/adapters/email/resend";

/**
 * D33. The engine tells the operator the minute something fails, and says so once.
 * One open alert per (company, key). First seen → posted to the company's alert destinations (Slack channel, email,
 * webhook) and remembered with its Slack ts. Still open an hour later → a reply in that thread, never a new post.
 * Gone → "Resolved" in the thread and a ✅ reaction on the first post. Nothing is said while everything works.
 *
 * Sources: `step` (a run failed at a step), `poll` (the CRM poll keeps failing), `health` (the hourly sweep), `engine`.
 * Live sources (poll, health, engine) are reconciled: what is present stays open, what is absent resolves.
 */
export type Level = "error" | "warning";
export type Source = "step" | "poll" | "health" | "engine";
export type AlertInput = { companyId: string | null; key: string; level: Level; source: Source; text: string; detail?: Record<string, unknown>; href?: string | null };
export type AlertRow = { id: string; company_id: string | null; key: string; level: Level; source: Source; text: string; detail: Record<string, unknown>; href: string | null; first_seen: Date; last_seen: Date; announced_at: Date | null; announce_count: number; slack_channel: string | null; slack_ts: string | null; resolved_at: Date | null; resolved_announced: boolean };

export const REPEAT_AFTER_MIN = 60;
const NIL = "00000000-0000-0000-0000-000000000000";

/** Open the alert, or touch it if it is already open. */
export async function raise(c: PoolClient, a: AlertInput, now = new Date()): Promise<{ id: string; isNew: boolean }> {
  const open = await one<{ id: string }>(c, "select id from alerts where coalesce(company_id,$1::uuid)=coalesce($2::uuid,$1::uuid) and key=$3 and resolved_at is null", [NIL, a.companyId, a.key]);
  if (open) { await c.query("update alerts set last_seen=$2, text=$3, level=$4, detail=$5, href=$6 where id=$1", [open.id, now, a.text, a.level, a.detail ?? {}, a.href ?? null]); return { id: open.id, isNew: false }; }
  const r = await one<{ id: string }>(c, "insert into alerts (company_id, key, level, source, text, detail, href, first_seen, last_seen) values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning id", [a.companyId, a.key, a.level, a.source, a.text, a.detail ?? {}, a.href ?? null, now]);
  return { id: r!.id, isNew: true };
}

/** Close the open alert. `quietly` skips the "resolved" announcement (a one-shot notice that was never a lasting state). An alert nobody heard about resolves silently too. */
export async function resolve(c: PoolClient, companyId: string | null, key: string, now = new Date(), quietly = false): Promise<boolean> {
  const r = await c.query("update alerts set resolved_at=$3, resolved_announced=(resolved_announced or $4 or announced_at is null) where coalesce(company_id,$1::uuid)=coalesce($2::uuid,$1::uuid) and key=$5 and resolved_at is null", [NIL, companyId, now, quietly, key]);
  return (r.rowCount ?? 0) > 0;
}

/** For a live source: everything in `present` is open, every other open alert of that source and company (within `keyPrefix`) is resolved. */
export async function reconcile(c: PoolClient, companyId: string | null, source: Source, present: AlertInput[], now = new Date(), keyPrefix?: string, except?: string): Promise<{ raised: number; resolved: number }> {
  let raised = 0, resolved = 0;
  for (const a of present) if ((await raise(c, a, now)).isNew) raised++;
  const keys = new Set(present.map((a) => a.key));
  const open = await many<{ key: string }>(c, "select key from alerts where coalesce(company_id,$1::uuid)=coalesce($2::uuid,$1::uuid) and source=$3 and resolved_at is null", [NIL, companyId, source]);
  for (const o of open) if (!keys.has(o.key) && (!keyPrefix || o.key.startsWith(keyPrefix)) && !(except && o.key.startsWith(except))) { if (await resolve(c, companyId, o.key, now)) resolved++; }
  return { raised, resolved };
}

const base = () => (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");

/** What the poll and the scheduler found this tick, plus runs that failed since the last look. */
export async function collectThisTick(c: PoolClient, poll: PollReport, tick: TickReport, now = new Date()): Promise<{ raised: number; resolved: number }> {
  let raised = 0, resolved = 0;
  const add = (r: { raised: number; resolved: number }) => { raised += r.raised; resolved += r.resolved; };
  // 1. polling: a cursor that has failed twice in a row is a problem; one miss is the vendor blinking
  const companies = await many<{ id: string; slug: string }>(c, "select id, slug from companies where status in ('active','hosted')");
  const stuck = await many<{ company_id: string; entity: string; n: number; last_success_at: Date | null }>(c, "select company_id, entity, consecutive_failures as n, last_success_at from poll_cursors where consecutive_failures >= 2");
  for (const co of companies) {
    const present: AlertInput[] = [];
    for (const s of stuck.filter((x) => x.company_id === co.id)) {
      const err = poll.errors.find((e) => e.company === co.slug && e.entity === s.entity)?.error ?? "";
      present.push({ companyId: co.id, key: `poll:${s.entity}`, level: "error", source: "poll", text: `Polling ${s.entity.replace(/^appointments:/, "calendar ")} has failed ${s.n} times in a row${err ? `: ${err.slice(0, 160)}` : ""}${s.last_success_at ? ` (last good read ${s.last_success_at.toISOString()})` : ""}`, href: `/c/${co.slug}` });
    }
    const broken = await many<{ target_id: string; name: string | null; n: number }>(c, "select a.target_id, w.name, count(*)::int as n from audit_log a left join workflows w on w.id::text=a.target_id where a.company_id=$1 and a.action='workflow.unparseable' and a.at > now() - interval '10 minutes' group by a.target_id, w.name", [co.id]);
    for (const b of broken) present.push({ companyId: co.id, key: `workflow:unparseable:${b.target_id}`, level: "error", source: "poll", text: `"${b.name ?? b.target_id}" no longer parses on this engine and is being skipped (${b.n} time${b.n > 1 ? "s" : ""} in 10 min). Re-install upgrades it.`, href: `/c/${co.slug}/w/${b.target_id}` });
    add(await reconcile(c, co.id, "poll", present, now));
  }
  // 2. the engine itself
  if (tick.recovery) { if ((await raise(c, { companyId: null, key: "engine:recovery", level: "warning", source: "engine", text: `Engine came back after a gap and is catching up (${tick.staleExits} stale runs exited this tick).` }, now)).isNew) raised++; }
  else if (await resolve(c, null, "engine:recovery", now, true)) resolved++;
  // 3. runs that failed since the last look: the moment it happened, with the step and the reason
  const cursor = (await one<{ value: { since?: string } }>(c, "select value from engine_state where key='alerts_cursor'"))?.value.since;
  const since = cursor ? new Date(cursor) : new Date(now.getTime() - 60 * 60e3);
  const failed = await many<{ id: string; company_id: string; slug: string; workflow_id: string; workflow: string; current_node: string | null; exit_reason: string | null; contact: string; finished_at: Date }>(c,
    `select r.id, r.company_id, co.slug, r.workflow_id, w.name as workflow, r.current_node, r.exit_reason, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as contact, r.finished_at
     from runs r join workflows w on w.id=r.workflow_id join companies co on co.id=r.company_id left join contacts ct on ct.id=r.contact_id
     where r.status='failed' and r.finished_at > $1 and r.finished_at <= $2 order by r.finished_at`, [since, now]);
  for (const f of failed) {
    const step = f.current_node ? await stepWords(c, f.workflow_id, f.current_node) : "the start";
    const r = await raise(c, { companyId: f.company_id, key: `step:${f.workflow_id}:${f.current_node ?? "start"}`, level: "error", source: "step", text: `"${f.workflow}" failed at ${step}${f.contact ? ` for ${f.contact}` : ""}: ${(f.exit_reason ?? "unknown error").slice(0, 300)}`, detail: { run_id: f.id, node: f.current_node, error: f.exit_reason }, href: `/c/${f.slug}/r/${f.id}` }, now);
    if (r.isNew) raised++;
  }
  // a step that could not do its job (Slack not connected, no AI key) is not a failure of the run, but you want to know the minute it happens
  const blocked = await many<{ run_id: string; company_id: string; slug: string; workflow_id: string; workflow: string; node_id: string; why: string | null; contact: string }>(c,
    `select r.id as run_id, r.company_id, co.slug, r.workflow_id, w.name as workflow, s.node_id, s.result->>'why' as why, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as contact
     from run_steps s join runs r on r.id=s.run_id join workflows w on w.id=r.workflow_id join companies co on co.id=r.company_id left join contacts ct on ct.id=r.contact_id
     where s.status='skipped' and s.result->>'kind'='blocked' and s.finished_at > $1 and s.finished_at <= $2 order by s.finished_at`, [since, now]);
  for (const b of blocked) {
    const step = await stepWords(c, b.workflow_id, b.node_id);
    const r = await raise(c, { companyId: b.company_id, key: `blocked:${b.workflow_id}:${b.node_id}`, level: "warning", source: "step", text: `"${b.workflow}" could not run ${step}${b.contact ? ` for ${b.contact}` : ""}: ${(b.why ?? "blocked").slice(0, 200)}. The run went on without it.`, detail: { run_id: b.run_id, node: b.node_id, why: b.why }, href: `/c/${b.slug}/r/${b.run_id}` }, now);
    if (r.isNew) raised++;
  }
  await c.query("insert into engine_state (key, value, updated_at) values ('alerts_cursor', $1, now()) on conflict (key) do update set value=$1, updated_at=now()", [{ since: now.toISOString() }]);
  // a step alert (failed or blocked) is over once a later run of that workflow gets past that step
  const openSteps = await many<AlertRow>(c, "select * from alerts where source='step' and resolved_at is null");
  for (const a of openSteps) {
    const [, wf, node] = a.key.split(":");
    const passed = await one(c, "select 1 from run_steps s join runs r on r.id=s.run_id where r.workflow_id=$1 and s.node_id=$2 and s.status='ok' and s.started_at > $3 limit 1", [wf, node, a.last_seen]);
    if (passed && (await resolve(c, a.company_id, a.key, now))) resolved++;
  }
  return { raised, resolved };
}

async function stepWords(c: PoolClient, workflowId: string, nodeId: string): Promise<string> {
  try {
    const v = await one<{ definition: unknown }>(c, "select v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.id=$1", [workflowId]);
    const { parseDefinition } = await import("./definition"); const { describeNode } = await import("./describe");
    const n = v ? parseDefinition(v.definition).nodes.find((x) => x.id === nodeId) : undefined;
    return n ? `step ${nodeId} (${describeNode(n).title})` : `step ${nodeId}`;
  } catch { return `step ${nodeId}`; }
}

/** Where a company wants to hear about problems: Slack channel, email addresses, a webhook (a Zap). The sweep may have its own channel and face. */
export type Destinations = { slackToken: string | null; channel: string | null; emails: string[]; webhook: string | null; emailKey: string | null; emailFrom: string | null; as: { name?: string; icon?: string } };
export async function destinationsFor(c: PoolClient, companyId: string): Promise<Destinations> {
  const b = Object.fromEntries((await many<{ key: string; kind: string; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1 and (key like 'alerts.%' or key in ('secret.resend_key','slack.name','slack.icon'))", [companyId])).map((r) => [r.key, r.kind === "secret" ? decrypt(r.value) : r.value.toString("utf8")]));
  const conn = await one<{ bot_token: Buffer }>(c, "select bot_token from slack_connections where company_id=$1", [companyId]);
  return { slackToken: conn ? decrypt(conn.bot_token) : null, channel: b["alerts.slack_channel"] || null, emails: (b["alerts.email"] ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean), webhook: b["alerts.webhook"] || process.env.OPERATOR_WEBHOOK_URL || null,
    emailKey: b["secret.resend_key"] || process.env.RESEND_API_KEY || null, emailFrom: b["alerts.email_from"] || process.env.ALERT_EMAIL_FROM || null, as: { name: b["alerts.as_name"] || "Engine alerts", icon: b["alerts.as_icon"] || undefined } };
}

const mark = (level: Level) => (level === "error" ? "🔴" : "🟡");
const hoursOpen = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 36e5);

/** Say what is new, repeat what is still open after an hour (in its thread), and close what has cleared (in its thread, with a ✅). */
export async function announceDue(c: PoolClient, adapters: Adapters, now = new Date()): Promise<{ posted: number; repeated: number; resolved: number }> {
  const out = { posted: 0, repeated: 0, resolved: 0 };
  const due = await many<AlertRow & { slug: string | null; company: string | null }>(c, `select a.*, co.slug, co.name as company from alerts a left join companies co on co.id=a.company_id
    where (a.resolved_at is null and (a.announced_at is null or a.announced_at < $1)) or (a.resolved_at is not null and not a.resolved_announced) order by a.first_seen`, [new Date(now.getTime() - REPEAT_AFTER_MIN * 60e3)]);
  for (const a of due) {
    const dest: Destinations = a.company_id ? await destinationsFor(c, a.company_id) : { slackToken: null, channel: null, emails: [], webhook: process.env.OPERATOR_WEBHOOK_URL ?? null, emailKey: null, emailFrom: null, as: { name: "Engine alerts" } };
    // the sweep can have its own channel and face
    const hc = a.source === "health" && a.company_id ? await one<{ channel: string | null; as_name: string | null; as_icon: string | null }>(c, "select channel, as_name, as_icon from health_checks where company_id=$1", [a.company_id]) : null;
    const channel = hc?.channel || dest.channel; const as = { name: hc?.as_name || dest.as.name, icon: hc?.as_icon || dest.as.icon || (a.level === "error" ? ":rotating_light:" : ":warning:") };
    const link = a.href ? `${base()}${a.href}` : null; const where = a.company ? `${a.company} · ` : "";
    if (a.resolved_at) {
      // resolved: a reply in the thread and a check on the first post; email and webhook get a short note
      if (dest.slackToken && a.slack_channel && a.slack_ts) {
        const reacted = await adapters.notifier.react(dest.slackToken, a.slack_channel, a.slack_ts, "white_check_mark").catch(() => false);
        await adapters.notifier.post(dest.slackToken, a.slack_channel, `✅ Resolved after ${hoursOpen(a.first_seen, a.resolved_at)}h: ${a.text.slice(0, 200)}${reacted ? "" : "\n_(add the reactions:write scope to the Slack app and the first post gets a ✅ too)_"}`, as, a.slack_ts).catch(() => null);
      }
      await sendEmail(dest, `Resolved: ${where}${a.text.slice(0, 80)}`, `${where}${a.text}\n\nResolved ${a.resolved_at.toISOString()}${link ? `\n${link}` : ""}`);
      await sendWebhook(dest, "alert.resolved", a, now);
      await c.query("update alerts set resolved_announced=true where id=$1", [a.id]); out.resolved++; continue;
    }
    const repeat = a.announce_count > 0;
    let said = false;   // counted only when something actually went out; an alert with no destination is still marked so it is not retried every minute
    if (dest.slackToken && channel) {
      if (repeat && a.slack_ts) { const thread = (a.detail as { thread?: string }).thread; said = !!(await adapters.notifier.post(dest.slackToken, channel, `${mark(a.level)} Still open after ${hoursOpen(a.first_seen, now)}h: ${a.text.slice(0, 300)}${thread ? `\n${thread}` : ""}`, as, a.slack_ts).catch(() => null)); }   // the hourly repeat carries the fresh breakdown
      else {
        const fix = (a.detail as { fix?: { label: string } }).fix; const extra = (a.detail as { link?: string; link_label?: string });
        const r = await adapters.notifier.post(dest.slackToken, channel, `${mark(a.level)} *${where}${a.source === "step" ? (a.key.startsWith("blocked:") ? "Step could not run" : "Run failed") : a.source === "health" ? "Health check" : a.source === "poll" ? "Polling" : "Engine"}*\n${a.text}${link ? `\n<${link}|Open>${fix ? ` · <${link}#fix|${fix.label}>` : ""}` : ""}${extra.link ? `${link ? " · " : "\n"}<${extra.link}|${extra.link_label ?? "Open"}>` : ""}`, as).catch(() => null);
        if (r) {
          said = true; await c.query("update alerts set slack_channel=$2, slack_ts=$3 where id=$1", [a.id, channel, r.ts]);
          // the detail that belongs under the post, not in it: the next days' availability at a glance
          const thread = (a.detail as { thread?: string }).thread; if (thread) await adapters.notifier.post(dest.slackToken, channel, thread, as, r.ts).catch(() => null);
        }
      }
    }
    if (!repeat && (await sendEmail(dest, `${a.level === "error" ? "Error" : "Warning"}: ${where}${a.text.slice(0, 80)}`, `${where}${a.text}${link ? `\n\n${link}` : ""}`))) said = true;
    if (await sendWebhook(dest, repeat ? "alert.repeated" : "alert.raised", a, now)) said = true;
    await c.query("update alerts set announced_at=$2, announce_count=announce_count+1 where id=$1", [a.id, now]);
    if (said) { if (repeat) out.repeated++; else out.posted++; }
  }
  return out;
}

async function sendEmail(dest: Destinations, subject: string, text: string): Promise<boolean> {
  if (!dest.emails.length || !dest.emailKey || !dest.emailFrom) return false;
  const r = await resendSend(dest.emailKey, { from: dest.emailFrom, to: dest.emails, subject: `[Engine] ${subject}`, text }).catch(() => ({ ok: false }));
  return r.ok;
}
async function sendWebhook(dest: Destinations, event: string, a: AlertRow, now: Date): Promise<boolean> {
  if (!dest.webhook) return false;
  try { const r = await fetch(dest.webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, at: now.toISOString(), source: "backend-in-a-box", alert: { id: a.id, key: a.key, level: a.level, kind: a.source, text: a.text, href: a.href ? `${base()}${a.href}` : null, first_seen: a.first_seen, resolved_at: a.resolved_at } }) }); return r.ok; }
  catch { return false; }   /* the alert channel being down is reported by the outside health check, not by us */
}

/** The whole tick's worth: collect, then announce. The tick route wraps this so a failure here never fails the tick. */
export async function tickAlerts(c: PoolClient, adapters: Adapters, poll: PollReport, tick: TickReport, now = new Date()): Promise<{ raised: number; resolved: number; posted: number; repeated: number; closed: number }> {
  const col = await collectThisTick(c, poll, tick, now);
  const ann = await announceDue(c, adapters, now);
  return { raised: col.raised, resolved: col.resolved, posted: ann.posted, repeated: ann.repeated, closed: ann.resolved };   // resolved: state changes this tick; closed: "resolved" notes that went out
}

export type OpenAlert = AlertRow & { slug: string | null; company: string | null };
export const openAlerts = (c: PoolClient, companyId?: string | null) => many<OpenAlert>(c, `select a.*, co.slug, co.name as company from alerts a left join companies co on co.id=a.company_id where a.resolved_at is null ${companyId === undefined ? "" : "and coalesce(a.company_id,$2::uuid)=coalesce($1::uuid,$2::uuid)"} order by a.level, a.first_seen desc`, companyId === undefined ? [] : [companyId, NIL]);
export const recentAlerts = (c: PoolClient, companyId: string, limit = 30) => many<AlertRow>(c, "select * from alerts where company_id=$1 order by coalesce(resolved_at, now()) desc, first_seen desc limit $2", [companyId, limit]);
/** What the home page shows: open problems across the engine, with company names. */
export const currentProblems = async (c: PoolClient) => ({ value: { at: new Date().toISOString(), problems: (await openAlerts(c)).map((a) => ({ key: a.key, level: a.level, text: `${a.company ? `${a.company}: ` : ""}${a.text}`, company: a.slug ?? undefined, href: a.href })) } });
