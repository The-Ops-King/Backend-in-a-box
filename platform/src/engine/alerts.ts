import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import type { PollReport } from "./poll";
import type { TickReport } from "./runner";
import { classifyError, plainError } from "./failures";

/**
 * D33. The engine tells the operator the minute something fails, and says so once.
 * One open alert per (company, key): the collecting, the dedupe and the cadence are the engine's. What is said, and where,
 * is the company's Health check workflow (D88): the first time an alert is due the engine emits `alert.raised`, while it
 * stays open `alert.repeated` every `alerts.repeat_minutes` (60), and once it clears `alert.resolved`; the workflow posts the
 * alert, its hourly line in the thread and the ✅. Nothing is said while everything works. Slack only (Tyler: "We definitely
 * don't need to alert on an email"); an alert about the engine itself (no company) goes to OPERATOR_WEBHOOK_URL.
 *
 * Sources: `step` (a run failed at a step), `poll` (the CRM poll keeps failing), `health` (the hourly sweep), `engine`.
 * Live sources (poll, health, engine) are reconciled: what is present stays open, what is absent resolves.
 */
export type Level = "error" | "warning";
export type Source = "step" | "poll" | "health" | "engine";
export type AlertInput = { companyId: string | null; key: string; level: Level; source: Source; text: string; detail?: Record<string, unknown>; href?: string | null };
export type AlertRow = { id: string; company_id: string | null; key: string; level: Level; source: Source; text: string; detail: Record<string, unknown>; href: string | null; first_seen: Date; last_seen: Date; announced_at: Date | null; announce_count: number; slack_channel: string | null; slack_ts: string | null; resolved_at: Date | null; resolved_announced: boolean };

/** The defaults of the two alert settings (bindings, D88): `alerts.repeat_minutes` and `alerts.poll_failures`. */
export const REPEAT_AFTER_MIN = 60;
export const POLL_FAILURES = 2;
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
  // 1. polling: a cursor that has failed `alerts.poll_failures` times in a row (2) is a problem; one miss is the vendor blinking
  const companies = await many<{ id: string; slug: string }>(c, "select id, slug from companies where status in ('active','hosted')");
  const stuck = await many<{ company_id: string; entity: string; n: number; last_success_at: Date | null }>(c, `select p.company_id, p.entity, p.consecutive_failures as n, p.last_success_at from poll_cursors p
    left join bindings b on b.company_id=p.company_id and b.key='alerts.poll_failures'
    where p.consecutive_failures >= greatest(1, coalesce(nullif(regexp_replace(convert_from(b.value, 'UTF8'), '\\D', '', 'g'), '')::int, $1))`, [POLL_FAILURES]);
  for (const co of companies) {
    const present: AlertInput[] = [];
    for (const s of stuck.filter((x) => x.company_id === co.id)) {
      const err = poll.errors.find((e) => e.company === co.slug && e.entity === s.entity)?.error ?? "";
      present.push({ companyId: co.id, key: `poll:${s.entity}`, level: "error", source: "poll", text: `Polling ${s.entity.replace(/^appointments:/, "calendar ")} has failed ${s.n} times in a row${err ? `: ${err.slice(0, 160)}` : ""}${s.last_success_at ? ` (last good read ${s.last_success_at.toISOString()})` : ""}`, href: `/app/c/${co.slug}` });
    }
    const broken = await many<{ target_id: string; name: string | null; n: number }>(c, "select a.target_id, w.name, count(*)::int as n from audit_log a left join workflows w on w.id::text=a.target_id where a.company_id=$1 and a.action='workflow.unparseable' and a.at > now() - interval '10 minutes' group by a.target_id, w.name", [co.id]);
    for (const b of broken) present.push({ companyId: co.id, key: `workflow:unparseable:${b.target_id}`, level: "error", source: "poll", text: `"${b.name ?? b.target_id}" no longer parses on this engine and is being skipped (${b.n} time${b.n > 1 ? "s" : ""} in 10 min). Re-install upgrades it.`, href: `/app/c/${co.slug}/w/${b.target_id}` });
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
    const step = f.current_node ? await stepWords(c, f.workflow_id, f.current_node) : "start";
    const r = await raise(c, { companyId: f.company_id, key: `step:${f.workflow_id}:${f.current_node ?? "start"}`, level: "error", source: "step", text: `${f.workflow} failed when it tried to ${step}${f.contact ? ` for ${f.contact}` : ""}: ${plainError(classifyError(f.exit_reason ?? "unknown error"))}.`, detail: { run_id: f.id, node: f.current_node, error: f.exit_reason }, href: `/app/c/${f.slug}/r/${f.id}` }, now);
    if (r.isNew) raised++;
  }
  // a step that could not do its job (Slack not connected, no AI key) is not a failure of the run, but you want to know the minute it happens
  const blocked = await many<{ run_id: string; company_id: string; slug: string; workflow_id: string; workflow: string; node_id: string; why: string | null; contact: string }>(c,
    `select r.id as run_id, r.company_id, co.slug, r.workflow_id, w.name as workflow, s.node_id, s.result->>'why' as why, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as contact
     from run_steps s join runs r on r.id=s.run_id join workflows w on w.id=r.workflow_id join companies co on co.id=r.company_id left join contacts ct on ct.id=r.contact_id
     where s.status='skipped' and s.result->>'kind'='blocked' and s.finished_at > $1 and s.finished_at <= $2 order by s.finished_at`, [since, now]);
  for (const b of blocked) {
    const step = await stepWords(c, b.workflow_id, b.node_id);
    // D66: a vendor rejecting its token is one alert per vendor, however many steps it blocks (a Slack post is never the point of a run, so the run went on)
    const f = classifyError(b.why ?? "");
    const r = f.cls === "auth" && f.vendor
      ? await raise(c, { companyId: b.company_id, key: `auth:${f.vendor}`, level: "error", source: "step", text: `${f.vendor.toUpperCase()} rejected the company's token: its steps are recorded as blocked and runs go on without them until the token is replaced. First seen when ${b.workflow} couldn't ${step}${b.contact ? ` for ${b.contact}` : ""}: ${plainError(f)}.`, detail: { run_id: b.run_id, node: b.node_id, vendor: f.vendor, why: b.why }, href: `/app/c/${b.slug}/r/${b.run_id}` }, now)
      : await raise(c, { companyId: b.company_id, key: `blocked:${b.workflow_id}:${b.node_id}`, level: "warning", source: "step", text: `${b.workflow} couldn't ${step}${b.contact ? ` for ${b.contact}` : ""}: ${plainError(classifyError(b.why ?? "blocked"))}. The run went on without it.`, detail: { run_id: b.run_id, node: b.node_id, why: b.why }, href: `/app/c/${b.slug}/r/${b.run_id}` }, now);
    if (r.isNew) raised++;
  }
  await c.query("insert into engine_state (key, value, updated_at) values ('alerts_cursor', $1, now()) on conflict (key) do update set value=$1, updated_at=now()", [{ since: now.toISOString() }]);
  // a step alert (failed or blocked) is over once a later run of that workflow gets past that step
  const openSteps = await many<AlertRow>(c, "select * from alerts where source='step' and resolved_at is null");
  for (const a of openSteps) {
    if (!a.key.startsWith("step:") && !a.key.startsWith("blocked:")) continue;   // D66: `run:<id>:paused` closes on Retry/Skip (D77: or when its held step passes), `auth:<vendor>` when the token is replaced, D77's `skipped:` when that step is retried
    const [, wf, node] = a.key.split(":");
    const passed = await one(c, "select 1 from run_steps s join runs r on r.id=s.run_id where r.workflow_id=$1 and s.node_id=$2 and s.status='ok' and s.started_at > $3 limit 1", [wf, node, a.last_seen]);
    if (passed && (await resolve(c, a.company_id, a.key, now))) resolved++;
  }
  return { raised, resolved };
}

async function stepWords(c: PoolClient, workflowId: string, nodeId: string): Promise<string> {
  try {
    const v = await one<{ definition: unknown }>(c, "select v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.id=$1", [workflowId]);
    const { parseDefinition } = await import("./definition"); const { doingWords } = await import("./blocking");
    const n = v ? parseDefinition(v.definition).nodes.find((x) => x.id === nodeId) : undefined;
    return n ? doingWords(n) : `do step ${nodeId}`;   // D77: what the step does, never its id
  } catch { return `do step ${nodeId}`; }
}

/** Where a company's alerts go and the face they post as: the health check's own channel and face for its findings, else the alerts channel (D33). The workflow posts there. */
export async function destinationsFor(c: PoolClient, companyId: string, source?: Source): Promise<{ channel: string | null; as_name: string | null; as_icon: string | null }> {
  const b = Object.fromEntries((await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and key in ('alerts.slack_channel','alerts.as_name','alerts.as_icon')", [companyId])).map((r) => [r.key, r.value.toString("utf8")]));
  const hc = source === "health" ? await one<{ channel: string | null; as_name: string | null; as_icon: string | null }>(c, "select channel, as_name, as_icon from health_checks where company_id=$1", [companyId]) : null;
  return { channel: hc?.channel || b["alerts.slack_channel"] || null, as_name: hc?.as_name || b["alerts.as_name"] || null, as_icon: hc?.as_icon || b["alerts.as_icon"] || null };
}

const hoursOpen = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 36e5);
/** "17 min", "3 hours", "2 days": how long an alert was open, as a person says it. */
export const openFor = (from: Date, to: Date) => { const min = Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000)); return min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} hour${Math.round(min / 60) === 1 ? "" : "s"}` : `${Math.round(min / 1440)} days`; };
/** What kind of alert it is, for the workflow's words ("Token rejected", "Health check"…). */
export const alertKind = (a: Pick<AlertRow, "source" | "key" | "detail">): string => a.source !== "step" ? a.source
  : a.key.startsWith("blocked:") ? "blocked" : a.key.startsWith("skipped:") ? "skipped" : a.key.startsWith("run:") ? ((a.detail as { held?: boolean }).held ? "held" : "paused") : a.key.startsWith("auth:") ? "auth" : "failed";

/**
 * D88 (A7): what is due is an event for the company's workflows, not a post: `alert.raised` the first time, `alert.repeated`
 * once it has been open `alerts.repeat_minutes` since it was last said, `alert.resolved` once it cleared. The Health check
 * workflow says it (Slack, threaded under the first post by its tag, ✅ on resolve). An alert with no company (the engine itself)
 * goes to the operator's webhook. Returns how many of each were handed on (a workflow started for them).
 */
export async function announceDue(c: PoolClient, _adapters: Adapters, now = new Date(), onlyCompanyId?: string): Promise<{ posted: number; repeated: number; resolved: number }> {
  const out = { posted: 0, repeated: 0, resolved: 0 };
  const due = await many<AlertRow & { slug: string | null; company: string | null }>(c, `select a.*, co.slug, co.name as company from alerts a left join companies co on co.id=a.company_id
    left join bindings b on b.company_id=a.company_id and b.key='alerts.repeat_minutes'
    where ($2::uuid is null or a.company_id=$2) and ((a.resolved_at is null and (a.announced_at is null
      or a.announced_at < $1::timestamptz - make_interval(mins => greatest(1, coalesce(nullif(regexp_replace(convert_from(b.value, 'UTF8'), '\\D', '', 'g'), '')::int, $3)))))
      or (a.resolved_at is not null and not a.resolved_announced)) order by a.first_seen`, [now, onlyCompanyId ?? null, REPEAT_AFTER_MIN]);
  const { dispatchEvent, emitEvent } = await import("./dispatch");
  for (const a of due) {
    const type = a.resolved_at ? "alert.resolved" : a.announce_count > 0 ? "alert.repeated" : "alert.raised";
    let handed = false;
    if (!a.company_id) handed = await sendWebhook(type, a, now);   // the engine itself: no company workflow to say it
    else {
      const dest = await destinationsFor(c, a.company_id, a.source);
      const d = a.detail as { fix?: { label: string }; link?: string; link_label?: string; thread?: string };
      const link = a.href ? `${base()}${a.href}` : null;
      const ev = await emitEvent(c, { company_id: a.company_id, contact_id: null, opportunity_id: null, appointment_id: null, event_type: type, source: "engine", data: {
        alert_id: a.id, key: a.key, level: a.level, source: a.source, kind: alertKind(a), text: a.text, detail: a.detail, company: a.company, href: a.href, link,
        ...(link && d.fix ? { fix_link: `${link}#fix`, fix_label: d.fix.label } : {}), ...(d.link ? { extra_link: d.link, extra_label: d.link_label ?? null } : {}), ...(d.thread ? { thread: d.thread } : {}),
        hours_open: hoursOpen(a.first_seen, a.resolved_at ?? now), open_for: openFor(a.first_seen, a.resolved_at ?? now), first_seen: a.first_seen.toISOString(), ...(a.resolved_at ? { resolved_at: a.resolved_at.toISOString() } : {}),
        channel: dest.channel, as_name: dest.as_name, as_icon: dest.as_icon } });
      handed = (await dispatchEvent(c, ev, {})).length > 0;
    }
    // marked either way: an alert nobody listens for is not handed on again every minute
    if (a.resolved_at) await c.query("update alerts set resolved_announced=true where id=$1", [a.id]);
    else await c.query("update alerts set announced_at=$2, announce_count=announce_count+1 where id=$1", [a.id, now]);
    if (handed) { if (type === "alert.resolved") out.resolved++; else if (type === "alert.repeated") out.repeated++; else out.posted++; }
  }
  return out;
}

async function sendWebhook(event: string, a: AlertRow, now: Date): Promise<boolean> {
  const url = process.env.OPERATOR_WEBHOOK_URL; if (!url) return false;
  try { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, at: now.toISOString(), source: "backend-in-a-box", alert: { id: a.id, key: a.key, level: a.level, kind: a.source, text: a.text, href: a.href ? `${base()}${a.href}` : null, first_seen: a.first_seen, resolved_at: a.resolved_at } }) }); return r.ok; }
  catch { return false; }   /* the alert channel being down is reported by the outside health check, not by us */
}

/** The whole tick's worth: collect, then announce. The tick route wraps this so a failure here never fails the tick. */
export async function tickAlerts(c: PoolClient, adapters: Adapters, poll: PollReport, tick: TickReport, now = new Date(), onlyCompanyId?: string): Promise<{ raised: number; resolved: number; posted: number; repeated: number; closed: number }> {
  const col = await collectThisTick(c, poll, tick, now);
  const ann = await announceDue(c, adapters, now, onlyCompanyId);   // a test, or a tick for one company, hears only its own alerts
  return { raised: col.raised, resolved: col.resolved, posted: ann.posted, repeated: ann.repeated, closed: ann.resolved };   // resolved: state changes this tick; closed: "resolved" notes that went out
}

export type OpenAlert = AlertRow & { slug: string | null; company: string | null };
export const openAlerts = (c: PoolClient, companyId?: string | null) => many<OpenAlert>(c, `select a.*, co.slug, co.name as company from alerts a left join companies co on co.id=a.company_id where a.resolved_at is null ${companyId === undefined ? "" : "and coalesce(a.company_id,$2::uuid)=coalesce($1::uuid,$2::uuid)"} order by a.level, a.first_seen desc`, companyId === undefined ? [] : [companyId, NIL]);
export const recentAlerts = (c: PoolClient, companyId: string, limit = 30) => many<AlertRow>(c, "select * from alerts where company_id=$1 order by coalesce(resolved_at, now()) desc, first_seen desc limit $2", [companyId, limit]);
/** What the home page shows: open problems across the engine, with company names. */
export const currentProblems = async (c: PoolClient) => ({ value: { at: new Date().toISOString(), problems: (await openAlerts(c)).map((a) => ({ key: a.key, level: a.level, text: `${a.company ? `${a.company}: ` : ""}${a.text}`, company: a.slug ?? undefined, href: a.href })) } });
