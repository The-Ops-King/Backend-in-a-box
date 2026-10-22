import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { checkpoint, many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { fallbacksOf, labelledEdge, onwardEdge, type Edge, type Node } from "./definition";
import { evaluate } from "./predicate";
import { render, resolveExpr, resolvePath, parseDuration, StaleTemplateError, UnknownPathError } from "./template";
import { checkSendLock, type LockChannel } from "./send-lock";
import { predicateWords, durationWords, skippedWords } from "./describe";
import { syncCards, pickCard, latestCard } from "./cards";
import { computeWaitUntil, deferIntoWindow, pullBackIntoWindow, timeParam } from "./waitrule";
import type { CompanyRow, RunRow } from "./context";
import { TEST_CHANNEL_KEY, slackLiveSet, type Effective, type Mode } from "./mode";
import { dispatchEvent, emitEvent } from "./dispatch";
import { raise } from "./alerts";
import { applyOutcome, outcomeTermFor, recordDisposition } from "./disposition";
import { liveProbes, runAvailabilityStep, runHealthStep, type HealthProbes } from "./health";
import { buildReport, periodFor, REPORT_KINDS, type ReportKind } from "./reports";
import { classifyError } from "./failures";
import { withButtons } from "./slack-blocks";
import { claimEffect, markEffect, PENDING_WHY, releasePending, type EffectKind } from "./effects";
import { callTime } from "./sales-call";
import { APPOINTMENT_FACTS, APPOINTMENT_JOINS, appointmentRow, runLookup } from "./lookup";
import { dropTranscripts, hydrateTranscripts } from "./transcripts";
import { dropReplies, hydrateReplies, mentionsReplyText, readsReplyText, scrubReplyText } from "./replies";
import { boardOf, stageWords } from "./card-moves";
import { QUIET_SUPPRESSED, QUIET_WHY, quietWhenEmpty } from "./quiet";
import { slackBot } from "./slack-conn";
import { switchOn } from "./setting-defaults";

/** Ghost posts to the team are real posts, labelled; nothing else in ghost leaves the engine. */
export const GHOST_PREFIX = "🧪 *ghost* — ";
/** A post made before live says which rung it came from, so the team never reads a rehearsal as a real client; a run held as ghost in test says ghost. The rung is the run's (D92). */
/** Slack as if live: the run is live, or the company put Slack live ahead of its contacts (D141); a run that writes nothing (ghost) never is. */
const slackLive = (d: ExecDeps) => d.mode === "live" || (slackLiveSet(d.bindings) && d.effective !== "ghost");
const modePrefix = (d: ExecDeps, label: "mode" | "ghost" | "none" = "mode") => (label === "none" || slackLive(d) ? "" : label === "ghost" ? (d.mode === "ghost" ? GHOST_PREFIX : "") : d.effective === "ghost" ? GHOST_PREFIX : `🧪 *${d.mode}* — `);
/** The step's own name/icon, else the company's defaults (bindings slack.name / slack.icon), else the app. A list of icons is handed on whole; the notifier picks one per post.
 *  An icon that is one whole `{{expr}}` takes the value as it is, so a set_var can hand over a list of faces (a reschedule's 🔁 instead of the calendars). */
const faces = (d: ExecDeps, icon: string): string[] => { const m = /^\s*\{\{([^}]+)\}\}\s*$/.exec(icon); const v = m ? resolveExpr(m[1], d.ctx, env(d)) : render(icon, d.ctx, env(d)); return (Array.isArray(v) ? v : [v]).map((x) => (x === undefined || x === null ? "" : String(x))).filter(Boolean); };
const persona = (d: ExecDeps, as?: { name?: string; icon?: string | string[] }) => {
  const icons = as?.icon ? (Array.isArray(as.icon) ? as.icon : [as.icon]).flatMap((i) => faces(d, i)) : [];
  return { name: as?.name ? render(as.name, d.ctx, env(d)) : d.bindings["slack.name"], icon: icons.length > 1 ? icons : icons[0] ?? d.bindings["slack.icon"] };
};
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
// GHL's custom field types (it spells monetary MONETORY); the CRM refuses a number sent as text, an option list sent as anything but an
// array, and on a custom object a money field without its currency ("Cash Collected is missing a currency code", PMU 2026-10-14)
const NUMBER_TYPES = new Set(["NUMERICAL", "FLOAT", "NUMBER"]), MONEY_TYPES = new Set(["MONETORY", "MONETARY"]), LIST_TYPES = new Set(["MULTIPLE_OPTIONS", "CHECKBOX"]);
/**
 * A rendered record property as its CRM field wants it, by the field's type: a number for a numeric or money field ("1,500" → 1500),
 * an array for a multi-option or checkbox field, text for the rest. With no type (the object's fields could not be read) the key's
 * name is the only hint. Never called with an empty value: an empty property is left out, never written as 0.
 */
export function propertyValue(key: string, rendered: string, type: string | undefined): unknown {
  if (!type) return /^\[.*\]$/s.test(rendered) ? jsonArrayOr(rendered) : /^-?\d+(\.\d+)?$/.test(rendered) && /amount|total|count|score|duration|min$/i.test(key) ? Number(rendered) : rendered;
  const t = type.toUpperCase();
  if (NUMBER_TYPES.has(t) || MONEY_TYPES.has(t)) {
    const n = rendered.replace(/[\s$,]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(n)) return rendered;
    return MONEY_TYPES.has(t) ? { currency: "default", value: Number(n) } : Number(n);
  }
  if (LIST_TYPES.has(t)) { const v = /^\s*\[.*\]\s*$/s.test(rendered) ? jsonArrayOr(rendered.trim()) : rendered; return Array.isArray(v) ? v : rendered.split(",").map((x) => x.trim()).filter(Boolean); }
  return rendered;
}

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

export type ExecDeps = { c: PoolClient; adapters: Adapters; company: CompanyRow; adapterCompany: Company; bindings: Record<string, string>; run: RunRow; ctx: Record<string, unknown>; edgesFrom: (id: string) => Edge[]; now: DateTime; probes?: HealthProbes; /** the run's rung (D92: the workflow's own, else the company's) */ mode: Mode; effective: Effective; cardsReadError?: string; /** D89: the reply words this step was given (replies.ts), for a step that writes what it rendered */ replyTexts?: string[] };

const contactTz = (d: ExecDeps) => { const tz = (d.ctx.contact as { timezone?: string } | undefined)?.timezone; return tz && DateTime.now().setZone(tz).isValid ? tz : d.company.timezone; };
/** A ghost run (ghost mode, or test with a contact that does not pass) proceeds exactly as it would live, but nothing is written to the CRM; sends are recorded as "would have sent". */
/** Nothing written to the CRM (D52): the step records what it would have done. */
const ghost = (d: ExecDeps) => d.effective === "ghost";
/** D132: the CRM is written, but nothing reaches the contact: a text, an email, an agreement or an outbound webhook is held back. */
const held = (d: ExecDeps) => d.effective !== "real";
const heldFlag = (d: ExecDeps) => (ghost(d) ? { ghost: true } : { quiet: true });
const QUIET_HELD = "quiet mode: nothing reaches a contact";
/** D145: the send lock, after the mode let the send through and before anything reaches the vendor. */
const sendLock = (d: ExecDeps, channel: LockChannel) =>
  checkSendLock(d.c, { adapters: d.adapters, company: d.adapterCompany, workflowId: d.run.workflow_id, ghlContactId: (d.ctx.contact as { ghl_contact_id?: string | null } | undefined)?.ghl_contact_id, channel });

const single = (d: ExecDeps, id: string): string | null => onwardEdge(d.edgesFrom(id))?.to ?? null;
const env = (d: ExecDeps) => ({ now: d.now, tz: contactTz(d), companyTz: d.company.timezone, tzKnown: (d.ctx.contact as { timezone_known?: boolean } | undefined)?.timezone_known !== false });

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

async function recordSend(d: ExecDeps, node: Node, channel: "sms" | "email" | "slack" | "webhook", body: string, status: "queued" | "suppressed" | "ghost" | "quiet", reason?: string | null, on: PoolClient = d.c): Promise<{ id: string } | null> {
  const key = `${d.run.id}:${node.id}`;
  // D66: a row the vendor refused (`failed`) is reclaimed by the retry; queued, sent, suppressed, ghost and quiet rows stay as they are, so nothing goes out twice
  const row = await one<{ id: string }>(on, `insert into sends (company_id, run_id, contact_id, channel, idempotency_key, rendered_body, status, suppressed_reason, scheduled_for)
    values ($1,$2,$3,$4,$5,$6,$7,$8,now()) on conflict (idempotency_key) do update set status=excluded.status, suppressed_reason=excluded.suppressed_reason, rendered_body=excluded.rendered_body, error=null, scheduled_for=now() where sends.status='failed' returning id`,
    [d.company.id, d.run.id, d.run.contact_id, channel, key, body, status, reason ?? null]);
  return row ?? null;
}

/**
 * D151 (audit 2026-10-19): what stands between one vendor write and a second is committed before the vendor is asked, with what
 * the run did before it (`checkpoint`). A run whose transaction rolls back after the vendor accepted (a later SQL error, the
 * function killed) still finds its claim, or its queued send, on the retry, and does not ask the vendor twice.
 */
const committed = <T>(d: ExecDeps, fn: (c: PoolClient) => Promise<T>) => checkpoint(d.c, fn);
/** D66: the create ledger, claimed before a vendor write that has no key of its own and marked done after (effects.ts). */
const claim = (d: ExecDeps, node: Node, kind: EffectKind) => committed(d, (c) => claimEffect(c, d.company.id, d.run.id, node.id, kind));
const done = (d: ExecDeps, node: Node, kind: EffectKind, externalId?: string | null) => committed(d, (c) => markEffect(c, d.run.id, node.id, kind, externalId));
/**
 * D200 (audit §3.3): the claim around a vendor write with no key of its own, in one place for the steps that share its rule (a note, a
 * task, an agreement): a claim an earlier try finished is reused; one it left pending is not written twice (the vendor may have it);
 * else the write runs once and is marked done. A record and a card keep their own rules (D66: a done record claim is updated, a
 * pending card claim is made again after the read that found no card).
 */
async function writeOnce(d: ExecDeps, node: Node, kind: EffectKind, write: () => Promise<string | null>): Promise<{ id: string | null; reused: boolean } | { pending: true }> {
  const cl = await claim(d, node, kind);
  if (!cl.fresh) return cl.done ? { id: cl.external_id, reused: true } : { pending: true };
  const id = await write();
  await done(d, node, kind, id);
  return { id, reused: false };
}
/** A vendor that never answered may have done it: not reclaimable, said in an alert, never retried blind. */
export const ambiguousSendError = (e?: string) => !!e && /\btimeout\b|timed out|aborted|ECONNRESET|socket hang up|other side closed|UND_ERR/i.test(e);

/**
 * D200 (audit risk 10; Tyler: a replay does not re-send): a booking handed on `again` (replay.ts, D142) starts new runs, with new send
 * keys. What an earlier run of the same booking and workflow already sent the person at this step (a text, email or webhook that went
 * or may have, an agreement claimed) is not sent again; `force` on the replay overrides. One held in ghost or quiet never reached them.
 */
async function sentBefore(d: ExecDeps, node: Node, kind: "sms" | "email" | "webhook" | "document"): Promise<boolean> {
  const ev = d.ctx.event as { again?: boolean; force?: boolean } | undefined;
  if (!ev?.again || ev.force || !d.run.appointment_id) return false;
  const args = [d.run.appointment_id, d.run.workflow_id, d.run.id, node.id];
  return kind === "document"
    ? !!(await one(d.c, "select 1 from step_effects e join runs r on r.id=e.run_id where r.appointment_id=$1 and r.workflow_id=$2 and r.id<>$3 and e.node_id=$4 and e.kind='document' limit 1", args))
    : !!(await one(d.c, "select 1 from sends s join runs r on r.id=s.run_id where r.appointment_id=$1 and r.workflow_id=$2 and r.id<>$3 and s.idempotency_key = r.id::text || ':' || $4 and s.status in ('sent','unknown','queued') limit 1", args));
}
const REPLAYED = "replay: an earlier run of this booking already sent this; not sent again (force: true on the replay sends it)";

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
  // G11: no address for the channel on the replica (the CRM's own phone/email fields): nothing to send to, so nothing is asked of the CRM; the ledger says why and the run goes on
  const who = d.ctx.contact as { phone?: string | null; email?: string | null } | undefined;
  if (who && !(channel === "sms" ? who.phone : who.email)) { const why = `no ${channel === "sms" ? "phone" : "email"} on the contact`; await recordSend(d, node, channel, body, "suppressed", why); return { status: "skipped", next, result: { kind: "noop", why } }; }
  // D66 (F2): a person the poll has not matched to the CRM yet has nothing to send to; the CRM is never asked about contact "undefined", so nobody is stamped gone
  if (!held(d) && !(d.ctx.contact as { ghl_contact_id?: string | null } | undefined)?.ghl_contact_id) return { status: "failed", error: `${node.type}: contact has no CRM id yet (nothing to send to)` };
  if (held(d)) {
    const send = await recordSend(d, node, channel, body, "queued");
    if (!send) return { status: "skipped", next, result: { kind: "noop", why: "already sent (idempotency)" } };
    await d.c.query("update sends set status=$2, suppressed_reason=$3, sent_at=now() where id=$1", [send.id, ghost(d) ? "ghost" : "quiet", ghost(d) ? null : QUIET_HELD]);
    await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: "message.sent", source: "engine", data: { channel, node: node.id, ...heldFlag(d), substituted } });
    return { status: "ok", next, result: { ...heldFlag(d), would_send: body.slice(0, 120), substituted } };
  }
  if (await one(d.c, "select 1 from sends where idempotency_key=$1 and status<>'failed'", [`${d.run.id}:${node.id}`])) return { status: "skipped", next, result: { kind: "noop", why: "already sent (idempotency)" } };
  if (await sentBefore(d, node, channel)) { await recordSend(d, node, channel, body, "suppressed", REPLAYED); return { status: "skipped", next, result: { kind: "noop", why: REPLAYED, would_send: body.slice(0, 120) } }; }
  // D188: the CRM will not text them (Do Not Disturb): nothing is asked of it and nobody is alerted; the booking card says it once
  if (channel === "sms" && (d.ctx.contact as { sms_dnd?: boolean } | undefined)?.sms_dnd === true) { await recordSend(d, node, channel, body, "suppressed", DND_WHY); return { status: "skipped", next, result: { kind: "noop", why: DND_WHY } }; }
  const lock = await sendLock(d, channel);
  if (!lock.ok) {
    const held_ = await recordSend(d, node, channel, body, "queued");
    if (lock.retry) { if (held_) await d.c.query("update sends set status='failed', error=$2 where id=$1", [held_.id, lock.why]); return { status: "failed", error: lock.why }; }
    if (held_) await d.c.query("update sends set status='suppressed', suppressed_reason=$2 where id=$1", [held_.id, lock.why]);
    await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: "send.suppressed", source: "engine", data: { channel, node: node.id, why: lock.why } });
    return { status: "skipped", next, result: { kind: "noop", why: lock.why, would_send: body.slice(0, 120) } };
  }
  const send = await committed(d, (o) => recordSend(d, node, channel, body, "queued", null, o));
  if (!send) return { status: "skipped", next, result: { kind: "noop", why: "already sent (idempotency)" } };
  const ghlContactId = (d.ctx.contact as { ghl_contact_id?: string }).ghl_contact_id!;
  const r = node.type === "send_sms"
    ? await d.adapters.sender.sendSms(d.adapterCompany, ghlContactId, body)
    : viaCrmEmailTemplate ? await d.adapters.sender.sendEmailTemplate(d.adapterCompany, ghlContactId, ghlTemplateId) : await d.adapters.sender.sendEmail(d.adapterCompany, ghlContactId, subject, body);
  const unknown = !r.accepted && ambiguousSendError(r.error);
  await committed(d, (o) => o.query("update sends set status=$2, external_id=$3, error=$4, sent_at=case when $2='sent' then now() end where id=$1", [send.id, r.accepted ? "sent" : unknown ? "unknown" : "failed", r.externalId || null, r.error ?? null]));
  if (unknown) return { status: "skipped", next, result: { kind: "blocked", why: `the CRM did not answer, so the ${channel} may or may not have gone out; it is not sent again (check the conversation in the CRM): ${r.error}`, would_send: body.slice(0, 120) } };
  await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: r.accepted ? "message.sent" : "send.suppressed", source: "engine", data: { channel, node: node.id, external_id: r.externalId, error: r.error, substituted } });
  if (r.accepted) return { status: "ok", next, result: { external_id: r.externalId, substituted } };
  // D188: refused for Do Not Disturb (the replica did not know yet): the contact learns it, the send is suppressed, no alert
  if (channel === "sms" && dndRefusal(r.error)) {
    await committed(d, async (o) => { await o.query("update sends set status='suppressed', suppressed_reason=$2 where id=$1", [send.id, DND_WHY]); await o.query("update contacts set sms_dnd=true, updated_at=now() where id=$1", [d.run.contact_id]); });
    return { status: "skipped", next, result: { kind: "noop", why: DND_WHY } };
  }
  // G21: the CRM has no such contact (deleted or merged there): the replica learns it, one alert says so, and the run is looked at again at once so the premise exits it `moot: contact gone`
  if (contactGone(r.error)) { await markContactGone(d, r.error!); return { status: "waiting", until: d.now, stay: true, result: { why: "the CRM has no such contact; the run exits at its next look" } }; }
  // D66: an outage or a dead token is the failure policy's (retried in place, or paused until the token is replaced); the send row is `failed` and the retry reclaims it
  const f = classifyError(r.error ?? "");
  if (f.cls === "transient" || f.cls === "auth") return { status: "failed", error: r.error ?? "send rejected" };
  // D56: the refusal is on the send row and raises a "step could not run" alert; the rest of the sequence still runs
  return { status: "skipped", next, result: { kind: "blocked", why: `the CRM refused the ${channel}: ${r.error ?? "send rejected"}`, would_send: body.slice(0, 120) } };
}

const DND_WHY = "texts are turned off for this contact (Do Not Disturb)";
/** D188: GHL's refusal of a text for Do Not Disturb ("Cannot send message as DND is active for SMS", CONVERSATIONS_MSG_DND_ACTIVE_SMS). */
export const dndRefusal = (error?: string) => !!error && /DND_ACTIVE|\bDND is active\b/i.test(error);

/** A card the CRM itself said is not there: it answered 404, or "not found" with no other status. An outage or no answer is never "gone" (D69). */
const cardGone = (e: unknown) => { const f = classifyError(e); return f.answered && (f.status === 404 || (f.status === null && /\bnot found\b/i.test(f.message))); };

/** The CRM's way of saying the contact is gone: a 404 from the client, or its "Contact with id … not found" body. */
export const contactGone = (error?: string) => !!error && (/^GHL 404 /.test(error) || /\bcontact (with id \S+ )?not found\b/i.test(error));
/** Marks the replica once and raises one alert per contact; the premise `contact_exists` does the exiting. */
const markContactGone = (d: ExecDeps, error: string) => markGone(d.c, d.company, d.run, d.ctx, error, d.now);
/** The same, callable by the runner when any contact write comes back 404 (D66): true when this is the first time the person is found gone. */
export async function markGone(c: PoolClient, company: Pick<CompanyRow, "id" | "slug">, run: Pick<RunRow, "id" | "contact_id">, ctx: Record<string, unknown>, error: string, now: DateTime): Promise<boolean> {
  if (!run.contact_id) return false;
  const r = await c.query("update contacts set gone_at=now(), updated_at=now() where id=$1 and gone_at is null", [run.contact_id]);
  if (!r.rowCount) return false;
  const who = ctx.contact as { name?: string | null; ghl_contact_id?: string | null } | undefined;
  await raise(c, { companyId: company.id, key: `contact:gone:${run.contact_id}`, level: "warning", source: "engine", href: `/app/c/${company.slug}`,
    text: `${who?.name ?? who?.ghl_contact_id ?? "A contact"} is gone from the CRM (deleted or merged there); the runs about them exit instead of sending. The CRM said: ${error.slice(0, 160)}`,
    detail: { contact_id: run.contact_id, ghl_contact_id: who?.ghl_contact_id ?? null, run_id: run.id, error: error.slice(0, 300) } }, now.toJSDate());
  return true;
}

/** A Slack user id (a DM), as opposed to a channel. */
const isSlackUser = (id: string) => /^[UW][A-Z0-9]{2,}$/.test(id);
/**
 * Where a Slack post goes before its run is live (the run's rung, D92). D133: with a test channel set (`test.slack_channel`), every post
 * goes there instead of where its step points (its live channel), saying where it was for: "For #deals:" or "Would have sent to
 * <name>:" for a DM. Going live is the switch; nothing else changes. Without one, as before: a channel post goes to its own
 * channel, marked (D31), and a DM goes to the ops channel (`slack.channel.ops`), else the operator (`bot.escalate_to`), unless the
 * run is about a test contact and the operator is the recipient (D76). Null: deliver as addressed.
 */
async function slackRoute(d: ExecDeps, target: string | undefined, unlinked?: string): Promise<null | { to: string; prefix: string } | { blocked: string }> {
  if (!target && unlinked === undefined) return null;
  // D140, live: a DM for someone not in Slack yet goes to the operator, marked who it was for (the health check flags the person until they are linked)
  if (slackLive(d)) { const op = d.bindings["bot.escalate_to"]; return !target && op ? { to: op, prefix: `For ${unlinked} (not in Slack yet):\n` } : null; }
  const nameOf = async (u: string) => (await one<{ name: string }>(d.c, "select name from users where company_id=$1 and slack_user_id=$2 limit 1", [d.company.id, u]))?.name ?? u;
  const to = async () => target ? `Would have sent to ${await nameOf(target)}:\n` : `Would have sent to ${unlinked} (no Slack account linked yet):\n`;
  const test = d.bindings[TEST_CHANNEL_KEY];
  if (test) return target === test ? null : { to: test, prefix: !target || isSlackUser(target) ? await to() : `For <#${target}>:\n` };
  if (target && !isSlackUser(target)) return null;
  const operator = d.bindings["bot.escalate_to"], ops = d.bindings["slack.channel.ops"] || operator;
  if (operator && target === operator && d.effective === "real" && d.run.contact_id) return null;
  if (!ops) return { blocked: `${d.mode} mode: a DM to a team member goes to the test channel (test.slack_channel), else the ops channel, until live, and none of them (nor an operator, bot.escalate_to) is set` };
  return { to: ops, prefix: await to() };
}

/** A step whose channel is a person's Slack id ({{user.slack_user_id}}) that came out empty: who that person is, so the post can say who it was for. */
function unlinkedPerson(d: ExecDeps, channel: string | undefined): { name: string; id?: string } | undefined {
  const of = channel ? /^\{\{\s*([a-zA-Z0-9_.]+)\.slack_user_id\s*\}\}$/.exec(channel)?.[1] : undefined;
  if (!of) return undefined;
  const p = resolvePath(d.ctx, of) as { id?: string; name?: string; first_name?: string } | undefined;
  return { name: p?.name || p?.first_name || "the person", ...(p?.id ? { id: p.id } : {}) };
}

/** D56: Slack refusing a post (bad token, channel gone) fails that send and alerts; the run goes on (the CRM steps after a post are the point of the run). */
async function slackPostOrFail(d: ExecDeps, sendId: string, post: () => Promise<{ ts: string }>): Promise<{ ts: string } | { refused: string }> {
  try { return await post(); }
  catch (e) {
    const refused = String((e as Error).message).slice(0, 500);
    await d.c.query("update sends set status='failed', error=$2 where id=$1", [sendId, refused]);
    // D66: Slack blinking (ratelimited, a 5xx) is the failure policy's: the send row is failed so the retry reclaims it, and the same post is tried again in a minute
    if (classifyError(e).cls === "transient") throw e;
    return { refused };
  }
}

/** The contact's tags: `add` goes on, then `remove` comes off, in the CRM and on our replica; one tag.added / tag.removed event per tag, dispatched (D144). */
async function applyTags(d: ExecDeps, type: Node["type"], next: string | null, want: { add?: string | string[]; remove?: string | string[]; keep?: string | string[] }): Promise<StepOutcome> {
  const ghlId = (d.ctx.contact as { ghl_contact_id?: string | null }).ghl_contact_id;
  // an entry that is one whole {{expr}} may name a list (a picked set of tags); the rest render as text
  const one1 = (t: string): string[] => { const m = /^\s*\{\{([^}]+)\}\}\s*$/.exec(t); const v = m ? resolveExpr(m[1], d.ctx, env(d)) : render(t, d.ctx, env(d)); return (Array.isArray(v) ? v : [v]).map((x) => (x === undefined || x === null ? "" : String(x))); };
  const rendered = (v?: string | string[]) => [...new Set((v === undefined ? [] : Array.isArray(v) ? v : [v]).flatMap(one1).filter(Boolean))];
  const added = [...rendered(want.add), ...rendered(want.keep)];
  // D76: a tag the same step adds is never also taken off (undoing an earlier answer keeps what the new one also says)
  const dirs = ([["add", "tag.added", "would_tag"], ["remove", "tag.removed", "would_untag"]] as const).filter(([k]) => want[k] !== undefined).map(([k, event, would]) => ({ add: k === "add", raw: want[k]!, tags: k === "add" ? rendered(want.add) : rendered(want[k]).filter((t) => !added.includes(t)), event, would })).filter((x) => x.tags.length);
  if (!dirs.length) return { status: "skipped", next, result: { kind: "noop", why: "no tag to add or take off" } };
  if (ghost(d)) {   // ghost: log it, touch neither GHL nor our replica of GHL's tags (the next poll would just "revert" it and emit a phantom tag.removed)
    for (const x of dirs) for (const tag of x.tags) await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: x.event, source: "engine", data: { tag, ghost: true } });
    return { status: "ok", next, result: { ghost: true, ...Object.fromEntries(dirs.map((x) => [x.would, x.tags])) } };
  }
  if (!ghlId) return { status: "failed", error: `${type}: contact has no CRM id yet` };
  for (const x of dirs) {
    for (const tag of x.tags) { if (x.add) await d.adapters.write.addTag(d.adapterCompany, ghlId, tag); else await d.adapters.write.removeTag(d.adapterCompany, ghlId, tag); }
    for (const tag of x.tags) await d.c.query(x.add ? "update contacts set tags = array(select distinct unnest(tags || $2::text[])) where id=$1" : "update contacts set tags = array_remove(tags, $2) where id=$1", [d.run.contact_id, x.add ? [tag] : tag]);
    // D144: one event per tag, as the poll's diff would emit it; the replica already has the tag, so the poll will not, and a workflow
    // started by that tag starts now (never this one: dispatch skips the workflow whose run wrote the event)
    for (const tag of x.tags) {
      const ev = await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: x.event, source: "engine", data: { tag } });
      await dispatchEvent(d.c, ev, { contact: { id: d.run.contact_id } });
    }
  }
  return { status: "ok", next };
}

/**
 * D87: a step that reads a transcript gets it from its source just before it runs, and the context lets go of it right after (transcripts.ts).
 * D89: the same for a reply's words (replies.ts), read from GHL by message id; what the step leaves behind (its result, a var it set) is
 * scrubbed of them before the runner saves it.
 */
export async function executeNode(d: ExecDeps, node: Node): Promise<StepOutcome> {
  const runs = node.type !== "trigger" && !(node.only_if && !evaluate(node.only_if, d.ctx));
  const held = runs ? await hydrateTranscripts(d, node) : [];
  let replies: string[] | null = null;
  try {
    replies = runs ? await hydrateReplies(d, node) : null;
    if (!replies?.length) return await executeStep(d, node);
    const before = new Map(Object.entries((d.ctx.vars as Record<string, unknown>) ?? {}).map(([k, v]) => [k, JSON.stringify(v)]));
    d.replyTexts = replies;
    const out = await executeStep(d, node);
    const vars = d.ctx.vars as Record<string, unknown> | undefined;
    if (vars) for (const [k, v] of Object.entries(vars)) if (before.get(k) !== JSON.stringify(v)) vars[k] = scrubReplyText(v, replies, { cut: false });
    // a classify step's result is Jev's answer, never its input (an answer of "confirmed" to a reply of "confirmed" stays as it is)
    const scrubbed = "error" in out && typeof out.error === "string" ? { ...out, error: scrubReplyText(out.error, replies) } : out;
    return node.type === "classify" || !("result" in scrubbed) || !scrubbed.result ? scrubbed : { ...scrubbed, result: scrubReplyText(scrubbed.result, replies) };
  } finally { dropTranscripts(d.ctx, held); if (runs && readsReplyText(node)) dropReplies(d.ctx); d.replyTexts = undefined; }
}

async function executeStep(d: ExecDeps, node: Node): Promise<StepOutcome> {
  d.ctx.now = d.now.toISO();   // {{now | date:...}} in templates; refreshed every node so a persisted context never carries a stale clock
  const next = single(d, node.id);
  // only_if: a step that runs some of the time; the chart draws it dashed with this condition (D103)
  if (node.only_if && node.type !== "trigger" && !evaluate(node.only_if, d.ctx)) return { status: "skipped", next, result: { kind: "noop", why: skippedWords(node.only_if, (q) => evaluate(q, d.ctx)) } };
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
        const pulled = node.rule.window === "before" ? pullBackIntoWindow(r.at, contactTz(d), d.company.send_window_start, d.company.send_window_end) : r.at;   // D193
        const w = deferIntoWindow(pulled < d.now ? d.now : pulled, contactTz(d), d.company.send_window_start, d.company.send_window_end);
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
      if (held(d)) return { status: "ok", next, result: { ...heldFlag(d), would_send_document: { template: templateId, sender, to: contact?.ghl_contact_id } } };
      if (!contact?.ghl_contact_id) return { status: "failed", error: "send_document: contact has no CRM id yet" };
      if (await sentBefore(d, node, "document")) return { status: "skipped", next, result: { kind: "noop", why: REPLAYED, would_send_document: { template: templateId, sender, to: contact.ghl_contact_id } } };
      const lock = await sendLock(d, "document");
      if (!lock.ok) return lock.retry ? { status: "failed", error: lock.why } : { status: "skipped", next, result: { kind: "noop", why: lock.why, would_send_document: { template: templateId, sender, to: contact.ghl_contact_id } } };
      const w = await writeOnce(d, node, "document", async () => (await d.adapters.write.sendDocumentTemplate(d.adapterCompany, { templateId, contactId: contact.ghl_contact_id!, userId: sender })).id || null);
      if ("pending" in w) return { status: "skipped", next, result: { kind: "blocked", why: `document not sent twice: ${PENDING_WHY}` } };
      if (w.reused) return { status: "ok", next, result: { document: w.id, template: templateId, sender, reused: true } };
      const { recordSentByEngine } = await import("./agreements");
      if (w.id && d.run.contact_id) await recordSentByEngine(d.c, d.company.id, d.run.contact_id, w.id, name);
      return { status: "ok", next, result: { document: w.id, template: templateId, sender } };
    }
    case "notify_owner": {
      const owner = (d.ctx.contact as { owner?: { name: string; email: string; ghl_user_id: string; slack_user_id: string | null } } | undefined)?.owner;
      const bot = await slackBot(d.c, d.company.id);
      if (bot) await resolveMentions(d, bot.token);
      const text = render(node.template, d.ctx, env(d));
      const contact = d.ctx.contact as { ghl_contact_id?: string | null } | undefined;
      const out: Record<string, unknown> = { owner: owner?.name ?? null };
      if (node.task) {
        const dueAt = d.now.plus(parseDuration(node.task.due)).toJSDate(), title = render(node.task.title, d.ctx, env(d));
        if (ghost(d)) out.would_create_task = { title, due: dueAt.toISOString(), assignedUserId: owner?.ghl_user_id };
        else if (contact?.ghl_contact_id) {
          const ghlId = contact.ghl_contact_id;
          const w = await writeOnce(d, node, "task", async () => String((await d.adapters.write.createTask(d.adapterCompany, ghlId, { title, body: text, dueAt, assignedUserId: owner?.ghl_user_id })).id));
          if ("pending" in w) { out.task = null; out.task_reused = false; out.task_why = PENDING_WHY; }
          else { out.task = w.id; if (w.reused) out.task_reused = true; }
        }
      }
      const fallback = node.fallback_channel ? (/^\{\{/.test(node.fallback_channel) ? (resolvePath(d.ctx, node.fallback_channel.replace(/[{}\s]/g, "")) as string | undefined) : node.fallback_channel) : undefined;
      const slackUser = owner?.slack_user_id ?? null;   // resolveMentions already looked the owner up
      const route = await slackRoute(d, slackUser ?? fallback);
      if (route && "blocked" in route) { await recordSend(d, node, "slack", text, "suppressed", route.blocked); return { status: "skipped", next, result: { ...out, kind: "noop", why: route.blocked, would_post: text.slice(0, 160) } }; }
      const target = route ? route.to : slackUser ?? fallback;
      const named = slackUser ? text : `${owner?.name ? `*${owner.name}* ` : ""}${text}`, body = route ? `${route.prefix}${named}` : named;
      if (!bot || !target) { await recordSend(d, node, "slack", body, "suppressed", bot ? "unbound: owner not in Slack and no fallback channel" : "unbound: slack"); return { status: "skipped", next, result: { ...out, kind: "blocked", why: bot ? "owner not in Slack, no fallback channel" : "slack not connected", would_post: body.slice(0, 160) } }; }
      const send = await recordSend(d, node, "slack", body, "queued"); if (!send) return { status: "skipped", next, result: { ...out, kind: "noop", why: "already posted (idempotency)" } };
      const r = await slackPostOrFail(d, send.id, () => d.adapters.notifier.post(bot.token, target, `${modePrefix(d)}${body}`, persona(d, node.as)));
      if ("refused" in r) return { status: "skipped", next, result: { ...out, kind: "blocked", why: `Slack refused the post: ${r.refused}`, would_post: body.slice(0, 160) } };
      await d.c.query("update sends set status=$2, external_id=$3, sent_at=now() where id=$1", [send.id, ghost(d) ? "ghost" : "sent", r.ts]);
      return { status: "ok", next, result: { ...out, ...(ghost(d) ? { ghost: true } : {}), dm: !!slackUser, ...(route ? { redirected_to: route.to } : {}), ts: r.ts } };
    }

    case "wait_for_reply": {
      // boundary = our last send in this run (so a reply to something earlier doesn't count), else run start
      // boundary = our last contact-facing send in this run (sent, or would-have-sent in ghost, or held in quiet); Slack posts don't count
      const lastSend = await one<{ sent_at: Date }>(d.c, "select sent_at from sends where run_id=$1 and channel in ('sms','email') and status in ('sent','ghost','quiet') order by sent_at desc limit 1", [d.run.id]);
      const since = lastSend?.sent_at ?? d.run.started_at ?? new Date(0);
      // D89: which messages came in and when; their words are read from GHL by the step that needs them (replies.ts)
      const replies = await many<{ ghl_message_id: string; occurred_at: Date; channel: string }>(d.c,
        `select ghl_message_id, occurred_at, channel from messages where company_id=$1 and contact_id=$2 and direction='inbound' and occurred_at > $3 ${node.channel === "any" ? "" : "and channel=$4"} order by occurred_at, id`,
        node.channel === "any" ? [d.company.id, d.run.contact_id, since] : [d.company.id, d.run.contact_id, since, node.channel]);
      if (replies.length) {
        // D47: people answer in pieces ("yes" … "see you then"). After the newest message, wait `settle` for the rest; a further reply re-wakes and restarts the clock.
        const newest = replies[replies.length - 1]; const settled = DateTime.fromJSDate(newest.occurred_at).plus(parseDuration(node.settle));
        if (d.now < settled) return { status: "waiting", until: settled, stay: true, wakeOnReply: true, result: { settling_until: settled.toISO(), replies: replies.length } };
        setPath(d.ctx, "reply.last_inbound", { message_id: newest.ghl_message_id, at: newest.occurred_at.toISOString(), channel: newest.channel });
        setPath(d.ctx, "reply.message_ids", replies.map((r) => r.ghl_message_id));
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

    case "wait_for_event": return waitForEvent(d, node);
    case "lookup": {
      // D85: a fixed read-only question of the ledger, its filters templated; a blank filter is none
      const params = Object.fromEntries(Object.entries(node.params).map(([k, v]) => [k, render(v, d.ctx, env(d)).trim()]).filter(([, v]) => v !== ""));
      const r = await runLookup(d.c, { companyId: d.company.id, contactId: d.run.contact_id, appointmentId: d.run.appointment_id, now: d.now }, node.query, params);
      if ("error" in r) return { status: "failed", error: `lookup ${node.id} (${node.query}): ${r.error}` };
      setPath(d.ctx, `vars.${node.into}`, r.value);
      return { status: "ok", next, result: { query: node.query, params, ...("count" in r.value ? { count: r.value.count } : {}), ...("found" in r.value ? { found: r.value.found } : {}) } };
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
      const channelId = [node.channel, ...fallbacksOf(node.fallback_channel)].map(channelOf).find(Boolean);
      // render first even when it cannot post: the dashboard shows what WOULD have gone to Slack, which is the whole point of ghost
      const text = render(node.template, d.ctx, env(d));
      // a DM to a person with no Slack account linked ({{user.slack_user_id}} empty): before live it is shown in the test channel; live, it is blocked and says who
      const unlinked = !channelId ? unlinkedPerson(d, node.channel) : undefined;
      const route = channelId ? await slackRoute(d, channelId) : unlinked ? await slackRoute(d, undefined, unlinked.name) : null;
      if (!conn || (!channelId && !(route && "to" in route))) {
        // D140: what it needed, so its alert can be checked again without redoing the step
        const refs = [node.channel, ...fallbacksOf(node.fallback_channel)].map((x) => /^\{\{\s*(slack\.channel\.[a-z0-9_]+)\s*\}\}$/.exec(x ?? "")?.[1]);
        const needs = !conn ? { slack: true } : unlinked ? (unlinked.id ? { slack_user: unlinked.id } : undefined) : refs.every(Boolean) ? { bindings: refs as string[] } : undefined;
        await recordSend(d, node, "slack", text, "suppressed", !conn ? "unbound: slack" : unlinked ? "unbound: person not in Slack" : "unbound: slack channel");
        return { status: "skipped", next, result: { kind: "blocked", why: !conn ? "slack not connected" : unlinked ? `${unlinked.name} has no Slack account linked` : "slack channel not bound", ...(needs ? { needs } : {}), would_post: text.slice(0, 160) } };
      }
      // D124: quiet when empty: the step before found nothing (its own fact, from the data), so a scheduled run posts nothing; a run started by hand still posts.
      // Checked after the channel, so a quiet day still proves the step can post (it clears a "could not post" alert)
      if (node.quiet_when_empty && quietWhenEmpty(d.bindings) && (d.ctx.event as { manual?: boolean } | undefined)?.manual !== true && resolvePath(d.ctx, node.quiet_when_empty) === true) {
        await recordSend(d, node, "slack", text, "suppressed", QUIET_SUPPRESSED);
        return { status: "skipped", next, result: { kind: "noop", why: QUIET_WHY } };
      }
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
      if (route && "blocked" in route) { await recordSend(d, node, "slack", text, "suppressed", route.blocked); return { status: "skipped", next, result: { kind: "noop", why: route.blocked, would_post: text.slice(0, 160) } }; }
      // a post redirected before live threads under an earlier post only when that one was redirected to the same place
      if (route && parentChannel && parentChannel !== route.to) { parentTs = undefined; parentChannel = undefined; }
      // Slack is the team, not the CRM or the contact: before live the post still goes out, marked, so the team sees what the engine would do (D31), in the test channel when one is set (D133)
      const postTo = route ? route.to : parentTs && parentChannel ? parentChannel : channelId!;   // no channel and no route returned above
      const send = await recordSend(d, node, "slack", text, "queued"); if (!send) return { status: "skipped", next, result: { kind: "noop", why: "already posted (idempotency)" } };
      const token = decrypt(conn.bot_token);
      const shown = `${route ? route.prefix : ""}${text}`, body = !parentTs ? `${modePrefix(d, node.label)}${shown}` : shown;
      // D76: a post that says where a thing stands (a call's filed outcome, the day's report) is edited in place when it is said again, never repeated
      const prior = node.edit && node.tag ? await one<{ channel: string; ts: string }>(d.c, "select channel, ts from slack_posts where company_id=$1 and tag=$2", [d.company.id, render(node.tag, d.ctx, env(d))]) : null;
      const update = d.adapters.notifier.update;
      // D93: buttons whose condition holds, under the same words; the text stays the notification and the fallback
      const buttons = (node.buttons ?? []).filter((b) => !b.only_if || evaluate(b.only_if, d.ctx)).map((b) => ({ text: render(b.text, d.ctx, env(d)), action: b.action, value: render(b.value, d.ctx, env(d)), style: b.style })).filter((b) => b.value);
      const blocks = buttons.length ? withButtons(body, buttons) : undefined;
      const r = prior && update
        ? await slackPostOrFail(d, send.id, async () => { await update(token, prior.channel, prior.ts, body, blocks); return { ts: prior.ts, channel: prior.channel }; })
        : await slackPostOrFail(d, send.id, () => d.adapters.notifier.post(token, postTo, body, persona(d, node.as), parentTs, blocks));
      if ("refused" in r) return { status: "skipped", next, result: { kind: "blocked", why: `Slack refused the post: ${r.refused}`, would_post: text.slice(0, 160) } };
      await d.c.query("update sends set status=$2, external_id=$3, sent_at=now() where id=$1", [send.id, ghost(d) ? "ghost" : "sent", r.ts]);
      setPath(d.ctx, `vars.__slack.${node.id}`, r.ts);
      let reacted = false;
      for (const emoji of (node.react ? (Array.isArray(node.react) ? node.react : [node.react]) : []).map((e) => render(e, d.ctx, env(d))).filter(Boolean)) if (parentTs) reacted = (await d.adapters.notifier.react(token, postTo, parentTs, emoji).catch(() => false)) || reacted;
      // D45: the choices a person can tap, as reactions on this post; the door turns their tap into a slack.reaction event
      const at = (r as { channel?: string }).channel || postTo;
      const offered: string[] = [];
      for (const emoji of node.offer ?? []) if (await d.adapters.notifier.react(token, at, r.ts, emoji).catch(() => false)) offered.push(emoji);
      // another post this one decorates: the bot's own reactions come off it (unreact) and the outcome goes on it (react_on)
      const postOf = async (of: string) => of.startsWith("tag:") ? one<{ channel: string; ts: string }>(d.c, "select channel, ts from slack_posts where company_id=$1 and tag=$2", [d.company.id, render(of.slice(4), d.ctx, env(d))]) : (() => { const ts = resolvePath(d.ctx, `vars.__slack.${of}`) as string | undefined; return ts ? { channel: postTo, ts } : null; })();
      let unreacted = 0, reactedOn = 0;
      if (node.unreact) { const target = await postOf(node.unreact.of); if (target) for (const emoji of node.unreact.emojis.map((e) => render(e, d.ctx, env(d))).filter(Boolean)) if (await d.adapters.notifier.unreact(token, target.channel, target.ts, emoji).catch(() => false)) unreacted++; }
      // react_on runs before this post takes its tag, so "tag:X" here is still the post X named before (a reschedule marks the card it replaces, D71);
      // its emojis render like react's, and one that renders empty is no reaction
      if (node.react_on) { const target = await postOf(node.react_on.of); if (target) for (const emoji of node.react_on.emojis.map((e) => render(e, d.ctx, env(d))).filter(Boolean)) if (await d.adapters.notifier.react(token, target.channel, target.ts, emoji).catch(() => false)) reactedOn++; }
      let tag: string | undefined;
      if (node.tag) { tag = render(node.tag, d.ctx, env(d)); await d.c.query("insert into slack_posts (company_id, tag, channel, ts, run_id) values ($1,$2,$3,$4,$5) on conflict (company_id, tag) do update set channel=excluded.channel, ts=excluded.ts, run_id=excluded.run_id, posted_at=now()", [d.company.id, tag, at, r.ts, d.run.id]); }
      return { status: "ok", next, result: { ...(ghost(d) ? { ghost: true } : {}), ...(route ? { redirected_to: route.to } : {}), ...(prior && update ? { edited: prior.ts } : {}), ts: r.ts, ...(node.thread_of ? { in_thread_of: parentTs ?? null, ...(tagged ? { tag: tagged } : {}) } : {}), ...(tag ? { remembered_as: tag } : {}), ...(node.react ? { reacted } : {}), ...(node.offer ? { offered } : {}), ...(buttons.length ? { buttons: buttons.map((b) => b.text) } : {}), ...(node.unreact ? { unreacted } : {}), ...(node.react_on ? { reacted_on: reactedOn } : {}) } };
    }

    case "classify": {
      const input = render(node.input, d.ctx, env(d)); const state = node.state ? render(node.state, d.ctx, env(d)) : undefined;
      if (!input.trim()) return { status: "skipped", next, result: { kind: "noop", why: "nothing to classify: input rendered empty" } };
      const options = (await many<{ value: string }>(d.c, "select value from core_categories where domain=$1 order by sort", [node.domain])).map((r) => r.value);
      const r = await d.adapters.classifier.choice(state, input, options, node.threshold, { apiKey: d.bindings["secret.jev_key"] || process.env.JEV_API_KEY, criteria: node.criteria, ambiguityMax: node.ambiguity_max, question: node.question });
      const top = Object.entries(r.distribution).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, p]) => `${k} ${(p * 100).toFixed(0)}%`).join(", ");
      setPath(d.ctx, node.into, r.value); setPath(d.ctx, "reply.confidence", r.confidence); setPath(d.ctx, "reply.intent_confidence", Math.round(r.confidence * 100)); setPath(d.ctx, "reply.top_guesses", top || "none");
      const recId = (d.ctx.recording as { id?: string } | undefined)?.id; const intoKey = node.into.replace(/^vars\./, "").split(".");
      // merged in depth: a second read into vars.classify.* keeps the first (D79: the setter call's kind, then its result)
      const readsTranscript = /transcript_text/.test(node.input), readsReply = mentionsReplyText(node.input) || !!d.replyTexts?.length;
      if (recId && (node.input.includes("recording.") || readsTranscript)) {
        const prior = (await one<{ a: unknown }>(d.c, "select analysis->$2 as a from recordings where id=$1", [recId, intoKey[0]]))?.a ?? null;
        const merged = deepSet(prior, intoKey.slice(1), { value: r.value, confidence: r.confidence, ambiguity: r.ambiguity ?? null });
        await d.c.query("update recordings set analysis = jsonb_set(analysis, $2::text[], $3::jsonb, true) where id=$1", [recId, [intoKey[0]], JSON.stringify(merged)]);
      }
      await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: "reply.classified", source: "engine", data: { intent: r.value, confidence: r.confidence, unclear: r.unclear, top_guesses: top || "none", ...(r.ambiguity !== undefined ? { ambiguity: r.ambiguity } : {}), ...(readsTranscript || readsReply ? { input_chars: input.length } : { input }) } });   // D87, D89: neither a transcript nor a reply's words are copied into the ledger; Jev's read is
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
      if (node.else_pause) return { status: "failed", error: `check ${node.id}: ${node.else_pause}` };
      return { status: "exit", reason: node.else_exit, gate: true };
    }

    case "tags": return applyTags(d, node.type, next, { add: node.add, remove: node.remove, keep: node.keep });
    case "set_tag": return applyTags(d, node.type, next, { add: node.tag });
    case "remove_tag": return applyTags(d, node.type, next, { remove: node.tag });
    case "note": {
      const ghlId = (d.ctx.contact as { ghl_contact_id?: string | null } | undefined)?.ghl_contact_id;
      const noteText = render(node.template, d.ctx, env(d));
      if (ghost(d)) return { status: "ok", next, result: { ghost: true, would_note: noteText.slice(0, 160) } };
      if (!ghlId) return { status: "failed", error: "note: contact has no CRM id yet" };
      const w = await writeOnce(d, node, "note", async () => { await d.adapters.write.addNote(d.adapterCompany, ghlId, noteText); return null; });
      if ("pending" in w) return { status: "skipped", next, result: { kind: "blocked", why: `note not written twice: ${PENDING_WHY}` } };
      return w.reused ? { status: "ok", next, result: { reused: true, why: "written on an earlier try" } } : { status: "ok", next };
    }
    case "update_appointment": {
      if (!d.run.appointment_id) return { status: "failed", error: "update_appointment with no appointment on run" };
      const a = await one<{ external_id: string; source: string; status: string; starts_at: Date; self_booked: boolean | null; term: { name: string; category: string } | null }>(d.c,
        "select a.external_id, a.source, a.status, a.starts_at, a.self_booked, json_build_object('name', t.name, 'category', t.category) as term from appointments a left join company_terms t on t.id=a.appointment_term where a.id=$1", [d.run.appointment_id]);
      const patch = Object.fromEntries(Object.entries(node.set).filter(([k]) => k !== "pending_read").map(([k, v]) => [k, typeof v === "string" ? render(v, d.ctx, env(d)) : v]));
      // pending_read is OUR column (D58), never the CRM's: written whatever the source and the mode, like `record`
      let pending: unknown;
      if ("pending_read" in node.set) {
        pending = node.set.pending_read === null ? null : deepRender(node.set.pending_read, d.ctx, env(d));
        await d.c.query("update appointments set pending_read=$2 where id=$1", [d.run.appointment_id, pending === null ? null : JSON.stringify(pending)]);
        if (d.ctx.appointment) (d.ctx.appointment as Record<string, unknown>).pending_read = pending;
        if (!Object.keys(patch).length) return { status: "ok", next, result: { pending_read: pending } };
      }
      // only the CRM's own calendars take every write; a Calendly booking takes one: a cancel (D196), which Calendly tells the person
      // about, so it waits for the person to be reachable (live, or a test contact) like a send. Anything else is recorded and skipped.
      const source = a!.source === "calendly" ? d.adapters.booking.calendly : null;
      const cancelAtSource = !!source?.cancel && patch.status === "cancelled" && Object.keys(patch).length === 1;
      if (a!.source !== "ghl" && !cancelAtSource) return { status: "ok", next, result: { skipped: true, reason: `appointments from ${a!.source} are read-only`, would_update: patch } };
      if (ghost(d)) return { status: "ok", next, result: { ghost: true, would_update: patch } };
      if (cancelAtSource && held(d)) return { status: "ok", next, result: { ...heldFlag(d), would_cancel_in: a!.source } };
      // Calendly emails the person about a cancel, so a locked workflow cancels only Tyler's own bookings (the send lock, D145)
      if (cancelAtSource) {
        const lock = await sendLock(d, "email");
        if (!lock.ok) return lock.retry ? { status: "failed", error: lock.why } : { status: "skipped", next, result: { kind: "noop", why: lock.why, would_cancel_in: a!.source } };
      }
      if (cancelAtSource) await source!.cancel!(d.adapterCompany, a!.external_id, "Cancelled by the team");
      else await d.adapters.write.updateAppointment(d.adapterCompany, a!.external_id, patch);
      if (typeof patch.status !== "string") return { status: "ok", next, result: patch };
      // D66 (C6): one event per (run, step, appointment, status), so a retry after a crash between our row and the emit emits once, and a crash before it still emits
      const emitted = await one<{ id: number }>(d.c, "select id from events where run_id=$1 and event_type='appointment.status_changed' and appointment_id=$2 and data->>'node'=$3 and data->'status'->>'to'=$4 limit 1", [d.run.id, d.run.appointment_id, node.id, patch.status]);
      const unchanged = patch.status === a!.status;
      if (unchanged && (emitted || !(d.run.step_attempt ?? 0))) return { status: "ok", next, result: { ...patch, ...(emitted ? { already_emitted: true } : {}) } };
      if (!unchanged) await d.c.query("update appointments set status=$2, source_updated_at=now() where id=$1", [d.run.appointment_id, patch.status]);
      if (emitted) return { status: "ok", next, result: { ...patch, status_changed: { from: a!.status, to: patch.status }, already_emitted: true } };
      // the same event the poll would emit had the source changed first; the poll then sees no delta, so this is its one emission. Runs parked on the call wake to re-check their premise.
      await d.c.query("update runs set next_run_at=now() where company_id=$1 and appointment_id=$2 and status='waiting'", [d.company.id, d.run.appointment_id]);
      const ev = await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: d.run.opportunity_id, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: "appointment.status_changed", source: "engine",
        data: { source: a!.source, status: { from: unchanged ? null : a!.status, to: patch.status }, ...(patch.status === "cancelled" ? { before_start: d.now.toMillis() < a!.starts_at.getTime() } : {}), by: "workflow", node: node.id } });
      const started = await dispatchEvent(d.c, ev, { contact: { id: d.run.contact_id }, appointment: { id: d.run.appointment_id, starts_at: a!.starts_at.toISOString(), status: patch.status, term: a!.term, self_booked: a!.self_booked } });
      return { status: "ok", next, result: { ...patch, status_changed: { from: a!.status, to: patch.status }, started } };
    }
    case "pipeline_card": return pipelineCard(d, node, next);
    case "crm_record": {
      const objectKey = render(node.object, d.ctx, env(d)), key = node.key ? render(node.key, d.ctx, env(d)) : "";
      // D85: a record the engine did not make, addressed by the CRM's own id; an id that renders empty is nothing to update, not a fault
      const byId = node.record_id !== undefined ? render(node.record_id, d.ctx, env(d)).trim() : undefined;
      if (byId === "") return { status: "skipped", next, result: { kind: "noop", why: "no record to update: its CRM id rendered empty" } };
      if (!objectKey || (!key && !byId)) return { status: "failed", error: `crm_record ${node.id}: object or key rendered empty` };
      // the object's own fields and their types: a property it does not have would make the CRM refuse the whole write, and each value goes as its field's type wants
      const known = await objectFields(d, objectKey);
      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.properties)) { const r = render(v, d.ctx, env(d)); if (!r.trim()) continue; properties[k] = propertyValue(k, r, known?.get(k)); }
      // D77: what an earlier answer set and this one does not is emptied with null (the CRM ignores "" on some field types); only an update has anything to empty
      const cleared = Object.fromEntries([...new Set(node.clear.map((k) => render(k, d.ctx, env(d)).trim()).filter((k) => k && !(k in properties)))].map((k) => [k, null]));
      const owner = node.owner ? render(node.owner, d.ctx, env(d)) || undefined : undefined;
      // a property the company's object does not have is left out and named
      const dropped = known ? [...Object.keys(properties), ...Object.keys(cleared)].filter((k) => !known.has(k)) : [];
      for (const k of dropped) { delete properties[k]; delete cleared[k]; }
      if (dropped.length && !Object.keys(properties).length && !Object.keys(cleared).length) return { status: "skipped", next, result: { kind: "noop", why: `nothing to write: the ${objectKey} object has no ${dropped.join(", ")} field yet`, not_on_object: dropped } };
      if (byId) return recordById(d, node, next, objectKey, key, byId, properties, cleared, owner, dropped);
      const existing = await one<{ id: string; ghl_record_id: string | null }>(d.c, "select id, ghl_record_id from crm_records where company_id=$1 and object_key=$2 and record_key=$3", [d.company.id, objectKey, key]);
      let ghlId = existing?.ghl_record_id ?? null;
      // an update-only step: nothing to update when we never made the record, or made it only in ghost (no CRM id); a bare record keyed by an id alone would be a duplicate
      let matched: string | undefined;
      if (node.if_missing !== "create" && !(ghost(d) ? existing : ghlId)) {
        const found = node.if_missing === "match" ? await bookingRecord(d, objectKey) : { why: "this step never creates one" };
        if ("why" in found) return { status: "skipped", next, result: { kind: "noop", why: `no ${objectKey} record in the CRM to update: ${found.why}` } };
        ghlId = matched = found.id;
      }
      let recoveredHow: string | undefined;
      if (!ghost(d)) {
        // D66: a create the CRM answered but our row never recorded becomes an update of that record; one it never answered is not asked twice
        const cl = ghlId ? null : await claim(d, node, "record");
        if (cl && !cl.fresh) {
          if (cl.done && cl.external_id) ghlId = cl.external_id;
          else {
            // D223 (Tyler: "it should see what exists, and if it makes sense exactly what happened, it should work to fix it"): the CRM never
            // answered the create, so the engine looks for the record that create would have made, by the key it stamps on it. Exactly one:
            // the create landed, so it is this record (adopted, then updated as any second write is). None: nothing was written, so it is
            // created now. Several, no key on the record to look for, or the CRM cannot be read: a person decides, as before.
            const look = await lostCreate(d, objectKey, key, properties);
            if (look.found) { ghlId = look.found; await done(d, node, "record", ghlId); recoveredHow = `found in the CRM by its key (${look.found}) and adopted`; }
            else if (look.none) { await releasePending(d.c, d.run.id, node.id); const again = await claim(d, node, "record"); if (!again?.fresh) return { status: "skipped", next, result: { kind: "blocked", why: `${objectKey} record not created twice: ${PENDING_WHY}` } }; recoveredHow = "not in the CRM (the lost create never landed), so created now"; }
            else return { status: "skipped", next, result: { kind: "blocked", why: `${objectKey} record not created twice: ${PENDING_WHY}; ${look.why}` } };
          }
        }
        if (ghlId) await d.adapters.write.updateRecord(d.adapterCompany, objectKey, ghlId, { ...properties, ...cleared }, owner);
        else { ghlId = (await d.adapters.write.createRecord(d.adapterCompany, objectKey, properties, owner)).id; await done(d, node, "record", ghlId); }
      }
      const updating = !!(existing || matched);
      if (updating) Object.assign(properties, cleared);
      const row = await one<{ id: string }>(d.c, `insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, properties) values ($1,$2,$3,$4,$5,$6)
        on conflict (company_id, object_key, record_key) do update set ghl_record_id=coalesce(excluded.ghl_record_id, crm_records.ghl_record_id), properties=crm_records.properties || excluded.properties, updated_at=now() returning id`,
        [d.company.id, objectKey, key, ghlId, d.run.contact_id, properties]);
      d.ctx.record = { id: ghlId ?? "", key, object: objectKey, properties };
      const related = await relate(d, node);
      return { status: "ok", next, result: { ...(ghost(d) ? { ghost: true } : {}), record: existing || matched ? "updated" : "created", ...(matched ? { matched_in_crm: matched } : {}), ...(recoveredHow ? { recovered: recoveredHow } : {}), our_id: row!.id, crm_id: ghlId, properties, related, ...(dropped.length ? { not_on_object: dropped } : {}) } };
    }
    case "update_contact": {
      const contact = d.ctx.contact as { ghl_contact_id?: string | null } | undefined;
      const r = (t?: string) => (t ? render(t, d.ctx, env(d)) || undefined : undefined);
      // `clear` is the one place an empty value is written on purpose (the CRM may accept and ignore it for some field types; the Zap it replaces warned about that too)
      const cleared = node.clear.map((id) => render(id, d.ctx, env(d))).filter(Boolean).map((id) => ({ id, field_value: "" }));
      let fields = node.fields.map((f) => ({ id: render(f.id, d.ctx, env(d)), field_value: render(f.value, d.ctx, env(d)), ifEmpty: !!f.if_empty })).filter((f) => f.id && f.field_value !== "");
      // D78: an if_empty field goes only where the CRM's own value is empty as of now
      const kept: string[] = [];
      if (fields.some((f) => f.ifEmpty) && contact?.ghl_contact_id) {
        const live = await d.adapters.read.getContact(d.adapterCompany, contact.ghl_contact_id);
        const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);
        fields = fields.filter((f) => { const keep = !f.ifEmpty || !live || blank(live.customFields[f.id]); if (!keep) kept.push(f.id); return keep; });
      }
      const patch = { firstName: r(node.set.first_name), lastName: r(node.set.last_name), phone: r(node.set.phone), timezone: r(node.set.timezone), assignedUserId: r(node.set.assign_to),
        customFields: [...fields.map(({ id, field_value }) => ({ id, field_value })), ...cleared] };
      const already = kept.length ? { already_set: kept } : {};
      const nothing = !patch.firstName && !patch.lastName && !patch.phone && !patch.timezone && !patch.assignedUserId && !patch.customFields.length;
      if (nothing) return { status: "skipped", next, result: { kind: "noop", why: kept.length ? "nothing to write: the CRM already has every value" : "nothing to write: every value rendered empty", ...already } };
      if (ghost(d)) return { status: "ok", next, result: { ghost: true, would_update: patch, ...already } };
      if (!contact?.ghl_contact_id) return { status: "failed", error: "update_contact: contact has no CRM id yet" };
      await d.adapters.write.updateContact(d.adapterCompany, contact.ghl_contact_id, patch);
      // our replica of the CRM contact learns what we just wrote, so a later step in the same minute reads it (the next poll confirms it)
      const fieldPatch = Object.fromEntries(patch.customFields.map((f) => [f.id, f.field_value === "" ? null : f.field_value]));
      await d.c.query("update contacts set first_name=coalesce($2,first_name), last_name=coalesce($3,last_name), timezone=coalesce($4,timezone), ghl_fields = ghl_fields || $5::jsonb, updated_at=now() where id=$1", [d.run.contact_id, patch.firstName ?? null, patch.lastName ?? null, patch.timezone ?? null, JSON.stringify(fieldPatch)]);
      return { status: "ok", next, result: { ...patch, ...already } };
    }
    case "ensure_contact": {
      // D141 (Tyler: "Update, and if they don't exist, then create"): GHL is the truth, so it is asked first; nothing it holds is overwritten
      const ct = d.ctx.contact as { id?: string; ghl_contact_id?: string | null; first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null } | undefined;
      if (!ct?.id) return { status: "failed", error: "ensure_contact: the run has no contact" };
      const std = Object.fromEntries(Object.entries({ firstName: ct.first_name, lastName: ct.last_name, email: ct.email, phone: ct.phone }).filter(([, v]) => v)) as Record<string, string>;
      const source = node.source ? render(node.source, d.ctx, env(d)) || undefined : undefined;
      const { findInGhl, planWrite, applyWrite, matchPolicy } = await import("./typeform");
      const policy = matchPolicy(d.bindings);   // D190
      const parsed = { responseId: "", std: { first_name: std.firstName, last_name: std.lastName, email: std.email, phone: std.phone }, fields: [], unbound: [], filled: [] } as unknown as Parameters<typeof planWrite>[0];
      for (const k of Object.keys(parsed.std) as (keyof typeof parsed.std)[]) if (!parsed.std[k]) delete parsed.std[k];
      const byId = ct.ghl_contact_id ? await d.adapters.read.getContact(d.adapterCompany, ct.ghl_contact_id) : null;
      const found = byId ? { snap: byId, by: "id" } : await findInGhl(d.adapterCompany, d.adapters, std.email, std.phone, policy);
      // D190: a contact the engine already tracks by id keeps what GHL holds (a hand fix there is never reverted); a search match takes the new details
      const plan = planWrite(parsed, found?.snap ?? null, [], source, policy.overwrite && !byId);
      const action = plan.action === "create" ? "created" : Object.keys(plan.standard).length ? "updated" : "found";
      setPath(d.ctx, `vars.${node.id}`, { action: ghost(d) ? `would be ${action}` : action });
      if (ghost(d)) return { status: "ok", next, result: { ghost: true, would: action, ...(found ? { ghl_contact_id: found.snap.id, matched: found.by } : {}), standard: plan.standard } };
      const w = await applyWrite(d.adapterCompany, d.adapters, plan, parsed, () => []);
      if (w.id !== ct.ghl_contact_id) {
        const { attachIdentifier } = await import("./poll");
        await d.c.query("update contacts set ghl_contact_id=$2, gone_at=null, updated_at=now() where id=$1", [ct.id, w.id]);
        await attachIdentifier(d.c, d.company.id, ct.id, "ghl_contact", w.id);
        setPath(d.ctx, "contact.ghl_contact_id", w.id);
      }
      // D188: what GHL holds now (an existing contact's Do Not Disturb, the phone it has) is what the run's later steps read
      const now_ = await d.adapters.read.getContact(d.adapterCompany, w.id).catch(() => null);
      if (now_) {
        if (now_.smsDnd !== undefined) { await d.c.query("update contacts set sms_dnd=$2 where id=$1", [ct.id, now_.smsDnd]); setPath(d.ctx, "contact.sms_dnd", now_.smsDnd); }
        if (!ct.phone && now_.phone) setPath(d.ctx, "contact.phone", now_.phone);
      }
      const { scopeTag } = await import("./scope");
      const add = [...(node.tags === undefined ? [] : Array.isArray(node.tags) ? node.tags : [node.tags]), ...(node.scope_tag && scopeTag(d.bindings) ? [scopeTag(d.bindings)!] : [])];
      const tagged = add.length ? await applyTags(d, node.type, next, { add }) : null;
      if (tagged && tagged.status === "failed") return tagged;
      return { status: "ok", next, result: { action, ghl_contact_id: w.id, ...(found ? { matched: found.by } : {}), ...(Object.keys(plan.standard).length ? { filled: Object.keys(plan.standard) } : {}), ...(plan.kept.length ? { kept: plan.kept } : {}), ...(source && action === "created" ? { source } : {}) } };
    }
    case "create_task": {
      const contact = d.ctx.contact as { ghl_contact_id?: string | null } | undefined;
      const title = render(node.title, d.ctx, env(d)), body = node.body ? render(node.body, d.ctx, env(d)) : undefined;
      const dueAt = d.now.plus(parseDuration(render(node.due, d.ctx, env(d)) || "+1d")).toJSDate();
      const assignedUserId = node.assign_to ? render(node.assign_to, d.ctx, env(d)) || undefined : undefined;
      if (!switchOn(d.bindings, "crm.tasks")) return { status: "skipped", next, result: { kind: "noop", why: "tasks are off for this company (crm.tasks)" } };   // D141
      if (ghost(d)) return { status: "ok", next, result: { ghost: true, would_create_task: { title, body, due: dueAt.toISOString(), assignedUserId } } };
      if (!contact?.ghl_contact_id) return { status: "failed", error: "create_task: contact has no CRM id yet" };
      const ghlId = contact.ghl_contact_id;
      const w = await writeOnce(d, node, "task", async () => (await d.adapters.write.createTask(d.adapterCompany, ghlId, { title, body, dueAt, assignedUserId })).id);
      if ("pending" in w) return { status: "skipped", next, result: { kind: "blocked", why: `task not created twice: ${PENDING_WHY}` } };
      return { status: "ok", next, result: { task_id: w.id, title, due: dueAt.toISOString(), assignedUserId, ...(w.reused ? { reused: true } : {}) } };
    }
    case "update_opportunity": return updateOpportunity(d, node, next);
    case "analyze": {
      // not a CRM write, so it runs in ghost too: seeing what the AI would say about a call is the point of ghost
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
      if (node.source === "disposition") {
        // D88: a person's answer (a card dragged in the CRM), filed exactly as the end-of-day form files it
        const userId = node.user ? render(node.user, d.ctx, env(d)).trim() || null : null;
        const r = await recordDisposition(d.c, { companyId: d.company.id, appointmentId: d.run.appointment_id, outcomeTermId: termId, callOutcomeTermId: callTerm?.id ?? null, notes, userId, via: node.via ? render(node.via, d.ctx, env(d)) : undefined });
        if (d.ctx.appointment) (d.ctx.appointment as Record<string, unknown>).outcome = category;
        return { status: "ok", next, result: { outcome: category, call_outcome: node.call_outcome ? render(node.call_outcome, d.ctx, env(d)) : null, as: "disposition", events: r.events, runs_started: r.runs } };
      }
      // ours, never the CRM: a show is a fact about our appointment row, so ghost mode records it too
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
      if (held(d)) { await recordSend(d, node, "webhook", bodyText ?? "", ghost(d) ? "ghost" : "quiet", ghost(d) ? null : QUIET_HELD); return { status: "ok", next, result: { ...heldFlag(d), would_call: `${node.method} ${safeUrl}`, would_send: bodyText?.slice(0, 300) } }; }
      if (await sentBefore(d, node, "webhook")) { await recordSend(d, node, "webhook", bodyText ?? "", "suppressed", REPLAYED); return { status: "skipped", next, result: { kind: "noop", why: REPLAYED, would_call: `${node.method} ${safeUrl}` } }; }
      const lock = await sendLock(d, "webhook");
      if (!lock.ok) {
        if (lock.retry) return { status: "failed", error: lock.why };
        await recordSend(d, node, "webhook", bodyText ?? "", "suppressed", lock.why);
        return { status: "skipped", next, result: { kind: "noop", why: lock.why, would_call: `${node.method} ${safeUrl}`, would_send: bodyText?.slice(0, 300) } };
      }
      const send = await committed(d, (o) => recordSend(d, node, "webhook", bodyText ?? "", "queued", null, o)); if (!send) return { status: "skipped", next, result: { kind: "noop", why: "already called (idempotency)" } };
      try {
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20_000);
        const res = await fetch(url, { method: node.method, headers, body: node.method === "GET" ? undefined : bodyText, signal: ctl.signal }).finally(() => clearTimeout(timer));
        const text = await res.text().catch(() => "");
        let parsed: unknown = text; try { parsed = JSON.parse(text); } catch { /* not JSON: keep the text */ }
        await committed(d, (o) => o.query("update sends set status=$2, external_id=$3, sent_at=now(), error=$4 where id=$1", [send.id, res.ok ? "sent" : "failed", String(res.status), res.ok ? null : text.slice(0, 500)]));
        if (node.into) setPath(d.ctx, `vars.${node.into}`, parsed);
        if (!res.ok) { if (node.on_error === "skip") return { status: "skipped", next, result: { kind: "blocked", why: `${res.status} from ${safeUrl}`, response: text.slice(0, 300) } }; return { status: "failed", error: `${node.method} ${safeUrl} → ${res.status}: ${text.slice(0, 300)}` }; }
        return { status: "ok", next, result: { called: `${node.method} ${safeUrl}`, status: res.status, response: text.slice(0, 300) } };
      } catch (e) {
        const why = String((e as Error).name === "AbortError" ? "timed out after 20s" : (e as Error).message);
        const unknown = ambiguousSendError(why);
        await committed(d, (o) => o.query("update sends set status=$2, error=$3 where id=$1", [send.id, unknown ? "unknown" : "failed", why]));
        if (unknown) return { status: "skipped", next, result: { kind: "blocked", why: `${safeUrl} did not answer, so it may or may not have run; not called again: ${why}` } };
        if (node.on_error === "skip") return { status: "skipped", next, result: { kind: "blocked", why: `${safeUrl}: ${why}` } };
        return { status: "failed", error: `${node.method} ${safeUrl}: ${why}` };
      }
    }
    case "health_check": {
      const channel = node.channel ? (/^\{\{/.test(node.channel) ? (resolvePath(d.ctx, node.channel.replace(/^\{\{\s*|\s*\}\}$/g, "")) as string | undefined) : node.channel) : undefined;
      const as = persona(d, node.as);
      const r = await runHealthStep(d.c, d.company, d.adapters, d.probes ?? liveProbes, { checks: node.checks, min_slots: 0, slots_days: node.slots_days, fathom_silent_days: node.fathom_silent_days, drift_days: node.drift_days, poll_lag_min: node.poll_lag_min, channel: channel ?? null, run_id: d.run.id, as_name: node.as?.name ? as.name : null, as_icon: node.as?.icon ? (Array.isArray(as.icon) ? as.icon[0] : as.icon) : null }, d.now as DateTime<true>);
      const failing = r.findings.filter((f) => !f.ok);
      return { status: "ok", next, result: { checks: r.findings.length, failing: failing.length, raised: r.raised, resolved: r.resolved, ...(failing.length ? { problems: failing.map((f) => f.text).slice(0, 10) } : {}) } };
    }
    case "availability_check": {
      const cal = d.run.appointment_id ? await one<{ external_id: string }>(d.c, "select cal.external_id from appointments a join calendars cal on cal.id=a.calendar_id where a.id=$1", [d.run.appointment_id]) : null;
      const r = await runAvailabilityStep(d.c, d.company, d.adapters, d.probes ?? liveProbes, { min_slots: node.min_slots, days: node.days }, d.now as DateTime<true>, cal ? [cal.external_id] : undefined);
      const low = r.findings.filter((f) => !f.ok);
      return { status: "ok", next, result: { calendars: r.findings.length, low: low.length, raised: r.raised, resolved: r.resolved, ...(cal ? { only: cal.external_id } : {}), ...(low.length ? { problems: low.map((f) => f.text) } : {}) } };
    }
    case "eod_due": {
      // D76: the closer is reminded every day until each of their calls is filed. GHL's Sales Calls of the engine's bookings are the truth:
      // a call filed there is answered whatever the ledger holds, and a blank one is owed; the ledger fills in the calls GHL has no record of.
      // A Sales Call with no booking is not counted: the form has no row for it (D110).
      // D88 (A4): how far back, whether today counts and when the operator hears are the step's; the words are the template's
      const user = d.ctx.user as { id?: string; name?: string; eod?: { day: string; url: string } } | undefined;
      const legacy = node.lookback_days === undefined && node.include_today === undefined && node.overdue_after_days === undefined;
      if (!user?.eod || !user.id) { setPath(d.ctx, `vars.${node.into}`, legacy ? "" : { days: [], count: 0, overdue: [], overdue_count: 0 }); return { status: "ok", next, result: { kind: "noop", why: "the run is not about a closer" } }; }
      const lookback = node.lookback_days ?? 7, withToday = node.include_today ?? node.period === "evening", overdueAfter = node.overdue_after_days === undefined ? (node.period === "evening" ? 2 : null) : node.overdue_after_days;
      const tz = d.company.timezone, today = d.now.setZone(tz).toISODate()!, label = (day: string) => DateTime.fromISO(day, { zone: tz }).toFormat("ccc LLL d");
      const { closerSalesCalls, eodFacts } = await import("./eod");
      const eod = await eodFacts(d.c, d.company, user.id, (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, ""), d.now as DateTime<true>, lookback);
      // ledger: the day's calls with no answer on the ledger; moved: those a card move answered, owed until the day is filed (A1);
      // blank: every blank Sales Call that day (the operator hears their names); extra: blank ones the ledger does not already count
      // dials (D156, D191): a setter's logged calls the day has not answered, counted by the form beside its bookings; owed like calls
      const days = new Map<string, { ledger: Set<string>; moved: Set<string>; blank: string[]; extra: number; dials: number }>();
      for (const e of eod.earlier) days.set(e.day, { ledger: new Set(e.open), moved: new Set(e.moved), blank: [], extra: 0, dials: Math.max(0, e.calls - e.open.length) });
      if (withToday && eod.today.calls && !eod.today.filed) days.set(eod.day, { ledger: new Set(eod.today.open), moved: new Set(eod.today.moved), blank: [], extra: 0, dials: Math.max(0, eod.today.calls - eod.today.open.length) });
      let ghl: string | undefined;
      if (d.bindings["crm.object_sales_call"] && user.name) {
        try {
          const recs = await closerSalesCalls(d.c, d.adapters, d.adapterCompany, d.company.id, d.bindings, user.name, tz, d.now);
          for (const r of recs) if (r.filed) for (const e of days.values()) if (!e.moved.has(r.appointment_id)) e.ledger.delete(r.appointment_id);
          for (const r of recs) {
            if (r.filed || !r.due || (!withToday && r.day >= today)) continue;
            const e = days.get(r.day) ?? { ledger: new Set<string>(), moved: new Set<string>(), blank: [], extra: 0, dials: 0 }; e.blank.push(r.name);
            if (!e.ledger.has(r.appointment_id)) e.extra++;
            days.set(r.day, e);
          }
        } catch (e) { ghl = String((e as Error).message).slice(0, 200); }   // GHL unread: the ledger's days still go out
      }
      // D207: a setter's triage calls are named to the operator too once overdue, where the company turns it on (`eod.triage_overdue`;
      // Tyler: "add setters to the ping"). Owed is the ledger's: a triage call the end of day has not answered; one whose Discovery Call
      // record in GHL already has an outcome other than scheduled was answered there, and is not owed (as a filed Sales Call is not)
      if (/^(on|true|yes)$/i.test((d.bindings["eod.triage_overdue"] ?? "").trim())) {
        const open = [...new Set([...days.values()].flatMap((e) => [...e.ledger]))];
        const triage = open.length ? await many<{ id: string; slot_key: string | null; who: string }>(d.c, `select a.id::text as id, a.slot_key, coalesce(nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''), 'someone') as who
          from appointments a join company_terms t on t.id=a.appointment_term left join contacts ct on ct.id=a.contact_id where a.id = any($1::uuid[]) and t.category='first_call'`, [open]) : [];
        const answered = new Set<string>();
        const object = d.bindings["crm.object_discovery_call"];
        if (object && triage.length) {
          try {
            const keys = new Set(triage.map((r) => r.slot_key).filter((k): k is string => !!k));
            for (const r of await d.adapters.read.objectRecords(d.adapterCompany, object)) {
              const ext = String(r.properties.external_id ?? "").trim(), outcome = String(r.properties.outcome ?? "").trim().toLowerCase();
              if (keys.has(ext) && outcome && outcome !== "scheduled") answered.add(ext);
            }
          } catch (e) { ghl = ghl ?? String((e as Error).message).slice(0, 200); }
        }
        for (const e of days.values()) for (const r of triage) {
          if (!e.ledger.has(r.id)) continue;
          if (r.slot_key && answered.has(r.slot_key)) { e.ledger.delete(r.id); continue; }
          e.blank.push(r.who);
        }
      }
      const owed = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).filter(([, e]) => e.ledger.size || e.extra || e.dials)
        .map(([day, e]) => ({ day, label: label(day), when: day === eod.day ? "today" : label(day), url: day === eod.day ? eod.url : `${eod.url}?day=${day}`, today: day === eod.day, calls: e.ledger.size + e.dials, ghl_blank: e.extra, both: e.ledger.size + e.dials > 0 && e.extra > 0 }));
      const cutoff = overdueAfter === null ? null : d.now.setZone(tz).minus({ days: overdueAfter }).toISODate()!;
      const overdue = cutoff === null ? [] : [...days.entries()].filter(([day, e]) => e.blank.length && day <= cutoff).sort(([a], [b]) => a.localeCompare(b)).map(([day, e]) => ({ day, label: label(day), names: e.blank, url: day === eod.day ? eod.url : `${eod.url}?day=${day}` }));
      if (legacy) {
        // a copy edited before D88 reads its lines as text; it keeps getting them, word for word, until it is re-made from the template
        const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
        setPath(d.ctx, `vars.${node.into}`, owed.map((o) => `• <${o.url}|${o.when}>: ${o.calls ? plural(o.calls, "call") : ""}${o.both ? ", " : ""}${o.ghl_blank ? `${plural(o.ghl_blank, "call")} with no outcome in GHL` : ""}`).join("\n"));
        setPath(d.ctx, "vars.overdue_lines", overdue.map((o) => `• ${o.label}: ${o.names.join(", ")}`).join("\n"));
      } else setPath(d.ctx, `vars.${node.into}`, { days: owed, count: owed.length, overdue, overdue_count: overdue.length, overdue_after_days: overdueAfter, lookback_days: lookback });
      return { status: "ok", next, result: { days: owed.length, overdue: overdue.length, lookback_days: lookback, include_today: withToday, ...(legacy ? { shape: "lines (a copy from before D88)" } : {}), ...(ghl ? { ghl_unread: ghl } : {}) } };
    }
    case "report": {
      const kind = render(node.kind, d.ctx, env(d)) as ReportKind;
      if (!REPORT_KINDS.includes(kind)) return { status: "failed", error: `report kind must be one of ${REPORT_KINDS.join(", ")}, got "${kind}"` };
      const manual = (d.ctx.event as { manual?: boolean } | undefined)?.manual === true;
      // D88 (A8): a week or month just ended, or the one in progress (a manual run is always so far); the words are the layout's
      const toDate = manual || node.period === "in_progress";
      const period = periodFor(kind, d.now.setZone(d.company.timezone), toDate);
      const b = await buildReport(d.c, d.company, kind, period, { breakdowns: node.breakdowns, sections: node.sections, metrics: node.metrics, layout: node.layout, ctx: d.ctx, onDemand: manual, toDate, reads: d.probes?.ghl, now: d.now.toJSDate() });
      setPath(d.ctx, `vars.${node.into}`, { ...b.facts, body: b.body, period: b.period, numbers: b.numbers, id: b.id });
      return { status: "ok", next, result: { kind, period: b.period, report_id: b.id, ...(toDate ? { to_date: true } : {}), ...(node.layout ? {} : { worded_by: "the shipped template's layout (this copy has none)" }) } };
    }
    case "leaderboard": {
      // D94: the period is the step's, in plain words; the numbers are the registry's; the words of the post are the template's
      const words = render(node.period, d.ctx, env(d)).trim() || "last week";
      const { parsePeriod } = await import("./metric-registry");
      const period = parsePeriod(words, d.company.timezone, d.now);
      if (!period) return { status: "failed", error: `leaderboard: "${words}" is not a period I can read (try "last week", "this month", "last 30 days")` };
      const { formatLeaderboard, getLeaderboard, nothingOnBoard } = await import("./leaderboard");
      const lb = await getLeaderboard(d.c, d.company.id, { period, now: d.now.toJSDate() }, d.probes?.ghl);
      setPath(d.ctx, `vars.${node.into}`, { ...lb, body: formatLeaderboard(lb), nothing: nothingOnBoard(lb) });
      return { status: "ok", next, result: { period: { from: period.from, to: period.to }, closers: lb.closers.length, setters: lb.setters.length, ...(lb.cash_unavailable ? { cash: lb.cash_unavailable } : {}) } };
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
      if (d.replyTexts?.length) Object.assign(data, scrubReplyText(data, d.replyTexts, { cut: false }));   // D89: a fact never carries a reply's words
      // D87: `appointment` makes the fact about that booking of this person's (a call Jev read as closing, about the booking it lines up with); blank is the run's own
      let apptId = d.run.appointment_id, oppId = d.run.opportunity_id;
      const named = node.appointment !== undefined ? render(node.appointment, d.ctx, env(d)).trim() : "";
      if (named) {
        const a = await one<{ id: string; opportunity_id: string | null }>(d.c, "select id, opportunity_id from appointments where company_id=$1 and contact_id=$2 and id::text=$3", [d.company.id, d.run.contact_id, named]);
        if (!a) return { status: "failed", error: `record ${node.id}: ${named} is not one of this person's bookings` };
        apptId = a.id; oppId = a.opportunity_id ?? oppId;
      }
      if (!node.start) {
        await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: oppId, appointment_id: apptId, run_id: d.run.id, event_type: node.event, source: "engine", data });
        return { status: "ok", next, result: { event: node.event, ...data } };
      }
      // D87: `start` also starts the workflows listening for it (once: a retry finds the fact this step wrote and starts nothing again)
      const prior = await one<{ id: string }>(d.c, "select id::text from events where run_id=$1 and event_type=$2 and data->>'_node'=$3 limit 1", [d.run.id, node.event, node.id]);
      if (prior) return { status: "ok", next, result: { event: node.event, ...data, already: Number(prior.id) } };
      const ev = await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: oppId, appointment_id: apptId, run_id: d.run.id, event_type: node.event, source: "engine", data: { ...data, _node: node.id } });
      const started = await dispatchEvent(d.c, ev, { contact: { id: d.run.contact_id }, ...(apptId ? { appointment: { id: apptId } } : {}), ...(d.ctx.recording ? { recording: d.ctx.recording } : {}) });
      return { status: "ok", next, result: { event: node.event, ...data, ...(apptId ? { appointment_id: apptId } : {}), started } };
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

/**
 * Our ledger's opportunity: the run's, else the contact's open one. D85: won / lost / open with a lost reason, one
 * opportunity.won / opportunity.lost per change (the row and the event are one transaction, so a retry finds the status already
 * set and emits nothing again), dispatched like any event; `card` marks the contact's card on that board through pipelineCard.
 * Ours, never the CRM, so it runs in ghost too; the card follows the card step's own ghost rule.
 */
async function updateOpportunity(d: ExecDeps, node: Extract<Node, { type: "update_opportunity" }>, next: string | null): Promise<StepOutcome> {
  const r = (v: unknown) => (typeof v === "string" ? render(v, d.ctx, env(d)).trim() : v);
  const status = String(r(node.status ?? node.set.status ?? "") ?? "");
  if (status && !["open", "won", "lost"].includes(status)) return { status: "failed", error: `update_opportunity ${node.id}: status is open, won or lost, not "${status}"` };
  const oppId = d.run.opportunity_id ?? (d.run.contact_id ? (await one<{ id: string }>(d.c, "select id from opportunities where company_id=$1 and contact_id=$2 and status='open' order by opened_at desc limit 1", [d.company.id, d.run.contact_id]))?.id : undefined);
  if (!oppId) return { status: "failed", error: "update_opportunity with no opportunity on run" };
  const fields: Record<string, unknown> = {};
  for (const k of ["contract_value", "installments"]) { const v = r(node.set[k]); if (v !== undefined && v !== null && v !== "") fields[k] = v; }
  for (const [k, v] of Object.entries(fields)) await d.c.query(`update opportunities set ${k}=$2 where id=$1`, [oppId, v]);
  const cur = (await one<{ status: string }>(d.c, "select status from opportunities where id=$1", [oppId]))!;
  const reason = status === "lost" && node.lost_reason ? String(r(node.lost_reason) ?? "") : "";
  const term = reason ? await one<{ id: string; category: string; name: string }>(d.c, "select id, category, name from company_terms where company_id=$1 and domain='lost_reason' and active and (category=$2 or lower(name)=lower($2)) order by (category=$2) desc limit 1", [d.company.id, reason]) : null;
  const out: Record<string, unknown> = { opportunity: oppId, ...fields };
  if (status && status !== cur.status && node.from && !node.from.includes(cur.status as "open" | "won" | "lost")) Object.assign(out, { left: `the opportunity is ${cur.status}; this step changes it only from ${node.from.join(" or ")}` });
  else if (status && status !== cur.status) {
    await d.c.query("update opportunities set status=$2, won_at=case when $2='won' then now() else won_at end, lost_at=case when $2='lost' then now() when $2='open' then null else lost_at end, lost_reason_term=case when $2='lost' then $3::uuid else lost_reason_term end where id=$1", [oppId, status, term?.id ?? null]);
    Object.assign(out, { status: { from: cur.status, to: status } });
    if (status !== "open") {
      const ev = await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: oppId, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: `opportunity.${status}`, source: "engine",
        data: { by: "workflow", node: node.id, from: cur.status, ...(reason ? { lost_reason: term?.category ?? reason, ...(term ? {} : { lost_reason_unknown: true }) } : {}), ...(ghost(d) ? { ghost: true } : {}) } });
      out.started = await dispatchEvent(d.c, ev, { contact: { id: d.run.contact_id }, opportunity: { id: oppId, status } });
    }
  } else if (term) await d.c.query("update opportunities set lost_reason_term=$2 where id=$1 and status='lost'", [oppId, term.id]);
  if (reason) Object.assign(out, { lost_reason: term?.category ?? reason, ...(term ? {} : { lost_reason_unknown: `no lost reason "${reason}" in the company's terms; recorded on the event only` }) });
  if (!d.run.opportunity_id) { d.run.opportunity_id = oppId; await d.c.query("update runs set opportunity_id=$2 where id=$1", [d.run.id, oppId]); }
  d.ctx.opportunity = await one(d.c, "select id, status, contract_value, opened_at from opportunities where id=$1", [oppId]);
  if (!node.card) return { status: "ok", next, result: out };
  const card = await pipelineCard(d, { id: node.id, type: "pipeline_card", pipeline: node.card.pipeline, stage: node.card.stage, status: (status || undefined) as "open" | "won" | "lost" | undefined, if_missing: "skip", pick: status === "open" ? "latest" : "open", fields: [] }, next);
  if (card.status === "failed") return card;
  return { status: "ok", next, result: { ...out, card: "result" in card ? card.result ?? {} : {} } };
}

/** A card on a CRM board (D19, D41): the pipeline_card step, and the card an update_opportunity marks won or lost (D85). */
async function pipelineCard(d: ExecDeps, node: Extract<Node, { type: "pipeline_card" }>, next: string | null): Promise<StepOutcome> {
  const contact = d.ctx.contact as { ghl_contact_id?: string | null } | undefined;
  const pipelineId = render(node.pipeline, d.ctx, env(d));
  if (!d.run.contact_id) return { status: "failed", error: `pipeline_card ${node.id}: the run is not about a contact` };
  // D41: read the CRM first. A card made by anything else (a CRM workflow, a person) is adopted and moved, never duplicated; a CRM that cannot be read fails the step rather than guessing.
  // D66: the read at claim time already failed this tick: that is this step's failure (retried in place), not a second ask of a CRM that just said no
  if (d.cardsReadError) return { status: "failed", error: `pipeline_card ${node.id}: could not read the contact's cards in the CRM: ${d.cardsReadError}` };
  try { await syncCards(d.c, d.company, d.adapterCompany, d.adapters, d.run.contact_id, contact?.ghl_contact_id); }
  catch (e) { return { status: "failed", error: `pipeline_card ${node.id}: could not read the contact's cards in the CRM: ${(e as Error).message}` }; }
  // pick latest (D76): the board's most recent card whatever its status, so a changed answer can undo what the last one did (a lost card back to a stage)
  let card = node.pick === "latest" ? await latestCard(d.c, d.company.id, d.run.contact_id, pipelineId) : await pickCard(d.c, d.company.id, d.run.contact_id, pipelineId);
  // a step that closes the card finding none open: the board's latest card, already closed that way (a CRM workflow or a hand got there first), is this step's card; a second card is never made closed
  if (!card && node.pick !== "latest" && (node.status === "won" || node.status === "lost")) { const last = await latestCard(d.c, d.company.id, d.run.contact_id, pipelineId); if (last?.status === node.status) card = last; }
  // D66: on a retry, a hand that moved this board's card since the step first tried wins; the step does not move it back
  if (card && (d.run.step_attempt ?? 0) > 0) {
    const hand = await one<{ to_name: string | null; mover: string | null }>(d.c, `select data->>'to_name' as to_name, data->>'mover' as mover from events where company_id=$1 and contact_id=$2 and event_type='card.moved' and data->>'pipeline_id'=$3 and data->>'by'='crm'
      and occurred_at > (select min(started_at) from run_steps where run_id=$4 and node_id=$5) order by occurred_at desc limit 1`, [d.company.id, d.run.contact_id, pipelineId, d.run.id, node.id]);
    if (hand) return { status: "skipped", next, result: { kind: "noop", why: `moved by hand since this step first tried${hand.mover ? ` (${hand.mover}` : " ("}${hand.to_name ? `to ${hand.to_name})` : ")"}; a hand wins`, crm_card: card.ghl_opportunity_id } };
  }
  // D105: decided on the card the CRM just answered with, not the replica: a board's older cards reach the replica only when a step reads them
  if (card && node.from_stages) {
    const from = node.from_stages.map((s) => render(s, d.ctx, env(d)).trim()).filter(Boolean);
    if (!from.includes(card.ghl_stage_id)) { const board = boardOf(d.bindings, pipelineId); return { status: "skipped", next, result: { kind: "noop", why: `left where it is: the card is on ${stageWords(d.bindings, board, card.ghl_stage_id)}, a stage this step does not move from`, stage: card.ghl_stage_id, crm_card: card.ghl_opportunity_id } }; }
  }
  // stage and name are optional on an update: a step that only stamps fields leaves the card where it is
  // a stage binding left unbound (`{{crm.stage_x | default:}}`) leaves the card on its stage, like no stage at all
  const stageId = (node.stage ? render(node.stage, d.ctx, env(d)) : "") || (card?.ghl_stage_id ?? "");
  // G13: a person with no name in the CRM is named on the card by an address they do have, never " -- New"
  const who = d.ctx.contact as { name?: string | null; email?: string | null; phone?: string | null; ghl_contact_id?: string | null } | undefined;
  const nameCtx = who && !who.name ? { ...d.ctx, contact: { ...who, name: who.email ?? who.phone ?? who.ghl_contact_id ?? null } } : d.ctx;
  const name = node.keep_name && card ? card.name : node.name ? render(node.name, nameCtx, env(d)) : card?.name ?? render("{{contact.name}}", nameCtx, env(d));   // a card made without a name carries the person's
  const customFields = node.fields.map((f) => ({ id: render(f.id, d.ctx, env(d)), field_value: render(f.value, d.ctx, env(d)) })).filter((f) => f.id && f.field_value !== "");
  const assignedUserId = node.assign_to ? render(node.assign_to, d.ctx, env(d)) || undefined : undefined;
  const valueText = node.value ? render(node.value, d.ctx, env(d)).replace(/[$,\s]/g, "") : "";
  const monetaryValue = valueText ? Number(valueText) : undefined;
  if (monetaryValue !== undefined && !(Number.isFinite(monetaryValue) && monetaryValue >= 0)) return { status: "failed", error: `pipeline_card ${node.id}: value "${valueText}" is not an amount` };
  // no open card: a step with a stage makes one there (D41: a contact always has their cards); a status-only step has no stage to make one in, so there is nothing to mark
  if (!card && node.if_missing === "skip") return { status: "skipped", next, result: { kind: "noop", why: "no open card on this board to move; this step never creates one" } };
  if (!card && !node.stage) return { status: "skipped", next, result: { kind: "noop", why: `no open card on this board to mark ${node.status ?? "updated"}` } };
  if (!pipelineId || !stageId || !name) return { status: "failed", error: `pipeline_card ${node.id}: pipeline, stage or name unresolved` };
  const write = { pipelineId, stageId, name, status: node.status ?? ("open" as const), assignedUserId, customFields, ...(monetaryValue !== undefined ? { monetaryValue } : {}) };
  // D61: a card already where this step would put it (a second filing, a hand that moved it first) is left alone: no CRM write, no replica bump
  if (card && card.ghl_stage_id === stageId && card.name === name && (!node.status || node.status === card.status) && !customFields.length && !assignedUserId && monetaryValue === undefined) return { status: "skipped", next, result: { kind: "noop", why: "already there", stage: stageId, crm_card: card.ghl_opportunity_id } };
  // the pursuit the card belongs to: the run's, else the contact's open one, else a new one
  let oppId = d.run.opportunity_id ?? card?.opportunity_id ?? (await one<{ id: string }>(d.c, "select id from opportunities where company_id=$1 and contact_id=$2 and status='open' order by opened_at desc limit 1", [d.company.id, d.run.contact_id]))?.id;
  if (!oppId) {
    oppId = (await one<{ id: string }>(d.c, "insert into opportunities (company_id, contact_id, opened_by) values ($1,$2,$3) returning id", [d.company.id, d.run.contact_id, `workflow:${node.id}`]))!.id;
    await emitEvent(d.c, { company_id: d.company.id, contact_id: d.run.contact_id, opportunity_id: oppId, appointment_id: d.run.appointment_id, run_id: d.run.id, event_type: "opportunity.opened", source: "engine", data: { by: "workflow", node: node.id, ghost: ghost(d) } });
  }
  const ownerRow = assignedUserId ? await one<{ id: string }>(d.c, "select id from users where company_id=$1 and ghl_user_id=$2", [d.company.id, assignedUserId]) : undefined;
  // D69: a card the CRM answers is not there (deleted by a person, or with the contact) is gone from the replica too, and the step makes a fresh one, once (the create is claimed below)
  let goneCard: string | undefined;
  if (card && !ghost(d) && card.ghl_opportunity_id) {
    try { await d.adapters.write.updateOpportunity(d.adapterCompany, card.ghl_opportunity_id, write); }
    catch (e) {
      if (!cardGone(e)) throw e;
      await d.c.query("update pipeline_cards set status='gone', updated_at=now() where id=$1", [card.id]);
      goneCard = card.ghl_opportunity_id;
      if (node.if_missing === "skip" || !node.stage) { await refreshCardsCtx(d, pipelineId); return { status: "skipped", next, result: { kind: "noop", why: `the card is gone from the CRM (${goneCard}); this step never creates one` } }; }
    }
  }
  // the replica says what the CRM was told (a step with no status reopens a closed card it picked), stamped when the CRM took it, not when the run began: a snapshot from before this write is the past, never a hand
  if (card && !goneCard) {
    await d.c.query(`update pipeline_cards set name=$2, ghl_stage_id=$3, assigned_user_id=coalesce($4, assigned_user_id), status=${ghost(d) ? "coalesce($5, status)" : "$5"}, updated_at=clock_timestamp() where id=$1`, [card.id, name, stageId, ownerRow?.id ?? null, ghost(d) ? node.status ?? null : write.status]);
  } else {
    let ghlId: string | null = null;
    if (!ghost(d)) {
      if (!contact?.ghl_contact_id) return { status: "failed", error: "pipeline_card: contact has no CRM id yet" };
      // D66: the CRM was read first (D41) and has no card, so a pending claim means the earlier try never reached it; a done claim is a card the read missed (index lag) and is reused
      const cl = await claim(d, node, "card");
      if (!cl.fresh && cl.done && cl.external_id) ghlId = cl.external_id;
      else { ghlId = (await d.adapters.write.createOpportunity(d.adapterCompany, { ...write, contactId: contact.ghl_contact_id })).id; await done(d, node, "card", ghlId); }
    }
    await d.c.query("insert into pipeline_cards (company_id, opportunity_id, contact_id, ghl_opportunity_id, ghl_pipeline_id, ghl_stage_id, name, assigned_user_id, status, created_by_run, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()) on conflict (company_id, ghl_opportunity_id) do update set ghl_stage_id=excluded.ghl_stage_id, name=excluded.name, status=excluded.status, updated_at=clock_timestamp()", [d.company.id, oppId, d.run.contact_id, ghlId, pipelineId, stageId, name, ownerRow?.id ?? null, node.status ?? "open", d.run.id]);
  }
  if (!d.run.opportunity_id) { d.run.opportunity_id = oppId; await d.c.query("update runs set opportunity_id=$2 where id=$1", [d.run.id, oppId]); }
  d.ctx.opportunity = await one(d.c, "select id, status, contract_value, opened_at from opportunities where id=$1", [oppId]);
  await refreshCardsCtx(d, pipelineId);
  return { status: "ok", next, result: { ...(ghost(d) ? { ghost: true } : {}), card: card && !goneCard ? "moved" : "created", ...(goneCard ? { replaced_gone_card: goneCard } : {}), ...(card && !goneCard ? { from_stage: card.ghl_stage_id, crm_card: card.ghl_opportunity_id } : {}), name, stage: stageId, ...(node.status ? { card_status: node.status } : {}), ...(monetaryValue !== undefined ? { value: monetaryValue } : {}), fields: customFields } };
}

/** A crm_record step's `relate`, after the record is in `record.*`: each link both ends of which rendered. */
async function relate(d: ExecDeps, node: Extract<Node, { type: "crm_record" }>): Promise<string[]> {
  const related: string[] = [];
  for (const r of node.relate) {
    const assoc = render(r.association, d.ctx, env(d)), first = render(r.first, d.ctx, env(d)), second = render(r.second, d.ctx, env(d));
    if (!assoc || !first || !second) continue;
    if (!ghost(d)) await d.adapters.write.relateRecords(d.adapterCompany, assoc, first, second);
    related.push(`${first}→${second}`);
  }
  return related;
}

/**
 * D85: crm_record addressed by the CRM's own record id, for a record the engine did not make (booked before install, made by
 * a person or a CRM workflow). Always an update, so it is idempotent as a retry (the same values written again) and needs no
 * create claim; `clear` empties what this answer does not set; properties the object lacks were already dropped and are named.
 * Shadow writes nothing, not even our ledger's copy (we did not write the CRM, so the ledger must not say we did).
 */
/**
 * D223: after a create the CRM never answered, the record that create would have made, looked up by the key the step stamps on it
 * (`external_id`), and, when the step names the contact, only that contact's. One: it. None: it was never written. Anything else
 * is said, not guessed.
 */
async function lostCreate(d: ExecDeps, objectKey: string, key: string, properties: Record<string, unknown>): Promise<{ found: string; none?: undefined; why?: undefined } | { none: true; found?: undefined; why?: undefined } | { why: string; found?: undefined; none?: undefined }> {
  const stamped = typeof properties.external_id === "string" ? properties.external_id.trim() : "";
  if (!stamped || stamped !== key) return { why: "this record carries no key of its own to look it up by in the CRM" };
  let records: Awaited<ReturnType<ExecDeps["adapters"]["read"]["objectRecords"]>>;
  try { records = await d.adapters.read.objectRecords(d.adapterCompany, objectKey); } catch (e) { return { why: `the CRM could not be read to check: ${String((e as Error).message).slice(0, 120)}` }; }
  const contact = typeof properties.contact_id === "string" ? properties.contact_id.trim() : "";
  const hits = records.filter((r) => String(r.properties.external_id ?? "").trim() === key && (!contact || !String(r.properties.contact_id ?? "").trim() || String(r.properties.contact_id).trim() === contact));
  if (hits.length === 1) return { found: hits[0].id };
  if (!hits.length) return { none: true };
  return { why: `${hits.length} records in the CRM carry its key (${hits.map((h) => h.id).join(", ")}): which is it is a person's call` };
}

async function recordById(d: ExecDeps, node: Extract<Node, { type: "crm_record" }>, next: string | null, objectKey: string, key: string, ghlId: string, properties: Record<string, unknown>, cleared: Record<string, null>, owner: string | undefined, dropped: string[]): Promise<StepOutcome> {
  const write = { ...properties, ...cleared };
  if (!Object.keys(write).length) return { status: "skipped", next, result: { kind: "noop", why: "nothing to write: every value rendered empty", crm_id: ghlId } };
  const ours = await one<{ id: string; record_key: string }>(d.c, "select id, record_key from crm_records where company_id=$1 and object_key=$2 and ghl_record_id=$3 order by updated_at desc limit 1", [d.company.id, objectKey, ghlId]);
  const recordKey = ours?.record_key ?? (key || `ghl:${ghlId}`);
  let ourId: string | null = ours?.id ?? null;
  if (!ghost(d)) {
    await d.adapters.write.updateRecord(d.adapterCompany, objectKey, ghlId, write, owner);
    ourId = (await one<{ id: string }>(d.c, `insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, properties) values ($1,$2,$3,$4,$5,$6)
      on conflict (company_id, object_key, record_key) do update set ghl_record_id=excluded.ghl_record_id, properties=crm_records.properties || excluded.properties, updated_at=now() returning id`,
      [d.company.id, objectKey, recordKey, ghlId, d.run.contact_id, write]))!.id;
  }
  d.ctx.record = { id: ghlId, key: recordKey, object: objectKey, properties: write };
  const related = await relate(d, node);
  return { status: "ok", next, result: { ...(ghost(d) ? { ghost: true, would_update: write } : {}), record: "updated", by_crm_id: true, our_id: ourId, crm_id: ghlId, properties: write, related, ...(dropped.length ? { not_on_object: dropped } : {}) } };
}

type EventPin = { entered?: string; after_id?: number; since?: string | null; until?: string | null; consumed?: number[] };
/**
 * D85: an event about this person (or booking) or a deadline, whichever comes first. Parked, the run carries runs.wake_on_event =
 * the type, and emitEvent wakes it the moment one is written (dispatch.ts), the way an inbound text wakes a reply wait; the
 * deadline is next_run_at like any wait. What it counts: events after the step began (by id, so a clock skew never hides one), or at
 * or after `since`; never one this step already took (a loop back, or `resume`, does not see the same event twice).
 */
async function waitForEvent(d: ExecDeps, node: Extract<Node, { type: "wait_for_event" }>): Promise<StepOutcome> {
  const about = node.about === "appointment" ? d.run.appointment_id : d.run.contact_id;
  if (!about) return { status: "failed", error: `wait_for_event ${node.id}: the run is not about ${node.about === "appointment" ? "an appointment" : "a contact"}` };
  const key = `vars.__wait_for_event.${node.id}`;
  const pin: EventPin = { ...((resolvePath(d.ctx, key) as EventPin | undefined) ?? {}) };
  if (!pin.entered) {
    if (!(await one(d.c, "select 1 from event_types where name=$1", [node.event]))) return { status: "failed", error: `wait_for_event ${node.id}: "${node.event}" is not an event type the engine knows` };
    let since: DateTime | null = null;
    if (node.since) { const raw = render(node.since, d.ctx, env(d)); since = timeParam(raw, d.now); if (raw.trim() && !since) return { status: "failed", error: `wait_for_event ${node.id}: since "${raw}" is not a time` }; }
    let until: DateTime | null = null;
    if (node.until) { until = computeWaitUntil(node.until, { now: d.now, contactTz: contactTz(d), companyTz: d.company.timezone, ctx: d.ctx }).at; if (node.respect_send_window) until = deferIntoWindow(until, contactTz(d), d.company.send_window_start, d.company.send_window_end).at; }
    Object.assign(pin, { entered: d.now.toISO(), after_id: Number((await one<{ id: string }>(d.c, "select coalesce(max(id),0)::text as id from events"))!.id), since: since?.toISO() ?? null, until: until?.toISO() ?? null });
  }
  const consumed = pin.consumed ?? [];
  const rows = await many<{ id: string; event_type: string; occurred_at: Date; source: string; data: Record<string, unknown>; appointment_id: string | null }>(d.c,
    `select id::text, event_type, occurred_at, source, data, appointment_id from events where company_id=$1 and event_type=$2 and ${node.about === "appointment" ? "appointment_id" : "contact_id"}=$3
      and (case when $4::timestamptz is not null then occurred_at >= $4 else (id > $5 or occurred_at >= $6) end) and not (id = any($7::bigint[])) order by occurred_at, id limit 200`,
    [d.company.id, node.event, about, pin.since ?? null, pin.after_id ?? 0, pin.entered, consumed]);
  const prior = resolvePath(d.ctx, `vars.${node.into}`);
  const leave = async (into: unknown, label: "event" | "until", result: Record<string, unknown>): Promise<StepOutcome> => {
    setPath(d.ctx, `vars.${node.into}`, into); setPath(d.ctx, key, { consumed: pin.consumed ?? consumed });
    await d.c.query("update runs set wake_on_event=null where id=$1", [d.run.id]);
    return { status: "ok", next: labelledEdge(d.edgesFrom(node.id), label)?.to ?? null, result };
  };
  for (const ev of rows) {
    const appt = ev.appointment_id ? await one<Record<string, unknown>>(d.c, `select ${APPOINTMENT_FACTS} from appointments a ${APPOINTMENT_JOINS} where a.id=$1`, [ev.appointment_id]) : null;
    const found = { matched: true, id: Number(ev.id), type: ev.event_type, at: ev.occurred_at.toISOString(), source: ev.source, data: ev.data, ...(appt ? { appointment: appointmentRow(appt) } : {}) };
    if (node.match) { setPath(d.ctx, `vars.${node.into}`, found); const ok = evaluate(node.match, { ...d.ctx, data: ev.data }); setPath(d.ctx, `vars.${node.into}`, prior); if (!ok) continue; }
    pin.consumed = [...consumed, found.id];
    return leave(found, "event", { event: found.type, event_id: found.id, at: found.at });
  }
  if (pin.until && DateTime.fromISO(pin.until) <= d.now) return leave({ matched: false }, "until", { timed_out: true, until: pin.until });
  setPath(d.ctx, key, pin);
  await d.c.query("update runs set wake_on_event=$2 where id=$1", [d.run.id, node.event]);
  return { status: "waiting", until: pin.until ? DateTime.fromISO(pin.until) : undefined, stay: true, result: { waiting_for: node.event, about: node.about, until: pin.until ?? null, ...(pin.since ? { since: pin.since } : {}) } };
}

/**
 * D73's one-to-one rule, for a booking whose record the engine never wrote (booked before install, or while in ghost):
 * the record carrying the booking's own id, else the one of this person (any of their GHL ids) starting the same minute
 * (with no readable time, the same day). Never by name; a record already tied to another booking is not a candidate.
 */
/** The object's own property keys and each one's type, read from the CRM at most every ten minutes per company; null when it cannot be read (the write goes as is). */
const objectFieldCache = new Map<string, { at: number; fields: Map<string, string | undefined> }>();
async function objectFields(d: ExecDeps, objectKey: string): Promise<Map<string, string | undefined> | null> {
  if (!objectKey.startsWith("custom_objects.") || !d.adapters.read.objectFields) return null;
  const k = `${d.company.id}:${objectKey}`, hit = objectFieldCache.get(k);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.fields;
  try { const fields = new Map((await d.adapters.read.objectFields(d.adapterCompany, objectKey)).map((f) => [f.key, f.type] as const)); if (!fields.size) return null; objectFieldCache.set(k, { at: Date.now(), fields }); return fields; }
  catch { return null; }
}

async function bookingRecord(d: ExecDeps, objectKey: string): Promise<{ id: string } | { why: string }> {
  const appt = d.ctx.appointment as { external_id?: string; slot_key?: string; starts_at?: string } | undefined;
  if (!d.run.appointment_id || !appt?.starts_at) return { why: "the run has no booking to match it by" };
  // a record carries the slot key it was written under (D120: a Calendly re-make keeps it while the event id moves on)
  const keys = new Set([appt.slot_key, appt.external_id].filter((k): k is string => !!k));
  const ids = new Set((await many<{ v: string }>(d.c, "select ghl_contact_id as v from contacts where id=$1 and ghl_contact_id is not null union select value from contact_identifiers where contact_id=$1 and kind='ghl_contact' and retired_at is null", [d.run.contact_id])).map((r) => r.v));
  const taken = new Set((await many<{ v: string }>(d.c, "select ghl_record_id as v from crm_records where company_id=$1 and object_key=$2 and ghl_record_id is not null", [d.company.id, objectKey])).map((r) => r.v));
  const recs = (await d.adapters.read.objectRecords(d.adapterCompany, objectKey)).filter((r) => !taken.has(r.id));
  const tz = d.company.timezone, start = DateTime.fromISO(appt.starts_at).setZone(tz);
  const byExt = recs.filter((r) => keys.has(String(r.properties.external_id ?? "")));
  const byPerson = recs.filter((r) => {
    if (!ids.has(String(r.properties.contact_id ?? "").trim())) return false;
    const cd = String(r.properties.call_date ?? ""), day = /^\d{4}-\d{2}-\d{2}$/.test(cd) ? DateTime.fromISO(cd, { zone: tz }) : null;
    const at = callTime(r.properties.scheduled_at, day, tz);
    return at ? at.startOf("minute").toMillis() === start.startOf("minute").toMillis() : !!day && day.toISODate() === start.toISODate();
  });
  const hits = byExt.length ? byExt : byPerson;
  if (hits.length === 1) return { id: hits[0].id };
  return { why: hits.length ? `${hits.length} records match this booking; a person picks one` : "none carries this booking's id or this person at this start time" };
}

/** `cards.<board>` as buildContext reads it, again after a card step, so a later step in the same tick (Call booked's Sales Call record) names the card this run just made or moved. */
async function refreshCardsCtx(d: ExecDeps, pipelineId: string): Promise<void> {
  const board = Object.entries(d.bindings).find(([k, v]) => k.startsWith("crm.pipeline_") && v === pipelineId)?.[0].slice("crm.pipeline_".length);
  if (!board) return;
  const card = await one<{ ghl_opportunity_id: string | null; ghl_stage_id: string; name: string; owner_name: string | null; owner_ghl: string | null }>(d.c, "select p.ghl_opportunity_id, p.ghl_stage_id, p.name, u.name as owner_name, u.ghl_user_id as owner_ghl from pipeline_cards p left join users u on u.id=p.assigned_user_id where p.company_id=$1 and p.contact_id=$2 and p.ghl_pipeline_id=$3 and p.status='open' order by p.created_at desc limit 1", [d.company.id, d.run.contact_id, pipelineId]);
  const cards = (d.ctx.cards ??= {}) as Record<string, unknown>;
  cards[board] = card ? { id: card.ghl_opportunity_id ?? "", stage: card.ghl_stage_id, name: card.name, owner: card.owner_name ? { name: card.owner_name, first_name: card.owner_name.split(" ")[0], ghl_user_id: card.owner_ghl } : undefined } : undefined;
}

export /** Every string inside a JSON body is a template; the shape stays. */
function deepRender(v: unknown, ctx: Record<string, unknown>, e: ReturnType<typeof env>): unknown {
  if (typeof v === "string") { const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(v); if (whole) { const got = resolveExpr(whole[1], ctx, e); return got === undefined ? "" : got; } return render(v, ctx, e); }   // one whole expression keeps its type: a boolean stays a boolean, a filtered number a number
  if (Array.isArray(v)) return v.map((x) => deepRender(x, ctx, e));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, deepRender(x, ctx, e)]));
  return v;
}
/** `base` with `value` at `keys` (a copy; objects on the way are kept, anything else is replaced). */
function deepSet(base: unknown, keys: string[], value: unknown): unknown {
  if (!keys.length) return value;
  const o = base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
  o[keys[0]] = deepSet(o[keys[0]], keys.slice(1), value);
  return o;
}
export function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split("."); let cur = obj;
  for (const p of parts.slice(0, -1)) { if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {}; cur = cur[p] as Record<string, unknown>; }
  cur[parts[parts.length - 1]] = value;
}
