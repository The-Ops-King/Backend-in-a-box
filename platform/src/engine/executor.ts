import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import type { Edge, Node } from "./definition";
import { evaluate } from "./predicate";
import { render, resolvePath, parseDuration, StaleTemplateError, UnknownPathError } from "./template";
import { computeWaitUntil, deferIntoWindow } from "./waitrule";
import type { CompanyRow, RunRow } from "./context";
import { emitEvent } from "./dispatch";

export type StepOutcome =
  | { status: "ok"; next: string | null; result?: Record<string, unknown> }
  | { status: "skipped" | "stale"; next: string | null; result?: Record<string, unknown> }
  | { status: "waiting"; until: DateTime; stay?: boolean; result?: Record<string, unknown> }   // stay: re-execute this same node on wake
  | { status: "exit"; reason: string; result?: Record<string, unknown> }
  | { status: "paused"; reason: string; result?: Record<string, unknown> }
  | { status: "failed"; error: string };

export type ExecDeps = { c: PoolClient; adapters: Adapters; company: CompanyRow; adapterCompany: Company; bindings: Record<string, string>; run: RunRow; ctx: Record<string, unknown>; edgesFrom: (id: string) => Edge[]; now: DateTime };

const contactTz = (d: ExecDeps) => ((d.ctx.contact as { timezone?: string } | undefined)?.timezone) ?? d.company.timezone;
const single = (d: ExecDeps, id: string): string | null => (d.edgesFrom(id).find((e) => e.label !== "timeout") ?? d.edgesFrom(id)[0])?.to ?? null;
const env = (d: ExecDeps) => ({ now: d.now, tz: contactTz(d) });

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

async function recordSend(d: ExecDeps, node: Node, channel: "sms" | "email" | "slack", body: string, status: "queued" | "suppressed", reason?: string): Promise<{ id: string } | null> {
  const key = `${d.run.id}:${node.id}`;
  const row = await one<{ id: string }>(d.c, `insert into sends (company_id, run_id, contact_id, channel, idempotency_key, rendered_body, status, suppressed_reason, scheduled_for)
    values ($1,$2,$3,$4,$5,$6,$7,$8,now()) on conflict (idempotency_key) do nothing returning id`,
    [d.company.id, d.run.id, d.run.contact_id, channel, key, body, status, reason ?? null]);
  return row ?? null;
}

async function doSend(d: ExecDeps, node: Extract<Node, { type: "send_sms" | "send_email" }>): Promise<StepOutcome> {
  const next = single(d, node.id);
  const v = validityOk(d, node);
  let template = node.template, substituted = false;
  if (!v.ok) {
    if (node.on_stale === "skip") { await recordSend(d, node, node.type === "send_sms" ? "sms" : "email", "", "suppressed", `stale: ${v.why}`); return { status: "stale", next, result: { why: v.why } }; }
    if (node.on_stale === "escalate") { await recordSend(d, node, node.type === "send_sms" ? "sms" : "email", "", "suppressed", `stale-escalated: ${v.why}`); return { status: "paused", reason: `stale: ${v.why}` }; }
    if (!node.substitute_template) return { status: "failed", error: "on_stale=substitute but no substitute_template" };
    template = node.substitute_template; substituted = true;
  }
  let body: string;
  try { body = render(template, d.ctx, env(d)); }
  catch (e) {
    if (e instanceof StaleTemplateError) { await recordSend(d, node, node.type === "send_sms" ? "sms" : "email", "", "suppressed", `stale-render: ${e.message}`); return node.on_stale === "escalate" ? { status: "paused", reason: e.message } : { status: "stale", next, result: { why: e.message } }; }
    if (e instanceof UnknownPathError) return { status: "failed", error: e.message };
    throw e;
  }
  const channel = node.type === "send_sms" ? "sms" : "email";
  const send = await recordSend(d, node, channel, body, "queued");
  if (!send) return { status: "skipped", next, result: { why: "already sent (idempotency)" } };
  const ghlContactId = (d.ctx.contact as { ghl_contact_id?: string }).ghl_contact_id!;
  const r = node.type === "send_sms"
    ? await d.adapters.sender.sendSms(d.adapterCompany, ghlContactId, body)
    : await d.adapters.sender.sendEmail(d.adapterCompany, ghlContactId, render(node.subject, d.ctx, env(d)), body);
  await d.c.query("update sends set status=$2, external_id=$3, error=$4, sent_at=case when $2='sent' then now() end where id=$1", [send.id, r.accepted ? "sent" : "failed", r.externalId || null, r.error ?? null]);
  await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: r.accepted ? "message.sent" : "send.suppressed", source: "engine", data: { channel, node: node.id, external_id: r.externalId, error: r.error, substituted } });
  return r.accepted ? { status: "ok", next, result: { external_id: r.externalId, substituted } } : { status: "failed", error: r.error ?? "send rejected" };
}

export async function executeNode(d: ExecDeps, node: Node): Promise<StepOutcome> {
  const next = single(d, node.id);
  switch (node.type) {
    case "trigger": return { status: "ok", next };
    case "exit": return { status: "exit", reason: node.reason };

    case "wait": {
      const { at, usedFallback } = computeWaitUntil(node.rule, { now: d.now, contactTz: contactTz(d), companyTz: d.company.timezone, ctx: d.ctx });
      const w = deferIntoWindow(at, contactTz(d), d.company.send_window_start, d.company.send_window_end);
      return { status: "waiting", until: w.at, result: { computed: at.toISO(), used_fallback: usedFallback, deferred_into_window: w.deferred } };
    }

    case "send_sms": case "send_email": return doSend(d, node);

    case "wait_for_reply": {
      // boundary = our last send in this run (so a reply to something earlier doesn't count), else run start
      const lastSend = await one<{ sent_at: Date }>(d.c, "select sent_at from sends where run_id=$1 and status='sent' order by sent_at desc limit 1", [d.run.id]);
      const since = lastSend?.sent_at ?? d.run.started_at ?? new Date(0);
      const reply = await one<{ body: string | null; occurred_at: Date; channel: string }>(d.c,
        `select body, occurred_at, channel from messages where company_id=$1 and contact_id=$2 and direction='inbound' and occurred_at > $3 ${node.channel === "any" ? "" : "and channel=$4"} order by occurred_at desc limit 1`,
        node.channel === "any" ? [d.company.id, d.run.contact_id, since] : [d.company.id, d.run.contact_id, since, node.channel]);
      if (reply) {
        setPath(d.ctx, "reply.last_inbound", { body: reply.body, at: reply.occurred_at.toISOString(), channel: reply.channel });
        return { status: "ok", next, result: { replied_at: reply.occurred_at.toISOString() } };
      }
      const key = `__wait_for_reply.${node.id}.deadline`;
      let deadline = resolvePath(d.ctx, `vars.${key}`) as string | undefined;
      if (!deadline) { deadline = d.now.plus(parseDuration(node.timeout)).toISO()!; setPath(d.ctx, `vars.${key}`, deadline); }
      if (d.now < DateTime.fromISO(deadline)) return { status: "waiting", until: DateTime.fromISO(deadline), stay: true, result: { deadline } };
      const timeoutEdge = d.edgesFrom(node.id).find((e) => e.label === "timeout");
      return timeoutEdge ? { status: "ok", next: timeoutEdge.to, result: { timed_out: true } } : { status: "exit", reason: "no_reply", result: { timed_out: true } };
    }

    case "slack_post": {
      const conn = await one<{ bot_token: Buffer; channels: Record<string, string> }>(d.c, "select bot_token, channels from slack_connections where company_id=$1", [d.company.id]);
      const channelId = render(node.channel, d.ctx, env(d));
      if (!conn || !channelId) { await recordSend(d, node, "slack", "", "suppressed", "unbound: slack"); return { status: "skipped", next, result: { why: "slack not connected" } }; }
      const text = render(node.template, d.ctx, env(d));
      const send = await recordSend(d, node, "slack", text, "queued"); if (!send) return { status: "skipped", next };
      const { decrypt } = await import("./crypto");
      const r = await d.adapters.notifier.post(decrypt(conn.bot_token), channelId, text);
      await d.c.query("update sends set status='sent', external_id=$2, sent_at=now() where id=$1", [send.id, r.ts]);
      return { status: "ok", next, result: { ts: r.ts } };
    }

    case "classify": {
      const input = render(node.input, d.ctx, env(d)); const state = node.state ? render(node.state, d.ctx, env(d)) : undefined;
      const options = (await many<{ value: string }>(d.c, "select value from core_categories where domain=$1 order by sort", [node.domain])).map((r) => r.value);
      const r = await d.adapters.classifier.choice(state, input, options, node.threshold);
      const top = Object.entries(r.distribution).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, p]) => `${k} ${(p * 100).toFixed(0)}%`).join(", ");
      setPath(d.ctx, node.into, r.value); setPath(d.ctx, "reply.confidence", r.confidence); setPath(d.ctx, "reply.top_guesses", top || "none");
      await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: "reply.classified", source: "engine", data: { intent: r.value, confidence: r.confidence, unclear: r.unclear, input } });
      return { status: "ok", next, result: { value: r.value, confidence: r.confidence } };
    }

    case "branch": {
      const edges = d.edgesFrom(node.id);
      for (const e of edges) if (e.when && evaluate(e.when, d.ctx)) return { status: "ok", next: e.to, result: { edge: e.to } };
      const els = edges.find((e) => e.else); if (els) return { status: "ok", next: els.to, result: { edge: els.to, else: true } };
      return { status: "failed", error: `branch ${node.id}: no edge matched and no else` };
    }
    case "check": return evaluate(node.when, d.ctx) ? { status: "ok", next } : { status: "exit", reason: node.else_exit };

    case "set_tag": case "remove_tag": {
      const ghlId = (d.ctx.contact as { ghl_contact_id?: string }).ghl_contact_id!;
      const add = node.type === "set_tag";
      if (add) await d.adapters.write.addTag(d.adapterCompany, ghlId, node.tag); else await d.adapters.write.removeTag(d.adapterCompany, ghlId, node.tag);
      await d.c.query(add ? "update contacts set tags = array(select distinct unnest(tags || $2::text[])) where id=$1" : "update contacts set tags = array_remove(tags, $2) where id=$1", [d.run.contact_id, add ? [node.tag] : node.tag]);
      await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: add ? "tag.added" : "tag.removed", source: "engine", data: { tag: node.tag } });
      return { status: "ok", next };
    }
    case "note": {
      const ghlId = (d.ctx.contact as { ghl_contact_id?: string }).ghl_contact_id!;
      await d.adapters.write.addNote(d.adapterCompany, ghlId, render(node.template, d.ctx, env(d)));
      return { status: "ok", next };
    }
    case "update_appointment": {
      if (!d.run.appointment_id) return { status: "failed", error: "update_appointment with no appointment on run" };
      const a = await one<{ ghl_appointment_id: string }>(d.c, "select ghl_appointment_id from appointments where id=$1", [d.run.appointment_id]);
      const patch = Object.fromEntries(Object.entries(node.set).map(([k, v]) => [k, typeof v === "string" ? render(v, d.ctx, env(d)) : v]));
      await d.adapters.write.updateAppointment(d.adapterCompany, a!.ghl_appointment_id, patch);
      if (typeof patch.status === "string") await d.c.query("update appointments set ghl_status=$2, ghl_updated_at=now() where id=$1", [d.run.appointment_id, patch.status]);
      return { status: "ok", next, result: patch };
    }
    case "update_opportunity": {
      if (!d.run.opportunity_id) return { status: "failed", error: "update_opportunity with no opportunity on run" };
      const allowed = new Set(["status", "contract_value", "installments"]);
      for (const [k, v] of Object.entries(node.set)) if (allowed.has(k)) await d.c.query(`update opportunities set ${k}=$2 where id=$1`, [d.run.opportunity_id, v]);
      return { status: "ok", next };
    }
    case "set_var": { const v = typeof node.value === "string" ? render(node.value, d.ctx, env(d)) : node.value; setPath(d.ctx, `vars.${node.key}`, v); return { status: "ok", next }; }
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
      await startRun(d.c, { companyId: d.company.id, workflowId: wf.id, triggerNodeId: trig?.node_id ?? "t1", event: ev, contactId: d.run.contact_id, appointmentId: d.run.appointment_id, opportunityId: d.run.opportunity_id });
      return { status: "exit", reason: `started:${node.workflow}` };
    }
  }
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split("."); let cur = obj;
  for (const p of parts.slice(0, -1)) { if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {}; cur = cur[p] as Record<string, unknown>; }
  cur[parts[parts.length - 1]] = value;
}
