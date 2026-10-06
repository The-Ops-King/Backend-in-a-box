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
  | { status: "waiting"; until: DateTime; stay?: boolean; wakeOnReply?: boolean; result?: Record<string, unknown> }   // stay: re-execute this same node on wake; wakeOnReply: an inbound message wakes it early
  | { status: "exit"; reason: string; result?: Record<string, unknown> }
  | { status: "paused"; reason: string; result?: Record<string, unknown> }
  | { status: "failed"; error: string };

export type ExecDeps = { c: PoolClient; adapters: Adapters; company: CompanyRow; adapterCompany: Company; bindings: Record<string, string>; run: RunRow; ctx: Record<string, unknown>; edgesFrom: (id: string) => Edge[]; now: DateTime };

const contactTz = (d: ExecDeps) => ((d.ctx.contact as { timezone?: string } | undefined)?.timezone) ?? d.company.timezone;
/** Shadow mode: the run proceeds exactly as it would live, but nothing is written to the CRM; sends are recorded as "would have sent". */
const shadow = (d: ExecDeps) => d.company.mode === "shadow";
const single = (d: ExecDeps, id: string): string | null => (d.edgesFrom(id).find((e) => e.label !== "timeout") ?? d.edgesFrom(id)[0])?.to ?? null;
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

async function recordSend(d: ExecDeps, node: Node, channel: "sms" | "email" | "slack", body: string, status: "queued" | "suppressed", reason?: string): Promise<{ id: string } | null> {
  const key = `${d.run.id}:${node.id}`;
  const row = await one<{ id: string }>(d.c, `insert into sends (company_id, run_id, contact_id, channel, idempotency_key, rendered_body, status, suppressed_reason, scheduled_for)
    values ($1,$2,$3,$4,$5,$6,$7,$8,now()) on conflict (idempotency_key) do nothing returning id`,
    [d.company.id, d.run.id, d.run.contact_id, channel, key, body, status, reason ?? null]);
  return row ?? null;
}

async function doSend(d: ExecDeps, node: Extract<Node, { type: "send_sms" | "send_email" }>): Promise<StepOutcome> {
  const next = single(d, node.id);
  if (node.type === "send_sms" && d.company.sms_enabled === false) { await recordSend(d, node, "sms", "", "suppressed", "sms_disabled: company has no number"); return { status: "skipped", next, result: { why: "sms disabled for company" } }; }
  const v = validityOk(d, node);
  let template = node.template, substituted = false;
  if (!v.ok) {
    if (node.on_stale === "skip") { await recordSend(d, node, node.type === "send_sms" ? "sms" : "email", "", "suppressed", `stale: ${v.why}`); return { status: "stale", next, result: { why: v.why } }; }
    if (node.on_stale === "escalate") { await recordSend(d, node, node.type === "send_sms" ? "sms" : "email", "", "suppressed", `stale-escalated: ${v.why}`); return { status: "paused", reason: `stale: ${v.why}` }; }
    if (!node.substitute_template) return { status: "failed", error: "on_stale=substitute but no substitute_template" };
    template = node.substitute_template; substituted = true;
  }
  let body: string, subject = "";
  try { body = render(template, d.ctx, env(d)); if (node.type === "send_email") subject = render(node.subject, d.ctx, env(d)); }
  catch (e) {
    if (e instanceof StaleTemplateError) { await recordSend(d, node, node.type === "send_sms" ? "sms" : "email", "", "suppressed", `stale-render: ${e.message}`); return node.on_stale === "escalate" ? { status: "paused", reason: e.message } : { status: "stale", next, result: { why: e.message } }; }
    if (e instanceof UnknownPathError) return { status: "failed", error: e.message };
    throw e;
  }
  const channel = node.type === "send_sms" ? "sms" : "email";
  const send = await recordSend(d, node, channel, body, "queued");
  if (!send) return { status: "skipped", next, result: { why: "already sent (idempotency)" } };
  if (shadow(d)) {
    await d.c.query("update sends set status='shadow', sent_at=now() where id=$1", [send.id]);
    await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: "message.sent", source: "engine", data: { channel, node: node.id, shadow: true, substituted } });
    return { status: "ok", next, result: { shadow: true, would_send: body.slice(0, 120), substituted } };
  }
  const ghlContactId = (d.ctx.contact as { ghl_contact_id?: string }).ghl_contact_id!;
  const r = node.type === "send_sms"
    ? await d.adapters.sender.sendSms(d.adapterCompany, ghlContactId, body)
    : await d.adapters.sender.sendEmail(d.adapterCompany, ghlContactId, subject, body);
  await d.c.query("update sends set status=$2, external_id=$3, error=$4, sent_at=case when $2='sent' then now() end where id=$1", [send.id, r.accepted ? "sent" : "failed", r.externalId || null, r.error ?? null]);
  await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: r.accepted ? "message.sent" : "send.suppressed", source: "engine", data: { channel, node: node.id, external_id: r.externalId, error: r.error, substituted } });
  return r.accepted ? { status: "ok", next, result: { external_id: r.externalId, substituted } } : { status: "failed", error: r.error ?? "send rejected" };
}

export async function executeNode(d: ExecDeps, node: Node): Promise<StepOutcome> {
  d.ctx.now = d.now.toISO();   // {{now | date:...}} in templates; refreshed every node so a persisted context never carries a stale clock
  const next = single(d, node.id);
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

    case "wait_for_reply": {
      // boundary = our last send in this run (so a reply to something earlier doesn't count), else run start
      // boundary = our last contact-facing send in this run (sent, or would-have-sent in shadow); Slack posts don't count
      const lastSend = await one<{ sent_at: Date }>(d.c, "select sent_at from sends where run_id=$1 and channel in ('sms','email') and status in ('sent','shadow') order by sent_at desc limit 1", [d.run.id]);
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
      if (d.now < DateTime.fromISO(deadline)) return { status: "waiting", until: DateTime.fromISO(deadline), stay: true, wakeOnReply: true, result: { deadline } };
      const timeoutEdge = d.edgesFrom(node.id).find((e) => e.label === "timeout");
      return timeoutEdge ? { status: "ok", next: timeoutEdge.to, result: { timed_out: true } } : { status: "exit", reason: "no_reply", result: { timed_out: true } };
    }

    case "slack_post": {
      const conn = await one<{ bot_token: Buffer; channels: Record<string, string> }>(d.c, "select bot_token, channels from slack_connections where company_id=$1", [d.company.id]);
      // the channel binding is optional (manifest marks slack.* not required), so resolve without throwing: unbound → skip the node, keep the run going
      const ref = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/.exec(node.channel);
      const channelId = ref ? (resolvePath(d.ctx, ref[1]) as string | undefined) : node.channel;
      if (!conn || !channelId) { await recordSend(d, node, "slack", "", "suppressed", "unbound: slack"); return { status: "skipped", next, result: { why: conn ? "slack channel not bound" : "slack not connected" } }; }
      const text = render(node.template, d.ctx, env(d));
      const send = await recordSend(d, node, "slack", text, "queued"); if (!send) return { status: "skipped", next };
      if (shadow(d)) { await d.c.query("update sends set status='shadow', sent_at=now() where id=$1", [send.id]); return { status: "ok", next, result: { shadow: true, would_post: text.slice(0, 120) } }; }
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
      const ghlId = (d.ctx.contact as { ghl_contact_id?: string | null }).ghl_contact_id;
      const add = node.type === "set_tag";
      const tags = (Array.isArray(node.tag) ? node.tag : [node.tag]).map((t) => render(t, d.ctx, env(d))).filter(Boolean);
      if (shadow(d)) {   // shadow: log it, touch neither GHL nor our replica of GHL's tags (the next poll would just "revert" it and emit a phantom tag.removed)
        for (const tag of tags) await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: add ? "tag.added" : "tag.removed", source: "engine", data: { tag, shadow: true } });
        return { status: "ok", next, result: { shadow: true, [add ? "would_tag" : "would_untag"]: tags } };
      }
      if (!ghlId) return { status: "failed", error: `${node.type}: contact has no CRM id yet` };
      for (const tag of tags) { if (add) await d.adapters.write.addTag(d.adapterCompany, ghlId, tag); else await d.adapters.write.removeTag(d.adapterCompany, ghlId, tag); }
      for (const tag of tags) await d.c.query(add ? "update contacts set tags = array(select distinct unnest(tags || $2::text[])) where id=$1" : "update contacts set tags = array_remove(tags, $2) where id=$1", [d.run.contact_id, add ? [tag] : tag]);
      await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: add ? "tag.added" : "tag.removed", source: "engine", data: { tag: node.tag } });
      return { status: "ok", next };
    }
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
      const patch = Object.fromEntries(Object.entries(node.set).map(([k, v]) => [k, typeof v === "string" ? render(v, d.ctx, env(d)) : v]));
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
      const card = await one<{ id: string; ghl_opportunity_id: string | null; opportunity_id: string; ghl_stage_id: string; name: string }>(d.c, "select id, ghl_opportunity_id, opportunity_id, ghl_stage_id, name from pipeline_cards where company_id=$1 and contact_id=$2 and ghl_pipeline_id=$3 and status='open' order by created_at desc limit 1", [d.company.id, d.run.contact_id, pipelineId]);
      // stage and name are optional on an update: a step that only stamps fields leaves the card where it is
      const stageId = node.stage ? render(node.stage, d.ctx, env(d)) : card?.ghl_stage_id ?? "";
      const name = node.name ? render(node.name, d.ctx, env(d)) : card?.name ?? "";
      const customFields = node.fields.map((f) => ({ id: render(f.id, d.ctx, env(d)), field_value: render(f.value, d.ctx, env(d)) })).filter((f) => f.id && f.field_value !== "");
      const assignedUserId = node.assign_to ? render(node.assign_to, d.ctx, env(d)) || undefined : undefined;
      if (!pipelineId || !stageId || !name) return { status: "failed", error: `pipeline_card ${node.id}: pipeline, stage or name unresolved` };
      if (!card && node.if_missing === "skip") return { status: "skipped", next, result: { why: "no open card on this board to move; this step never creates one" } };
      const write = { pipelineId, stageId, name, status: "open" as const, assignedUserId, customFields };
      // the pursuit the card belongs to: the run's, else the contact's open one, else a new one
      let oppId = d.run.opportunity_id ?? card?.opportunity_id ?? (await one<{ id: string }>(d.c, "select id from opportunities where company_id=$1 and contact_id=$2 and status='open' order by opened_at desc limit 1", [d.company.id, d.run.contact_id]))?.id;
      if (!oppId) {
        oppId = (await one<{ id: string }>(d.c, "insert into opportunities (company_id, contact_id, opened_by) values ($1,$2,$3) returning id", [d.company.id, d.run.contact_id, `workflow:${node.id}`]))!.id;
        await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: oppId, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: "opportunity.opened", source: "engine", data: { by: "workflow", node: node.id, shadow: shadow(d) } });
      }
      const ownerRow = assignedUserId ? await one<{ id: string }>(d.c, "select id from users where company_id=$1 and ghl_user_id=$2", [d.company.id, assignedUserId]) : undefined;
      if (card) {
        if (!shadow(d) && card.ghl_opportunity_id) await d.adapters.write.updateOpportunity(d.adapterCompany, card.ghl_opportunity_id, write);
        await d.c.query("update pipeline_cards set name=$2, ghl_stage_id=$3, assigned_user_id=coalesce($4, assigned_user_id), updated_at=now() where id=$1", [card.id, name, stageId, ownerRow?.id ?? null]);
      } else {
        let ghlId: string | null = null;
        if (!shadow(d)) {
          if (!contact?.ghl_contact_id) return { status: "failed", error: "pipeline_card: contact has no CRM id yet" };
          ghlId = (await d.adapters.write.createOpportunity(d.adapterCompany, { ...write, contactId: contact.ghl_contact_id })).id;
        }
        await d.c.query("insert into pipeline_cards (company_id, opportunity_id, contact_id, ghl_opportunity_id, ghl_pipeline_id, ghl_stage_id, name, assigned_user_id) values ($1,$2,$3,$4,$5,$6,$7,$8)", [d.company.id, oppId, d.run.contact_id, ghlId, pipelineId, stageId, name, ownerRow?.id ?? null]);
      }
      if (!d.run.opportunity_id) { d.run.opportunity_id = oppId; await d.c.query("update runs set opportunity_id=$2 where id=$1", [d.run.id, oppId]); }
      d.ctx.opportunity = await one(d.c, "select id, status, contract_value, opened_at from opportunities where id=$1", [oppId]);
      return { status: "ok", next, result: { ...(shadow(d) ? { shadow: true } : {}), card: card ? "moved" : "created", name, stage: stageId, fields: customFields } };
    }
    case "crm_record": {
      const objectKey = render(node.object, d.ctx, env(d)), key = render(node.key, d.ctx, env(d));
      if (!objectKey || !key) return { status: "failed", error: `crm_record ${node.id}: object or key rendered empty` };
      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.properties)) { const r = render(v, d.ctx, env(d)); if (r !== "") properties[k] = /^-?\d+(\.\d+)?$/.test(r) && /amount|total|count|score|duration|min$/i.test(k) ? Number(r) : r; }
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
      if (nothing) return { status: "skipped", next, result: { why: "nothing to write: every value rendered empty" } };
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
      const started = await startRun(d.c, { companyId: d.company.id, workflowId: wf.id, triggerNodeId: trig?.node_id ?? "t1", event: ev, contactId: d.run.contact_id, appointmentId: d.run.appointment_id, opportunityId: d.run.opportunity_id });
      // honest exit reason: a disabled target or a re-entry block is not a successful handoff
      return started ? { status: "exit", reason: `started:${node.workflow}`, result: { run_id: started } } : { status: "exit", reason: `handoff_suppressed:${node.workflow}`, result: { why: "target disabled or re-entry blocked" } };
    }
  }
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split("."); let cur = obj;
  for (const p of parts.slice(0, -1)) { if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {}; cur = cur[p] as Record<string, unknown>; }
  cur[parts[parts.length - 1]] = value;
}
