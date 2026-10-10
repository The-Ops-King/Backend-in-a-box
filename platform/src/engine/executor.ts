import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { onwardEdge, type Edge, type Node } from "./definition";
import { evaluate } from "./predicate";
import { render, resolveExpr, resolvePath, parseDuration, StaleTemplateError, UnknownPathError } from "./template";
import { predicateWords, durationWords } from "./describe";
import { syncCards, pickCard } from "./cards";
import { computeWaitUntil, deferIntoWindow } from "./waitrule";
import type { CompanyRow, RunRow } from "./context";
import { contactPasses } from "./mode";
import { emitEvent } from "./dispatch";
import { applyOutcome, outcomeTermFor } from "./disposition";
import { liveProbes, runAvailabilityStep, runHealthStep, type HealthProbes } from "./health";
import { buildReport, periodFor, REPORT_KINDS, type ReportKind } from "./reports";

/** Shadow posts to the team are real posts, labelled; nothing else in shadow leaves the engine. */
export const SHADOW_PREFIX = "🧪 *shadow* — ";
/** A post made before live says which rung it came from, so the team never reads a rehearsal as a real client. */
const modePrefix = (d: ExecDeps) => (d.company.mode === "live" ? "" : d.company.mode === "shadow" ? SHADOW_PREFIX : `🧪 *${d.company.mode}* — `);
/** The step's own name/icon, else the company's defaults (bindings slack.name / slack.icon), else the app. A list of icons is handed on whole; the notifier picks one per post. */
const persona = (d: ExecDeps, as?: { name?: string; icon?: string | string[] }) => ({ name: as?.name ? render(as.name, d.ctx, env(d)) : d.bindings["slack.name"], icon: as?.icon ? (Array.isArray(as.icon) ? as.icon.map((i) => render(i, d.ctx, env(d))) : render(as.icon, d.ctx, env(d))) : d.bindings["slack.icon"] });
type Person = { name: string; email?: string | null; ghl_user_id?: string | null; slack_user_id?: string | null; mention?: string };
/** The people a post may @mention (contact.closer, contact.setter, contact.owner): look each up in Slack by email once and remember it, so `{{contact.closer.mention}}` is a real mention, not a name. */
async function resolveMentions(d: ExecDeps, botToken: string): Promise<void> {
  const contact = d.ctx.contact as Record<string, unknown> | undefined;
  const appt = d.ctx.appointment as Record<string, unknown> | undefined;
  const people: (Person & { id?: string })[] = [...(contact ? ["closer", "setter", "owner"].map((k) => contact[k] as Person | undefined) : []), appt?.closer as (Person & { id?: string }) | undefined, d.ctx.user as (Person & { id?: string }) | undefined].filter((p): p is Person & { id?: string } => !!p && !!p.name);
  for (const p of people) {
    if (p.slack_user_id || !p.email) continue;
    const id = await d.adapters.notifier.lookupUserByEmail(botToken, p.email).catch(() => null);
    if (!id) continue;
    p.slack_user_id = id; p.mention = `<@${id}>`;
    if (p.id) await d.c.query("update users set slack_user_id=$2 where id=$1", [p.id, id]);
    else if (p.ghl_user_id) await d.c.query("update users set slack_user_id=$2 where company_id=$1 and ghl_user_id=$3", [d.company.id, id, p.ghl_user_id]);
  }
}
const jsonArrayOr = (r: string): unknown => { try { const v = JSON.parse(r); return Array.isArray(v) ? v : r; } catch { return r; } };

export type StepOutcome =
  | { status: "ok"; next: string | null; result?: Record<string, unknown> }
  | { status: "skipped" | "stale"; next: string | null; result?: Record<string, unknown> }
  | { status: "waiting"; until?: DateTime; stay?: boolean; wakeOnReply?: boolean; wakeOnTag?: string; result?: Record<string, unknown> }   // stay: re-execute this same node on wake; wakeOnReply: an inbound message wakes it early; wakeOnTag: a tap on that Slack post does; no until: only a wake moves it
  | { status: "exit"; reason: string; result?: Record<string, unknown>; gate?: boolean }   // gate: stopped at a check before doing anything, so the run does not count toward "once per …" (D30)
  | { status: "paused"; reason: string; result?: Record<string, unknown> }
  | { status: "resume"; result?: Record<string, unknown> }   // D58: back to runs.resume_node (the step a listener pulled the run away from) with its saved due time
  | { status: "failed"; error: string };

/** D58: a non-blocking wait_for_reaction, armed on the run (vars.__listen) while it goes on; the runner reads it at every wake. */
export type Listener = { node: string; tag: string; channel: string; ts: string; emojis: string[]; into: string; until: string | null; armed_at: string };
export const listenerOf = (ctx: Record<string, unknown>): Listener | undefined => resolvePath(ctx, "vars.__listen") as Listener | undefined;

export type ExecDeps = { c: PoolClient; adapters: Adapters; company: CompanyRow; adapterCompany: Company; bindings: Record<string, string>; run: RunRow; ctx: Record<string, unknown>; edgesFrom: (id: string) => Edge[]; now: DateTime; probes?: HealthProbes };

const contactTz = (d: ExecDeps) => ((d.ctx.contact as { timezone?: string } | undefined)?.timezone) ?? d.company.timezone;
/** Shadow mode: the run proceeds exactly as it would live, but nothing is written to the CRM; sends are recorded as "would have sent". */
const shadow = (d: ExecDeps) => d.company.mode === "shadow";
const single = (d: ExecDeps, id: string): string | null => onwardEdge(d.edgesFrom(id))?.to ?? null;
const env = (d: ExecDeps) => ({ now: d.now, tz: contactTz(d), companyTz: d.company.timezone });

function validityOk(d: ExecDeps, node: Extract<Node, { type: "send_sms" | "send_email" }>): { ok: true } | { ok: false; why: string } {
  const v = node.validity; if (!v || v.anchor === "unanchored") return { ok: true };
  const startsIso = resolvePath(d.ctx, "appointment.starts_at");
  if (typeof startsIso !== "string") return { ok: false, why: "no appointment on run" };
  const starts = DateTime.fromISO(startsIso);
  if (v.anchor === "before_event") { const lead = v.min_lead ? parseDuration(v.min_lead) : undefined; const deadline = lead ? starts.minus(lead) : starts; return d.now <= deadline ? { ok: true } : { ok: false, why: `past before_event deadline ${deadline.toISO()}` }; }
  const lag = v.max_lag ? parseDuration(v.max_lag) : undefined; const limit = lag ? starts.plus(lag) : undefined;
  if (d.now < starts) return { ok: false, why: "after_event message before the event" };
  return !limit || d.now <= limit ? { ok: true } : { ok: false, why: `past after_event limit ${limit.toISO()}` };
}

async function recordSend(d: ExecDeps, node: Node, channel: "sms" | "email" | "slack" | "webhook", body: string, status: "queued" | "suppressed", reason?: string): Promise<{ id: string } | null> {
  const key = `${d.run.id}:${node.id}`;
  const row = await one<{ id: string }>(d.c, `insert into sends (company_id, run_id, contact_id, channel, idempotency_key, rendered_body, status, suppressed_reason, scheduled_for)
    values ($1,$2,$3,$4,$5,$6,$7,$8,now()) on conflict (idempotency_key) do nothing returning id`,
    [d.company.id, d.run.id, d.run.contact_id, channel, key, body, status, reason ?? null]);
  return row ?? null;
}

async function doSend(d: ExecDeps, node: Extract<Node, { type: "send_sms" | "send_email" }>): Promise<StepOutcome> {
  const next = single(d, node.id);
  if (node.type === "send_sms" && d.company.sms_enabled === false) { await recordSend(d, node, "sms", "", "suppressed", "sms_disabled: company has no number"); return { status: "skipped", next, result: { kind: "noop", why: "sms disabled for company" } }; }
  const v = validityOk(d, node);
  let template = node.template, substituted = false;
  if (!v.ok) {
    if (node.on_stale === "skip") { await recordSend(d, node, node.type === "send_sms" ? "sms" : "email", "", "suppressed", `stale: ${v.why}`); return { status: "stale", next, result: { why: v.why } }; }
    if (node.on_stale === "escalate") { await recordSend(d, node, node.type === "send_sms" ? "sms" : "email", "", "suppressed", `stale-escalated: ${v.why}`); return { status: "paused", reason: `stale: ${v.why}` }; }
    if (!node.substitute_template) return { status: "failed", error: "on_stale=substitute but no substitute_template" };
    template = node.substitute_template; substituted = true;
  }
  // D30: the CRM's own template, when the step names one and it exists, replaces the inline copy (SMS: the snippet body is rendered here; email: the CRM builds it)
  const ghlTemplateId = node.ghl_template ? render(node.ghl_template, d.ctx, env(d)) : "";
  let viaCrmEmailTemplate = false;
  if (ghlTemplateId && node.type === "send_sms") { const snippet = await d.adapters.sender.smsTemplateBody(d.adapterCompany, ghlTemplateId).catch(() => null); if (snippet) template = snippet; }
  if (ghlTemplateId && node.type === "send_email") viaCrmEmailTemplate = true;
  let body: string, subject = "";
  try { body = render(template, d.ctx, env(d)); if (node.type === "send_email") subject = render(node.subject, d.ctx, env(d)); }
  catch (e) {
    if (e instanceof StaleTemplateError) { await recordSend(d, node, node.type === "send_sms" ? "sms" : "email", "", "suppressed", `stale-render: ${e.message}`); return node.on_stale === "escalate" ? { status: "paused", reason: e.message } : { status: "stale", next, result: { why: e.message } }; }
    if (e instanceof UnknownPathError) return { status: "failed", error: e.message };
    throw e;
  }
  const channel = node.type === "send_sms" ? "sms" : "email";
  // D52: the second gate — before live, a message reaches only a contact that passes the mode, whatever run brought us here
  if (d.run.contact_id) { const pass = await contactPasses(d.c, d.company.id, d.run.contact_id, d.company.mode, d.bindings); if (!pass.ok) { await recordSend(d, node, channel, body, "suppressed", `not a test contact: ${pass.why}`); return { status: "skipped", next, result: { kind: "blocked", why: pass.why, would_send: body.slice(0, 120) } }; } }
  const send = await recordSend(d, node, channel, body, "queued");
  if (!send) return { status: "skipped", next, result: { kind: "noop", why: "already sent (idempotency)" } };
  if (shadow(d)) {
    await d.c.query("update sends set status='shadow', sent_at=now() where id=$1", [send.id]);
    await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: "message.sent", source: "engine", data: { channel, node: node.id, shadow: true, substituted } });
    return { status: "ok", next, result: { shadow: true, would_send: body.slice(0, 120), substituted } };
  }
  const ghlContactId = (d.ctx.contact as { ghl_contact_id?: string }).ghl_contact_id!;
  const r = node.type === "send_sms"
    ? await d.adapters.sender.sendSms(d.adapterCompany, ghlContactId, body)
    : viaCrmEmailTemplate ? await d.adapters.sender.sendEmailTemplate(d.adapterCompany, ghlContactId, ghlTemplateId) : await d.adapters.sender.sendEmail(d.adapterCompany, ghlContactId, subject, body);
  await d.c.query("update sends set status=$2, external_id=$3, error=$4, sent_at=case when $2='sent' then now() end where id=$1", [send.id, r.accepted ? "sent" : "failed", r.externalId || null, r.error ?? null]);
  await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: r.accepted ? "message.sent" : "send.suppressed", source: "engine", data: { channel, node: node.id, external_id: r.externalId, error: r.error, substituted } });
  if (r.accepted) return { status: "ok", next, result: { external_id: r.externalId, substituted } };
  // D56: the refusal is on the send row and raises a "step could not run" alert; the rest of the sequence still runs
  return { status: "skipped", next, result: { kind: "blocked", why: `the CRM refused the ${channel}: ${r.error ?? "send rejected"}`, would_send: body.slice(0, 120) } };
}

/** D56: Slack refusing a post (bad token, channel gone) fails that send and alerts; the run goes on (the CRM steps after a post are the point of the run). */
async function slackPostOrFail(d: ExecDeps, sendId: string, post: () => Promise<{ ts: string }>): Promise<{ ts: string } | { refused: string }> {
  try { return await post(); }
  catch (e) {
    const refused = String((e as Error).message).slice(0, 500);
    await d.c.query("update sends set status='failed', error=$2 where id=$1", [sendId, refused]);
    return { refused };
  }
}

/** The contact's tags: `add` goes on, then `remove` comes off, in the CRM and on our replica; one tag.added / tag.removed event per direction. */
async function applyTags(d: ExecDeps, type: Node["type"], next: string | null, want: { add?: string | string[]; remove?: string | string[] }): Promise<StepOutcome> {
  const ghlId = (d.ctx.contact as { ghl_contact_id?: string | null }).ghl_contact_id;
  const rendered = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map((t) => render(t, d.ctx, env(d))).filter(Boolean);
  const dirs = ([["add", "tag.added", "would_tag"], ["remove", "tag.removed", "would_untag"]] as const).filter(([k]) => want[k] !== undefined).map(([k, event, would]) => ({ add: k === "add", raw: want[k]!, tags: rendered(want[k]), event, would }));
  if (shadow(d)) {   // shadow: log it, touch neither GHL nor our replica of GHL's tags (the next poll would just "revert" it and emit a phantom tag.removed)
    for (const x of dirs) for (const tag of x.tags) await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: x.event, source: "engine", data: { tag, shadow: true } });
    return { status: "ok", next, result: { shadow: true, ...Object.fromEntries(dirs.map((x) => [x.would, x.tags])) } };
  }
  if (!ghlId) return { status: "failed", error: `${type}: contact has no CRM id yet` };
  for (const x of dirs) {
    for (const tag of x.tags) { if (x.add) await d.adapters.write.addTag(d.adapterCompany, ghlId, tag); else await d.adapters.write.removeTag(d.adapterCompany, ghlId, tag); }
    for (const tag of x.tags) await d.c.query(x.add ? "update contacts set tags = array(select distinct unnest(tags || $2::text[])) where id=$1" : "update contacts set tags = array_remove(tags, $2) where id=$1", [d.run.contact_id, x.add ? [tag] : tag]);
    await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: x.event, source: "engine", data: { tag: x.raw } });
  }
  return { status: "ok", next };
}

export async function executeNode(d: ExecDeps, node: Node): Promise<StepOutcome> {
  d.ctx.now = d.now.toISO();   // {{now | date:...}} in templates; refreshed every node so a persisted context never carries a stale clock
  const next = single(d, node.id);
  // only_if: a step that runs some of the time; the chart shows it with the blue mark and this condition
  if (node.only_if && node.type !== "trigger" && !evaluate(node.only_if, d.ctx)) return { status: "skipped", next, result: { kind: "noop", why: `only if ${predicateWords(node.only_if)}; it is not` } };
  switch (node.type) {
    case "trigger": return { status: "ok", next };
    case "exit": return { status: "exit", reason: node.reason };

    case "wait": {
      // Re-evaluated on every wake (stay). A wait anchored on the appointment follows the appointment when it moves:
      // the poll wakes waiting runs on appointment.rescheduled and this recomputes from the new start. A wait anchored on
      // "now" must not slide, so its first answer is pinned in the run's context and reused.
      const key = `__wait.${node.id}.until`;
      const pinned = node.rule.anchor === "now" ? (resolvePath(d.ctx, `vars.${key}`) as string | undefined) : undefined;
      let at: DateTime, usedFallback = false, deferred = false;
      if (pinned) at = DateTime.fromISO(pinned);
      else {
        const r = computeWaitUntil(node.rule, { now: d.now, contactTz: contactTz(d), companyTz: d.company.timezone, ctx: d.ctx });
        const w = deferIntoWindow(r.at, contactTz(d), d.company.send_window_start, d.company.send_window_end);
        at = w.at; usedFallback = r.usedFallback; deferred = w.deferred;
        if (node.rule.anchor === "now") setPath(d.ctx, `vars.${key}`, at.toISO());
      }
      if (at <= d.now) return { status: "ok", next, result: { waited_until: at.toISO() } };
      return { status: "waiting", until: at, stay: true, result: { computed: at.toISO(), used_fallback: usedFallback, deferred_into_window: deferred } };
    }

    case "send_sms": case "send_email": return doSend(d, node);
    case "send_document": {
      const contact = d.ctx.contact as { ghl_contact_id?: string | null; agreement_signed?: boolean } | undefined;
      const templateId = render(node.template, d.ctx, env(d)), sender = node.sender ? render(node.sender, d.ctx, env(d)) || undefined : undefined;
      const name = node.name ? render(node.name, d.ctx, env(d)) : null;
      if (!templateId) return { status: "failed", error: `send_document ${node.id}: template rendered empty (bind crm.agreement_template)` };
      if (shadow(d)) return { status: "ok", next, result: { shadow: true, would_send_document: { template: templateId, sender, to: contact?.ghl_contact_id } } };
      if (!contact?.ghl_contact_id) return { status: "failed", error: "send_document: contact has no CRM id yet" };
      const sent = await d.adapters.write.sendDocumentTemplate(d.adapterCompany, { templateId, contactId: contact.ghl_contact_id, userId: sender });
      const { recordSentByEngine } = await import("./agreements");
      if (sent.id && d.run.contact_id) await recordSentByEngine(d.c, d.company.id, d.run.contact_id, sent.id, name);
      return { status: "ok", next, result: { document: sent.id, template: templateId, sender } };
    }
    case "notify_owner": {
      const owner = (d.ctx.contact as { owner?: { name: string; email: string; ghl_user_id: string; slack_user_id: string | null } } | undefined)?.owner;
      const conn = await one<{ bot_token: Buffer }>(d.c, "select bot_token from slack_connections where company_id=$1", [d.company.id]);
      const { decrypt } = await import("./crypto");
      if (conn) await resolveMentions(d, decrypt(conn.bot_token));
      const text = render(node.template, d.ctx, env(d));
      const contact = d.ctx.contact as { ghl_contact_id?: string | null } | undefined;
      const out: Record<string, unknown> = { owner: owner?.name ?? null };
      if (node.task) {
        const dueAt = d.now.plus(parseDuration(node.task.due)).toJSDate(), title = render(node.task.title, d.ctx, env(d));
        if (shadow(d)) out.would_create_task = { title, due: dueAt.toISOString(), assignedUserId: owner?.ghl_user_id };
        else if (contact?.ghl_contact_id) out.task = (await d.adapters.write.createTask(d.adapterCompany, contact.ghl_contact_id, { title, body: text, dueAt, assignedUserId: owner?.ghl_user_id })).id;
      }
      const fallback = node.fallback_channel ? (/^\{\{/.test(node.fallback_channel) ? (resolvePath(d.ctx, node.fallback_channel.replace(/[{}\s]/g, "")) as string | undefined) : node.fallback_channel) : undefined;
      const slackUser = owner?.slack_user_id ?? null;   // resolveMentions already looked the owner up
      const target = slackUser ?? fallback;
      const body = slackUser ? text : `${owner?.name ? `*${owner.name}* ` : ""}${text}`;
      if (!conn || !target) { await recordSend(d, node, "slack", body, "suppressed", conn ? "unbound: owner not in Slack and no fallback channel" : "unbound: slack"); return { status: "skipped", next, result: { ...out, kind: "blocked", why: conn ? "owner not in Slack, no fallback channel" : "slack not connected", would_post: body.slice(0, 160) } }; }
      const send = await recordSend(d, node, "slack", body, "queued"); if (!send) return { status: "skipped", next, result: { ...out, kind: "noop", why: "already posted (idempotency)" } };
      const r = await slackPostOrFail(d, send.id, () => d.adapters.notifier.post(decrypt(conn.bot_token), target, `${modePrefix(d)}${body}`, persona(d, node.as)));
      if ("refused" in r) return { status: "skipped", next, result: { ...out, kind: "blocked", why: `Slack refused the post: ${r.refused}`, would_post: body.slice(0, 160) } };
      await d.c.query("update sends set status=$2, external_id=$3, sent_at=now() where id=$1", [send.id, shadow(d) ? "shadow" : "sent", r.ts]);
      return { status: "ok", next, result: { ...out, ...(shadow(d) ? { shadow: true } : {}), dm: !!slackUser, ts: r.ts } };
    }

    case "wait_for_reply": {
      // boundary = our last send in this run (so a reply to something earlier doesn't count), else run start
      // boundary = our last contact-facing send in this run (sent, or would-have-sent in shadow); Slack posts don't count
      const lastSend = await one<{ sent_at: Date }>(d.c, "select sent_at from sends where run_id=$1 and channel in ('sms','email') and status in ('sent','shadow') order by sent_at desc limit 1", [d.run.id]);
      const since = lastSend?.sent_at ?? d.run.started_at ?? new Date(0);
      const replies = await many<{ body: string | null; occurred_at: Date; channel: string }>(d.c,
        `select body, occurred_at, channel from messages where company_id=$1 and contact_id=$2 and direction='inbound' and occurred_at > $3 ${node.channel === "any" ? "" : "and channel=$4"} order by occurred_at`,
        node.channel === "any" ? [d.company.id, d.run.contact_id, since] : [d.company.id, d.run.contact_id, since, node.channel]);
      if (replies.length) {
        // D47: people answer in pieces ("yes" … "see you then"). After the newest message, wait `settle` for the rest; a further reply re-wakes and restarts the clock.
        const newest = replies[replies.length - 1]; const settled = DateTime.fromJSDate(newest.occurred_at).plus(parseDuration(node.settle));
        if (d.now < settled) return { status: "waiting", until: settled, stay: true, wakeOnReply: true, result: { settling_until: settled.toISO(), replies: replies.length } };
        setPath(d.ctx, "reply.last_inbound", { body: newest.body, at: newest.occurred_at.toISOString(), channel: newest.channel });
        setPath(d.ctx, "reply.inbound_since_send", replies.map((r) => r.body ?? "").filter(Boolean).join("\n"));
        setPath(d.ctx, "reply.count", replies.length);
        return { status: "ok", next, result: { replied_at: newest.occurred_at.toISOString(), replies: replies.length } };
      }
      const key = `__wait_for_reply.${node.id}.deadline`;
      let deadline = resolvePath(d.ctx, `vars.${key}`) as string | undefined;
      if (!deadline) {
        let at = d.now.plus(parseDuration(node.timeout));
        // D58 (G7): the wait never outlives its `until` rule — the booking text's reply wait ends before the reminders are due
        if (node.until) { const cap = computeWaitUntil(node.until, { now: d.now, contactTz: contactTz(d), companyTz: d.company.timezone, ctx: d.ctx }).at; if (cap < at) at = cap; }
        deadline = at.toISO()!; setPath(d.ctx, `vars.${key}`, deadline);
      }
      if (d.now < DateTime.fromISO(deadline)) return { status: "waiting", until: DateTime.fromISO(deadline), stay: true, wakeOnReply: true, result: { deadline } };
      const timeoutEdge = d.edgesFrom(node.id).find((e) => e.label === "timeout");
      return timeoutEdge ? { status: "ok", next: timeoutEdge.to, result: { timed_out: true } } : { status: "exit", reason: "no_reply", result: { timed_out: true } };
    }

    case "wait_for_reaction": {
      // the message: a post remembered under a tag, or a post this run made (by node id). The door matches taps to it by tag; the step by the message itself (channel + ts).
      const post = node.of.startsWith("tag:")
        ? await one<{ tag: string; channel: string; ts: string }>(d.c, "select tag, channel, ts from slack_posts where company_id=$1 and tag=$2", [d.company.id, render(node.of.slice(4), d.ctx, env(d))])
        : await one<{ tag: string; channel: string; ts: string }>(d.c, "select tag, channel, ts from slack_posts where company_id=$1 and run_id=$2 and ts=$3", [d.company.id, d.run.id, String(resolvePath(d.ctx, `vars.__slack.${node.of}`) ?? "")]);
      if (!post) { setPath(d.ctx, node.into, null); return { status: "skipped", next, result: { kind: "noop", why: "nothing to tap: that post is not in Slack (channel unbound, or the post was skipped)" } }; }
      if (!node.blocking) {
        // D58: arm the listener and go on; the runner watches for the tap at every wake and jumps the run to the "tap" edge, or to "until" when the time comes
        const until = node.until ? computeWaitUntil(node.until, { now: d.now, contactTz: contactTz(d), companyTz: d.company.timezone, ctx: d.ctx }).at.toISO() : null;
        const listener: Listener = { node: node.id, tag: post.tag, channel: post.channel, ts: post.ts, emojis: node.emojis, into: node.into, until, armed_at: d.now.toISO()! };
        setPath(d.ctx, "vars.__listen", listener);
        return { status: "ok", next, result: { listening: post.tag, emojis: node.emojis, until } };
      }
      // the first tap that counts, on that very message; the door already dropped the bot's own reactions and removals
      const tap = await one<{ data: { reaction: string; user: string; user_name: string; ts: string }; occurred_at: Date }>(d.c,
        "select data, occurred_at from events where company_id=$1 and event_type='slack.reaction' and data->>'channel'=$2 and data->>'ts'=$3 and data->>'reaction' = any($4::text[]) order by occurred_at, id limit 1", [d.company.id, post.channel, post.ts, node.emojis]);
      if (tap) { setPath(d.ctx, node.into, { reaction: tap.data.reaction, user: tap.data.user, user_name: tap.data.user_name, ts: tap.data.ts }); return { status: "ok", next, result: { reaction: tap.data.reaction, by: tap.data.user_name, at: tap.occurred_at.toISOString() } }; }
      const key = `__wait_for_reaction.${node.id}.deadline`;
      let deadline = resolvePath(d.ctx, `vars.${key}`) as string | undefined;
      if (!deadline && node.timeout) { deadline = d.now.plus(parseDuration(node.timeout)).toISO()!; setPath(d.ctx, `vars.${key}`, deadline); }
      if (!deadline || d.now < DateTime.fromISO(deadline)) return { status: "waiting", until: deadline ? DateTime.fromISO(deadline) : undefined, stay: true, wakeOnTag: post.tag, result: { tag: post.tag, emojis: node.emojis, deadline: deadline ?? null } };
      setPath(d.ctx, node.into, null);
      return { status: "ok", next, result: { timed_out: true } };
    }

    case "slack_post": {
      const conn = await one<{ bot_token: Buffer; channels: Record<string, string> }>(d.c, "select bot_token, channels from slack_connections where company_id=$1", [d.company.id]);
      // the channel binding is optional (manifest marks slack.* not required), so resolve without throwing: unbound → skip the node, keep the run going
      const { decrypt } = await import("./crypto");
      if (conn) await resolveMentions(d, decrypt(conn.bot_token));   // also fills user.slack_user_id, which a DM step uses as its channel
      const channelOf = (c: string) => { const ref = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/.exec(c); return ref ? (resolvePath(d.ctx, ref[1]) as string | undefined) : c; };
      const channelId = channelOf(node.channel) || (node.fallback_channel ? channelOf(node.fallback_channel) : undefined);
      // render first even when it cannot post: the dashboard shows what WOULD have gone to Slack, which is the whole point of shadow
      const text = render(node.template, d.ctx, env(d));
      if (!conn || !channelId) { await recordSend(d, node, "slack", text, "suppressed", conn ? "unbound: slack channel" : "unbound: slack"); return { status: "skipped", next, result: { kind: "blocked", why: conn ? "slack channel not bound" : "slack not connected", would_post: text.slice(0, 160) } }; }
      // a thread reply needs the parent's ts: an earlier post in this run, or a post another run remembered under a tag ("tag:eod-reminder:<user>:<day>").
      // Without one (parent skipped, nothing under that tag) it posts to the channel and says so.
      let parentTs: string | undefined, parentChannel: string | undefined, tagged: string | undefined;
      if (node.thread_of?.startsWith("tag:")) {
        // an anchor the context cannot name ({{contact.latest_recording_id}} for a contact never recorded) is no post to reply to, not a broken template
        try { tagged = render(node.thread_of.slice(4), d.ctx, env(d)); } catch (e) { if (!(e instanceof UnknownPathError)) throw e; }
        if (tagged) { const p = await one<{ channel: string; ts: string }>(d.c, "select channel, ts from slack_posts where company_id=$1 and tag=$2", [d.company.id, tagged]); parentTs = p?.ts; parentChannel = p?.channel; }
      }
      else if (node.thread_of) parentTs = resolvePath(d.ctx, `vars.__slack.${node.thread_of}`) as string | undefined;
      if (node.thread_only && !parentTs) { await recordSend(d, node, "slack", text, "suppressed", "no post to reply to"); return { status: "skipped", next, result: { kind: "noop", why: "nothing to react to: the post this replies to is not in Slack (booked before the engine, or its channel was unbound)" } }; }
      const send = await recordSend(d, node, "slack", text, "queued"); if (!send) return { status: "skipped", next, result: { kind: "noop", why: "already posted (idempotency)" } };
      // Slack is the team, not the CRM or the contact: in shadow the post still goes out, marked, so the team sees what the engine would do (D31)
      const token = decrypt(conn.bot_token), postTo = parentTs && parentChannel ? parentChannel : channelId;
      const r = await slackPostOrFail(d, send.id, () => d.adapters.notifier.post(token, postTo, !parentTs ? `${modePrefix(d)}${text}` : text, persona(d, node.as), parentTs));
      if ("refused" in r) return { status: "skipped", next, result: { kind: "blocked", why: `Slack refused the post: ${r.refused}`, would_post: text.slice(0, 160) } };
      await d.c.query("update sends set status=$2, external_id=$3, sent_at=now() where id=$1", [send.id, shadow(d) ? "shadow" : "sent", r.ts]);
      setPath(d.ctx, `vars.__slack.${node.id}`, r.ts);
      let reacted = false;
      for (const emoji of (node.react ? (Array.isArray(node.react) ? node.react : [node.react]) : []).map((e) => render(e, d.ctx, env(d))).filter(Boolean)) if (parentTs) reacted = (await d.adapters.notifier.react(token, postTo, parentTs, emoji).catch(() => false)) || reacted;
      // D45: the choices a person can tap, as reactions on this post; the door turns their tap into a slack.reaction event
      const offered: string[] = [];
      for (const emoji of node.offer ?? []) if (await d.adapters.notifier.react(token, postTo, r.ts, emoji).catch(() => false)) offered.push(emoji);
      // another post this one decorates: the bot's own reactions come off it (unreact) and the outcome goes on it (react_on)
      const postOf = async (of: string) => of.startsWith("tag:") ? one<{ channel: string; ts: string }>(d.c, "select channel, ts from slack_posts where company_id=$1 and tag=$2", [d.company.id, render(of.slice(4), d.ctx, env(d))]) : (() => { const ts = resolvePath(d.ctx, `vars.__slack.${of}`) as string | undefined; return ts ? { channel: postTo, ts } : null; })();
      let unreacted = 0, reactedOn = 0;
      if (node.unreact) { const target = await postOf(node.unreact.of); if (target) for (const emoji of node.unreact.emojis) if (await d.adapters.notifier.unreact(token, target.channel, target.ts, emoji).catch(() => false)) unreacted++; }
      if (node.react_on) { const target = await postOf(node.react_on.of); if (target) for (const emoji of node.react_on.emojis) if (await d.adapters.notifier.react(token, target.channel, target.ts, emoji).catch(() => false)) reactedOn++; }
      let tag: string | undefined;
      if (node.tag) { tag = render(node.tag, d.ctx, env(d)); await d.c.query("insert into slack_posts (company_id, tag, channel, ts, run_id) values ($1,$2,$3,$4,$5) on conflict (company_id, tag) do update set channel=excluded.channel, ts=excluded.ts, run_id=excluded.run_id, posted_at=now()", [d.company.id, tag, postTo, r.ts, d.run.id]); }
      return { status: "ok", next, result: { ...(shadow(d) ? { shadow: true } : {}), ts: r.ts, ...(node.thread_of ? { in_thread_of: parentTs ?? null, ...(tagged ? { tag: tagged } : {}) } : {}), ...(tag ? { remembered_as: tag } : {}), ...(node.react ? { reacted } : {}), ...(node.offer ? { offered } : {}), ...(node.unreact ? { unreacted } : {}), ...(node.react_on ? { reacted_on: reactedOn } : {}) } };
    }

    case "classify": {
      const input = render(node.input, d.ctx, env(d)); const state = node.state ? render(node.state, d.ctx, env(d)) : undefined;
      const options = (await many<{ value: string }>(d.c, "select value from core_categories where domain=$1 order by sort", [node.domain])).map((r) => r.value);
      const r = await d.adapters.classifier.choice(state, input, options, node.threshold, { apiKey: d.bindings["secret.jev_key"] || process.env.JEV_API_KEY, criteria: node.criteria, ambiguityMax: node.ambiguity_max, question: node.question });
      const top = Object.entries(r.distribution).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, p]) => `${k} ${(p * 100).toFixed(0)}%`).join(", ");
      setPath(d.ctx, node.into, r.value); setPath(d.ctx, "reply.confidence", r.confidence); setPath(d.ctx, "reply.intent_confidence", Math.round(r.confidence * 100)); setPath(d.ctx, "reply.top_guesses", top || "none");
      const recId = (d.ctx.recording as { id?: string } | undefined)?.id; const intoKey = node.into.replace(/^vars\./, "").split(".");
      if (recId && node.input.includes("recording.")) { const nested = intoKey.reduceRight<unknown>((acc, k) => ({ [k]: acc }), { value: r.value, confidence: r.confidence, ambiguity: r.ambiguity ?? null }); await d.c.query("update recordings set analysis = analysis || $2::jsonb where id=$1", [recId, JSON.stringify(nested)]); }
      await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: "reply.classified", source: "engine", data: { intent: r.value, confidence: r.confidence, unclear: r.unclear, input } });
      return { status: "ok", next, result: { value: r.value, confidence: r.confidence, ...(r.ambiguity !== undefined ? { ambiguity: r.ambiguity } : {}), ...(r.unclear ? { why: r.confidence < node.threshold ? "not confident enough" : "a careful person would doubt it" } : {}) } };
    }

    case "branch": {
      const edges = d.edgesFrom(node.id);
      for (const e of edges) if (e.when && evaluate(e.when, d.ctx)) return { status: "ok", next: e.to, result: { edge: e.to } };
      const els = edges.find((e) => e.else); if (els) return { status: "ok", next: els.to, result: { edge: els.to, else: true } };
      return { status: "failed", error: `branch ${node.id}: no edge matched and no else` };
    }
    case "check": {
      if (evaluate(node.when, d.ctx)) return { status: "ok", next };
      // a check that waits for its condition (D39): park on this node and look again, up to the deadline; then the gate closes as before
      if (node.retry) {
        const key = `__check.${node.id}.deadline`;
        let deadline = resolvePath(d.ctx, `vars.${key}`) as string | undefined;
        if (!deadline) { deadline = d.now.plus(parseDuration(node.retry.for)).toISO()!; setPath(d.ctx, `vars.${key}`, deadline); }
        if (d.now < DateTime.fromISO(deadline)) return { status: "waiting", until: d.now.plus(parseDuration(node.retry.every)), stay: true, result: { deadline, why: `not yet: ${predicateWords(node.when)}; looking again every ${durationWords(node.retry.every)} until ${deadline}` } };
      }
      return { status: "exit", reason: node.else_exit, gate: true };
    }

    case "tags": return applyTags(d, node.type, next, { add: node.add, remove: node.remove });
    case "set_tag": return applyTags(d, node.type, next, { add: node.tag });
    case "remove_tag": return applyTags(d, node.type, next, { remove: node.tag });
    case "note": {
      const ghlId = (d.ctx.contact as { ghl_contact_id?: string }).ghl_contact_id!;
      const noteText = render(node.template, d.ctx, env(d));
      if (shadow(d)) return { status: "ok", next, result: { shadow: true, would_note: noteText.slice(0, 160) } };
      await d.adapters.write.addNote(d.adapterCompany, ghlId, noteText);
      return { status: "ok", next };
    }
    case "update_appointment": {
      if (!d.run.appointment_id) return { status: "failed", error: "update_appointment with no appointment on run" };
      const a = await one<{ external_id: string; source: string }>(d.c, "select external_id, source from appointments where id=$1", [d.run.appointment_id]);
      const patch = Object.fromEntries(Object.entries(node.set).filter(([k]) => k !== "pending_read").map(([k, v]) => [k, typeof v === "string" ? render(v, d.ctx, env(d)) : v]));
      // pending_read is OUR column (D58), never the CRM's: written whatever the source and the mode, like `record`
      let pending: unknown;
      if ("pending_read" in node.set) {
        pending = node.set.pending_read === null ? null : deepRender(node.set.pending_read, d.ctx, env(d));
        await d.c.query("update appointments set pending_read=$2 where id=$1", [d.run.appointment_id, pending === null ? null : JSON.stringify(pending)]);
        if (d.ctx.appointment) (d.ctx.appointment as Record<string, unknown>).pending_read = pending;
        if (!Object.keys(patch).length) return { status: "ok", next, result: { pending_read: pending } };
      }
      // only the CRM's own calendars accept writes; a Calendly booking is read-only to us, so the node records that and moves on
      if (a!.source !== "ghl") return { status: "ok", next, result: { skipped: true, reason: `appointments from ${a!.source} are read-only`, would_update: patch } };
      if (shadow(d)) return { status: "ok", next, result: { shadow: true, would_update: patch } };
      await d.adapters.write.updateAppointment(d.adapterCompany, a!.external_id, patch);
      if (typeof patch.status === "string") await d.c.query("update appointments set status=$2, source_updated_at=now() where id=$1", [d.run.appointment_id, patch.status]);
      return { status: "ok", next, result: patch };
    }
    case "pipeline_card": {
      const contact = d.ctx.contact as { ghl_contact_id?: string | null } | undefined;
      const pipelineId = render(node.pipeline, d.ctx, env(d));
      if (!d.run.contact_id) return { status: "failed", error: `pipeline_card ${node.id}: the run is not about a contact` };
      // D41: read the CRM first. A card made by anything else (a CRM workflow, a person) is adopted and moved, never duplicated; a CRM that cannot be read fails the step rather than guessing.
      try { await syncCards(d.c, d.company, d.adapterCompany, d.adapters, d.run.contact_id, contact?.ghl_contact_id); }
      catch (e) { return { status: "failed", error: `pipeline_card ${node.id}: could not read the contact's cards in the CRM: ${(e as Error).message}` }; }
      const card = await pickCard(d.c, d.company.id, d.run.contact_id, pipelineId);
      // stage and name are optional on an update: a step that only stamps fields leaves the card where it is
      const stageId = node.stage ? render(node.stage, d.ctx, env(d)) : card?.ghl_stage_id ?? "";
      const name = node.name ? render(node.name, d.ctx, env(d)) : card?.name ?? render("{{contact.name}}", d.ctx, env(d));   // a card made without a name carries the person's
      const customFields = node.fields.map((f) => ({ id: render(f.id, d.ctx, env(d)), field_value: render(f.value, d.ctx, env(d)) })).filter((f) => f.id && f.field_value !== "");
      const assignedUserId = node.assign_to ? render(node.assign_to, d.ctx, env(d)) || undefined : undefined;
      // no open card: a step with a stage makes one there (D41: a contact always has their cards); a status-only step has no stage to make one in, so there is nothing to mark
      if (!card && node.if_missing === "skip") return { status: "skipped", next, result: { kind: "noop", why: "no open card on this board to move; this step never creates one" } };
      if (!card && !node.stage) return { status: "skipped", next, result: { kind: "noop", why: `no open card on this board to mark ${node.status ?? "updated"}` } };
      if (!pipelineId || !stageId || !name) return { status: "failed", error: `pipeline_card ${node.id}: pipeline, stage or name unresolved` };
      const write = { pipelineId, stageId, name, status: node.status ?? ("open" as const), assignedUserId, customFields };
      // the pursuit the card belongs to: the run's, else the contact's open one, else a new one
      let oppId = d.run.opportunity_id ?? card?.opportunity_id ?? (await one<{ id: string }>(d.c, "select id from opportunities where company_id=$1 and contact_id=$2 and status='open' order by opened_at desc limit 1", [d.company.id, d.run.contact_id]))?.id;
      if (!oppId) {
        oppId = (await one<{ id: string }>(d.c, "insert into opportunities (company_id, contact_id, opened_by) values ($1,$2,$3) returning id", [d.company.id, d.run.contact_id, `workflow:${node.id}`]))!.id;
        await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: oppId, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: "opportunity.opened", source: "engine", data: { by: "workflow", node: node.id, shadow: shadow(d) } });
      }
      const ownerRow = assignedUserId ? await one<{ id: string }>(d.c, "select id from users where company_id=$1 and ghl_user_id=$2", [d.company.id, assignedUserId]) : undefined;
      if (card) {
        if (!shadow(d) && card.ghl_opportunity_id) await d.adapters.write.updateOpportunity(d.adapterCompany, card.ghl_opportunity_id, write);
        await d.c.query("update pipeline_cards set name=$2, ghl_stage_id=$3, assigned_user_id=coalesce($4, assigned_user_id), status=coalesce($5, status), updated_at=now() where id=$1", [card.id, name, stageId, ownerRow?.id ?? null, node.status ?? null]);
      } else {
        let ghlId: string | null = null;
        if (!shadow(d)) {
          if (!contact?.ghl_contact_id) return { status: "failed", error: "pipeline_card: contact has no CRM id yet" };
          ghlId = (await d.adapters.write.createOpportunity(d.adapterCompany, { ...write, contactId: contact.ghl_contact_id })).id;
        }
        await d.c.query("insert into pipeline_cards (company_id, opportunity_id, contact_id, ghl_opportunity_id, ghl_pipeline_id, ghl_stage_id, name, assigned_user_id, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [d.company.id, oppId, d.run.contact_id, ghlId, pipelineId, stageId, name, ownerRow?.id ?? null, node.status ?? "open"]);
      }
      if (!d.run.opportunity_id) { d.run.opportunity_id = oppId; await d.c.query("update runs set opportunity_id=$2 where id=$1", [d.run.id, oppId]); }
      d.ctx.opportunity = await one(d.c, "select id, status, contract_value, opened_at from opportunities where id=$1", [oppId]);
      return { status: "ok", next, result: { ...(shadow(d) ? { shadow: true } : {}), card: card ? "moved" : "created", ...(card ? { from_stage: card.ghl_stage_id, crm_card: card.ghl_opportunity_id } : {}), name, stage: stageId, ...(node.status ? { card_status: node.status } : {}), fields: customFields } };
    }
    case "crm_record": {
      const objectKey = render(node.object, d.ctx, env(d)), key = render(node.key, d.ctx, env(d));
      if (!objectKey || !key) return { status: "failed", error: `crm_record ${node.id}: object or key rendered empty` };
      const properties: Record<string, unknown> = {};
      // a rendered `["yes"]` is a checkbox / multi-option value (the CRM wants an array); numbers go as numbers on amount-like keys
      for (const [k, v] of Object.entries(node.properties)) { const r = render(v, d.ctx, env(d)); if (r === "") continue; properties[k] = /^\[.*\]$/s.test(r) ? jsonArrayOr(r) : /^-?\d+(\.\d+)?$/.test(r) && /amount|total|count|score|duration|min$/i.test(k) ? Number(r) : r; }
      const owner = node.owner ? render(node.owner, d.ctx, env(d)) || undefined : undefined;
      const existing = await one<{ id: string; ghl_record_id: string | null }>(d.c, "select id, ghl_record_id from crm_records where company_id=$1 and object_key=$2 and record_key=$3", [d.company.id, objectKey, key]);
      let ghlId = existing?.ghl_record_id ?? null;
      if (!shadow(d)) {
        if (ghlId) await d.adapters.write.updateRecord(d.adapterCompany, objectKey, ghlId, properties, owner);
        else ghlId = (await d.adapters.write.createRecord(d.adapterCompany, objectKey, properties, owner)).id;
      }
      const row = await one<{ id: string }>(d.c, `insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, properties) values ($1,$2,$3,$4,$5,$6)
        on conflict (company_id, object_key, record_key) do update set ghl_record_id=coalesce(excluded.ghl_record_id, crm_records.ghl_record_id), properties=crm_records.properties || excluded.properties, updated_at=now() returning id`,
        [d.company.id, objectKey, key, ghlId, d.run.contact_id, properties]);
      d.ctx.record = { id: ghlId ?? "", key, object: objectKey, properties };
      const related: string[] = [];
      for (const r of node.relate) {
        const assoc = render(r.association, d.ctx, env(d)), first = render(r.first, d.ctx, env(d)), second = render(r.second, d.ctx, env(d));
        if (!assoc || !first || !second) continue;
        if (!shadow(d)) await d.adapters.write.relateRecords(d.adapterCompany, assoc, first, second);
        related.push(`${first}→${second}`);
      }
      return { status: "ok", next, result: { ...(shadow(d) ? { shadow: true } : {}), record: existing ? "updated" : "created", our_id: row!.id, crm_id: ghlId, properties, related } };
    }
    case "update_contact": {
      const contact = d.ctx.contact as { ghl_contact_id?: string | null } | undefined;
      const r = (t?: string) => (t ? render(t, d.ctx, env(d)) || undefined : undefined);
      // `clear` is the one place an empty value is written on purpose (the CRM may accept and ignore it for some field types; the Zap it replaces warned about that too)
      const cleared = node.clear.map((id) => render(id, d.ctx, env(d))).filter(Boolean).map((id) => ({ id, field_value: "" }));
      const patch = { firstName: r(node.set.first_name), lastName: r(node.set.last_name), phone: r(node.set.phone), timezone: r(node.set.timezone), assignedUserId: r(node.set.assign_to),
        customFields: [...node.fields.map((f) => ({ id: render(f.id, d.ctx, env(d)), field_value: render(f.value, d.ctx, env(d)) })).filter((f) => f.id && f.field_value !== ""), ...cleared] };
      const nothing = !patch.firstName && !patch.lastName && !patch.phone && !patch.timezone && !patch.assignedUserId && !patch.customFields.length;
      if (nothing) return { status: "skipped", next, result: { kind: "noop", why: "nothing to write: every value rendered empty" } };
      if (shadow(d)) return { status: "ok", next, result: { shadow: true, would_update: patch } };
      if (!contact?.ghl_contact_id) return { status: "failed", error: "update_contact: contact has no CRM id yet" };
      await d.adapters.write.updateContact(d.adapterCompany, contact.ghl_contact_id, patch);
      // our replica of the CRM contact learns what we just wrote, so a later step in the same minute reads it (the next poll confirms it)
      const fieldPatch = Object.fromEntries(patch.customFields.map((f) => [f.id, f.field_value === "" ? null : f.field_value]));
      await d.c.query("update contacts set first_name=coalesce($2,first_name), last_name=coalesce($3,last_name), timezone=coalesce($4,timezone), ghl_fields = ghl_fields || $5::jsonb, updated_at=now() where id=$1", [d.run.contact_id, patch.firstName ?? null, patch.lastName ?? null, patch.timezone ?? null, JSON.stringify(fieldPatch)]);
      return { status: "ok", next, result: patch as Record<string, unknown> };
    }
    case "create_task": {
      const contact = d.ctx.contact as { ghl_contact_id?: string | null } | undefined;
      const title = render(node.title, d.ctx, env(d)), body = node.body ? render(node.body, d.ctx, env(d)) : undefined;
      const dueAt = d.now.plus(parseDuration(node.due)).toJSDate();
      const assignedUserId = node.assign_to ? render(node.assign_to, d.ctx, env(d)) || undefined : undefined;
      if (shadow(d)) return { status: "ok", next, result: { shadow: true, would_create_task: { title, body, due: dueAt.toISOString(), assignedUserId } } };
      if (!contact?.ghl_contact_id) return { status: "failed", error: "create_task: contact has no CRM id yet" };
      const t = await d.adapters.write.createTask(d.adapterCompany, contact.ghl_contact_id, { title, body, dueAt, assignedUserId });
      return { status: "ok", next, result: { task_id: t.id, title, due: dueAt.toISOString(), assignedUserId } };
    }
    case "update_opportunity": {
      if (!d.run.opportunity_id) return { status: "failed", error: "update_opportunity with no opportunity on run" };
      const allowed = new Set(["status", "contract_value", "installments"]);
      for (const [k, v] of Object.entries(node.set)) if (allowed.has(k)) await d.c.query(`update opportunities set ${k}=$2 where id=$1`, [d.run.opportunity_id, v]);
      return { status: "ok", next };
    }
    case "analyze": {
      // not a CRM write, so it runs in shadow too: seeing what the AI would say about a call is the point of shadow
      const apiKey = d.bindings["secret.anthropic_key"] || process.env.ANTHROPIC_API_KEY;
      const soft = (error: string): StepOutcome => node.optional ? { status: "skipped", next, result: { kind: "blocked", why: error } } : { status: "failed", error };
      if (!apiKey) return soft("analyze: no Anthropic key — bind secret.anthropic_key for this company");
      const system = render(node.prompt, d.ctx, env(d)).trim();
      if (!system) return soft(`analyze ${node.id}: prompt rendered empty (is the prompt.* binding set?)`);
      const input = render(node.input, d.ctx, env(d)).trim();
      if (!input) return { status: "skipped", next, result: { kind: "noop", why: "nothing to analyze: input rendered empty (no transcript?)" } };
      let r: Awaited<ReturnType<typeof d.adapters.analyst.analyze>>;
      try { r = await d.adapters.analyst.analyze(apiKey, { system, input, format: node.format, maxTokens: node.max_tokens }); }
      catch (e) { if (node.optional) return soft(`analyze: ${(e as Error).message}`); throw e; }
      if (r.refused) return { status: "failed", error: `analyze ${node.id}: the model declined (${r.refused})` };
      const value = node.format === "json" ? (r.parsed ?? { raw: r.text, parse_error: r.parseError }) : r.text;
      // one read, several vars: `into: ["notes", "rubric"]` takes those keys off the object the prompt returned
      const stored: Record<string, unknown> = Array.isArray(node.into) ? Object.fromEntries(node.into.map((k) => [k, value && typeof value === "object" ? (value as Record<string, unknown>)[k] ?? {} : value])) : { [node.into]: value };
      for (const [k, v] of Object.entries(stored)) setPath(d.ctx, `vars.${k}`, v);
      const recId = (d.ctx.recording as { id?: string } | undefined)?.id;
      if (recId) await d.c.query("update recordings set analysis = analysis || $2::jsonb where id=$1", [recId, JSON.stringify(stored)]);
      await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: "call.analyzed", source: "engine", data: { node: node.id, into: node.into, model: r.model, tokens: r.usage, parsed: node.format !== "json" || !!r.parsed, repaired: r.repaired ?? false, recording_id: recId } });
      return node.format === "json" && !r.parsed
        ? { status: "ok", next, result: { into: node.into, parsed: false, parse_error: r.parseError, model: r.model, tokens: r.usage } }
        : { status: "ok", next, result: { into: node.into, parsed: true, repaired: r.repaired ?? false, model: r.model, tokens: r.usage, preview: typeof value === "string" ? value.slice(0, 160) : JSON.stringify(value).slice(0, 160) } };
    }
    case "record_outcome": {
      if (!d.run.appointment_id) return { status: "failed", error: "record_outcome with no appointment on run" };
      const category = render(node.outcome, d.ctx, env(d));
      const termId = await outcomeTermFor(d.c, d.company.id, category);
      if (!termId) return { status: "failed", error: `record_outcome: no appointment_outcome term for "${category}"` };
      const callTerm = node.call_outcome ? await one<{ id: string }>(d.c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category=$2 and active limit 1", [d.company.id, render(node.call_outcome, d.ctx, env(d))]) : null;
      const notes = node.notes ? render(node.notes, d.ctx, env(d)) : undefined;
      // ours, never the CRM: a show is a fact about our appointment row, so shadow mode records it too
      const r = await applyOutcome(d.c, { companyId: d.company.id, appointmentId: d.run.appointment_id, outcomeTermId: termId, callOutcomeTermId: callTerm?.id ?? null, notes, source: "engine", runId: d.run.id, by: `workflow:${node.id}` });
      if (d.ctx.appointment) (d.ctx.appointment as Record<string, unknown>).outcome = r.outcome;
      return { status: "ok", next, result: { outcome: r.outcome, events: r.events, runs_started: r.runs } };
    }
    case "webhook": {
      // {{secret.<key>}} resolves here and nowhere else; the ledger keeps the rendered body, never the headers
      const secret = Object.fromEntries(Object.entries(d.bindings).filter(([k]) => k.startsWith("secret.")).map(([k, v]) => [k.slice(7), v]));
      const sctx = { ...d.ctx, secret };
      const url = render(node.url, sctx, env(d));
      const headers: Record<string, string> = Object.fromEntries(Object.entries(node.headers).map(([k, v]) => [k, render(v, sctx, env(d))]));
      const bodyText = node.body === undefined ? undefined : typeof node.body === "string" ? render(node.body, sctx, env(d)) : JSON.stringify(deepRender(node.body, sctx, env(d)));
      if (bodyText !== undefined && typeof node.body !== "string" && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
      const safeUrl = url.replace(/([?&](?:key|token|api_key|apikey|secret)=)[^&]+/gi, "$1…");
      if (shadow(d)) { await recordSend(d, node, "webhook", bodyText ?? "", "suppressed", "shadow"); return { status: "ok", next, result: { shadow: true, would_call: `${node.method} ${safeUrl}`, would_send: bodyText?.slice(0, 300) } }; }
      const send = await recordSend(d, node, "webhook", bodyText ?? "", "queued"); if (!send) return { status: "skipped", next, result: { kind: "noop", why: "already called (idempotency)" } };
      try {
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20_000);
        const res = await fetch(url, { method: node.method, headers, body: node.method === "GET" ? undefined : bodyText, signal: ctl.signal }).finally(() => clearTimeout(timer));
        const text = await res.text().catch(() => "");
        let parsed: unknown = text; try { parsed = JSON.parse(text); } catch { /* not JSON: keep the text */ }
        await d.c.query("update sends set status=$2, external_id=$3, sent_at=now(), error=$4 where id=$1", [send.id, res.ok ? "sent" : "failed", String(res.status), res.ok ? null : text.slice(0, 500)]);
        if (node.into) setPath(d.ctx, `vars.${node.into}`, parsed);
        if (!res.ok) { if (node.on_error === "skip") return { status: "skipped", next, result: { kind: "blocked", why: `${res.status} from ${safeUrl}`, response: text.slice(0, 300) } }; return { status: "failed", error: `${node.method} ${safeUrl} → ${res.status}: ${text.slice(0, 300)}` }; }
        return { status: "ok", next, result: { called: `${node.method} ${safeUrl}`, status: res.status, response: text.slice(0, 300) } };
      } catch (e) {
        const why = String((e as Error).name === "AbortError" ? "timed out after 20s" : (e as Error).message);
        await d.c.query("update sends set status='failed', error=$2 where id=$1", [send.id, why]);
        if (node.on_error === "skip") return { status: "skipped", next, result: { kind: "blocked", why: `${safeUrl}: ${why}` } };
        return { status: "failed", error: `${node.method} ${safeUrl}: ${why}` };
      }
    }
    case "health_check": {
      const channel = node.channel ? (/^\{\{/.test(node.channel) ? (resolvePath(d.ctx, node.channel.replace(/^\{\{\s*|\s*\}\}$/g, "")) as string | undefined) : node.channel) : undefined;
      const as = persona(d, node.as);
      const r = await runHealthStep(d.c, d.company, d.adapters, d.probes ?? liveProbes, { checks: node.checks, min_slots: 0, slots_days: 7, channel: channel ?? null, as_name: node.as?.name ? as.name : null, as_icon: node.as?.icon ? (Array.isArray(as.icon) ? as.icon[0] : as.icon) : null }, d.now as DateTime<true>);
      const failing = r.findings.filter((f) => !f.ok);
      return { status: "ok", next, result: { checks: r.findings.length, failing: failing.length, raised: r.raised, resolved: r.resolved, ...(failing.length ? { problems: failing.map((f) => f.text).slice(0, 10) } : {}) } };
    }
    case "availability_check": {
      const cal = d.run.appointment_id ? await one<{ external_id: string }>(d.c, "select cal.external_id from appointments a join calendars cal on cal.id=a.calendar_id where a.id=$1", [d.run.appointment_id]) : null;
      const r = await runAvailabilityStep(d.c, d.company, d.adapters, d.probes ?? liveProbes, { min_slots: node.min_slots, days: node.days }, d.now as DateTime<true>, cal ? [cal.external_id] : undefined);
      const low = r.findings.filter((f) => !f.ok);
      return { status: "ok", next, result: { calendars: r.findings.length, low: low.length, raised: r.raised, resolved: r.resolved, ...(cal ? { only: cal.external_id } : {}), ...(low.length ? { problems: low.map((f) => f.text) } : {}) } };
    }
    case "report": {
      const kind = render(node.kind, d.ctx, env(d)) as ReportKind;
      if (!REPORT_KINDS.includes(kind)) return { status: "failed", error: `report kind must be one of ${REPORT_KINDS.join(", ")}, got "${kind}"` };
      const manual = (d.ctx.event as { manual?: boolean } | undefined)?.manual === true;
      const period = periodFor(kind, d.now.setZone(d.company.timezone), manual);
      const b = await buildReport(d.c, d.company, kind, period, { breakdowns: node.breakdowns, sections: node.sections, onDemand: manual, toDate: manual });
      setPath(d.ctx, `vars.${node.into}`, { body: b.body, period: b.period, numbers: b.numbers, id: b.id });
      return { status: "ok", next, result: { kind, period: b.period, report_id: b.id, ...(manual ? { to_date: true } : {}) } };
    }
    case "set_var": {
      // a value chosen by a condition or picked by a fact: plumbing, not a fork on the chart
      const chosen = (raw: unknown) => (typeof raw === "string" ? render(raw, d.ctx, env(d)) : raw);
      let v: unknown;
      if (node.pick) { const key = String(chosen(node.value) ?? ""); v = chosen(key in node.pick ? node.pick[key] : node.else_value); }
      else v = chosen(node.when && !evaluate(node.when, d.ctx) ? node.else_value : node.value);
      setPath(d.ctx, `vars.${node.key}`, v); return { status: "ok", next };
    }
    case "record": {
      // bookkeeping never fails a run: a field whose path is not in this run's context lands as null
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.data)) { try { data[k] = deepRender(v, d.ctx, env(d)); } catch (e) { if (e instanceof UnknownPathError) data[k] = null; else throw e; } }
      await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: node.event, source: "engine", data });
      return { status: "ok", next, result: { event: node.event, ...data } };
    }
    case "resume": return d.run.resume_node ? { status: "resume", result: { to: d.run.resume_node, due: d.run.resume_at?.toISOString() ?? null } } : { status: "ok", next, result: { kind: "noop", why: "nothing to go back to: no listener pulled this run away" } };
    case "pause_runs": {
      await d.c.query("update runs set status='paused', exit_reason='paused: human took over' where company_id=$1 and contact_id=$2 and id<>$3 and status in ('active','waiting')", [d.company.id, d.run.contact_id, d.run.id]);
      return { status: "ok", next };
    }
    case "start_workflow": {
      const { startRun } = await import("./dispatch");
      const wf = await one<{ id: string }>(d.c, "select id from workflows where company_id=$1 and name=$2", [d.company.id, node.workflow]);
      if (!wf) return { status: "failed", error: `start_workflow: no workflow named ${node.workflow}` };
      const ev = await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: "run.exited", source: "engine", data: { handed_to: node.workflow, with: node.with ?? {} } });
      const trig = await one<{ node_id: string }>(d.c, "select node_id from workflow_triggers where workflow_id=$1 limit 1", [wf.id]);
      const started = await startRun(d.c, { companyId: d.company.id, workflowId: wf.id, triggerNodeId: trig?.node_id ?? "t1", event: ev, contactId: d.run.contact_id, appointmentId: d.run.appointment_id, opportunityId: d.run.opportunity_id });
      // honest exit reason: a disabled target or a re-entry block is not a successful handoff
      return started ? { status: "exit", reason: `started:${node.workflow}`, result: { run_id: started } } : { status: "exit", reason: `handoff_suppressed:${node.workflow}`, result: { why: "target disabled or re-entry blocked" } };
    }
  }
}

export /** Every string inside a JSON body is a template; the shape stays. */
function deepRender(v: unknown, ctx: Record<string, unknown>, e: ReturnType<typeof env>): unknown {
  if (typeof v === "string") { const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(v); if (whole) { const got = resolveExpr(whole[1], ctx, e); return got === undefined ? "" : got; } return render(v, ctx, e); }   // one whole expression keeps its type: a boolean stays a boolean, a filtered number a number
  if (Array.isArray(v)) return v.map((x) => deepRender(x, ctx, e));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, deepRender(x, ctx, e)]));
  return v;
}
export function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split("."); let cur = obj;
  for (const p of parts.slice(0, -1)) { if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {}; cur = cur[p] as Record<string, unknown>; }
  cur[parts[parts.length - 1]] = value;
}
