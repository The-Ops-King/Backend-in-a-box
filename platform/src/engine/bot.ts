import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { asCompany, asOperator, many, one } from "@/db/client";
import type { Adapters, BotMessage, BotToolDef } from "@/adapters/types";
import { decrypt } from "./crypto";
import { liveProbes, type HealthProbes } from "./health";
import { liveGhlReads, type GhlReads } from "@/adapters/ghl/metrics";
import { checkQuery, runQuery } from "./query";
import {
  GROUP_BYS, METRIC_NAMES, MetricError, catalogue, getAvailability, getCloses, getMetric, parsePeriod, previousPeriod,
  type Availability, type ClosesList, type Filters, type GroupBy, type MetricResult, type Period,
} from "./metric-registry";
import { ESCALATE_PING, ESCALATE_UNSURE, fmt, formatAnswer, formatAvailability, formatCloses, formatCombined, formatSummary, helpText } from "./bot-format";

/**
 * The Slack bot (D70). Shortcuts are slash commands answered from the metric registry with no model in the way; anything
 * else (a mention, a DM, a reply in a thread the bot is in) goes to a model whose only powers are the registry's tools.
 * The model picks what to compute; the numbers come from the tools and the message is rendered by our formatter. When it
 * cannot tell what is asked it asks; when it cannot get the answer it says so and pings the company's escalation person.
 * "No answer beats a wrong answer."
 */
/** `ghl`: the live CRM reads behind people, deals and calls (D73); a fake in tests. */
export type BotDeps = { adapters: Adapters; probes?: HealthProbes; ghl?: GhlReads; now?: DateTime; respond?: (responseUrl: string, body: Record<string, unknown>) => Promise<void> };
export type SlackMessage = { eventId: string; teamId?: string; type: "app_mention" | "message"; channel: string; channelType?: string; user?: string; botId?: string; subtype?: string; text: string; ts: string; threadTs?: string };
export type Turn = { role: "user" | "bot"; text: string; user?: string; kind?: "answer" | "clarify" | "escalate"; at: string };
type Asker = { id: string; name: string; role: string } | null;
type Ctx = { companyId: string; name: string; tz: string; token: string; teamId: string; botUserId: string | null; escalateTo: string | null; escalateName: string; apiKey: string | null; sourceField: string | null };

const DM_MEMORY_MIN = 30;
const MAX_TURNS = 6;
const KEEP_TURNS = 20;

async function loadCtx(c: PoolClient, companyId: string): Promise<Ctx | null> {
  const co = await one<{ name: string; timezone: string }>(c, "select name, timezone from companies where id=$1", [companyId]);
  const conn = await one<{ team_id: string; bot_token: Buffer; bot_user_id: string | null }>(c, "select team_id, bot_token, bot_user_id from slack_connections where company_id=$1", [companyId]);
  if (!co || !conn) return null;
  const b = new Map((await many<{ key: string; kind: string; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1 and key in ('bot.escalate_to','bot.escalate_name','secret.anthropic_key','crm.field_contact_lead_source')", [companyId]))
    .map((r) => [r.key, r.kind === "secret" ? decrypt(r.value) : r.value.toString("utf8")]));
  const escalateTo = b.get("bot.escalate_to") || null;
  const who = escalateTo ? await one<{ name: string }>(c, "select name from users where company_id=$1 and slack_user_id=$2 limit 1", [companyId, escalateTo]) : null;
  return { companyId, name: co.name, tz: co.timezone, token: decrypt(conn.bot_token), teamId: conn.team_id, botUserId: conn.bot_user_id, escalateTo,
    escalateName: who?.name.split(" ")[0] ?? b.get("bot.escalate_name") ?? "the team", apiKey: b.get("secret.anthropic_key") ?? process.env.ANTHROPIC_API_KEY ?? null, sourceField: b.get("crm.field_contact_lead_source") ?? null };
}

/** The asker as an engine user: by Slack id, else by the email Slack has for them (remembered once found). */
async function resolveAsker(deps: BotDeps, ctx: Ctx, slackUser: string): Promise<Asker> {
  const by = await asOperator((c) => one<{ id: string; name: string; role: string }>(c, "select id::text as id, name, role from users where company_id=$1 and slack_user_id=$2 and active limit 1", [ctx.companyId, slackUser]));
  if (by) return by;
  const email = deps.adapters.notifier.userEmail ? await deps.adapters.notifier.userEmail(ctx.token, slackUser).catch(() => null) : null;
  if (!email) return null;
  return asOperator(async (c) => {
    const u = await one<{ id: string; name: string; role: string }>(c, "select id::text as id, name, role from users where company_id=$1 and lower(email)=$2 and active limit 1", [ctx.companyId, email.toLowerCase()]);
    if (u) await c.query("update users set slack_user_id=$2 where id=$1", [u.id, slackUser]);
    return u ?? null;
  });
}

// ---- conversation memory ---------------------------------------------------------------------------------------------
async function loadThread(companyId: string, channel: string, threadTs: string, freshMinutes?: number): Promise<Turn[] | null> {
  const row = await asOperator((c) => one<{ messages: Turn[]; updated_at: Date }>(c, "select messages, updated_at from bot_threads where company_id=$1 and channel=$2 and thread_ts=$3", [companyId, channel, threadTs]));
  if (!row) return null;
  if (freshMinutes && Date.now() - row.updated_at.getTime() > freshMinutes * 60_000) return [];
  return row.messages;
}
async function saveThread(companyId: string, channel: string, threadTs: string, askedBy: string | undefined, turns: Turn[], replace = false): Promise<void> {
  await asOperator((c) => c.query(`insert into bot_threads (company_id, channel, thread_ts, asked_by, messages) values ($1,$2,$3,$4,$5::jsonb)
    on conflict (company_id, channel, thread_ts) do update set messages=${replace ? "excluded.messages" : "(bot_threads.messages || excluded.messages)"}, updated_at=now()`, [companyId, channel, threadTs, askedBy ?? null, JSON.stringify(turns)]));
  await asOperator((c) => c.query(`update bot_threads set messages=(select coalesce(jsonb_agg(m order by n), '[]'::jsonb) from (select m, n from jsonb_array_elements(messages) with ordinality as t(m, n) order by n desc limit ${KEEP_TURNS}) x) where company_id=$1 and channel=$2 and thread_ts=$3 and jsonb_array_length(messages) > ${KEEP_TURNS}`, [companyId, channel, threadTs]));
}

// ---- the events door: mentions, DMs, replies in a thread the bot is in ------------------------------------------------
export type MessageOutcome = { ignored: string } | { answered: "answer" | "clarify" | "escalate"; channel: string; thread?: string };

export async function handleMessage(deps: BotDeps, companyId: string, ev: SlackMessage): Promise<MessageOutcome> {
  const ctx = await asOperator((c) => loadCtx(c, companyId));
  if (!ctx) return { ignored: "no Slack connection" };
  if (ev.teamId && ev.teamId !== ctx.teamId) return { ignored: "another workspace" };
  if (ev.botId || (ctx.botUserId && ev.user === ctx.botUserId)) return { ignored: "own message" };
  if (ev.subtype && !["thread_broadcast", "file_share"].includes(ev.subtype)) return { ignored: `message ${ev.subtype}` };
  if (!ev.user) return { ignored: "no user" };
  const mentionsBot = !!ctx.botUserId && new RegExp(`<@${ctx.botUserId}(\\|[^>]*)?>`).test(ev.text);
  const question = ev.text.replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, (m) => (ctx.botUserId && m.startsWith(`<@${ctx.botUserId}`) ? "" : m)).trim();
  const dm = ev.channelType === "im" || (ev.type === "app_mention" && ev.channel.startsWith("D"));
  let replyThread: string | undefined, key: string, history: Turn[];
  if (ev.type === "app_mention") {
    if (dm) return { ignored: "a DM arrives as message.im" };
    replyThread = ev.threadTs ?? ev.ts; key = replyThread;
    history = (await loadThread(companyId, ev.channel, key)) ?? [];
  } else if (ev.channelType === "im") {
    replyThread = ev.threadTs; key = ev.threadTs ?? "dm";
    history = (await loadThread(companyId, ev.channel, key, ev.threadTs ? undefined : DM_MEMORY_MIN)) ?? [];
  } else {
    // a channel message: only a reply in a thread the bot is already in, not addressed to someone else, while the thread is still the bot's
    if (mentionsBot) return { ignored: "a mention arrives as app_mention" };
    if (!ev.threadTs) return { ignored: "not in a thread" };
    const t = await loadThread(companyId, ev.channel, ev.threadTs);
    if (!t) return { ignored: "a thread the bot is not in" };
    if (/<@[A-Z0-9]+/.test(ev.text)) return { ignored: "addressed to someone else" };
    if ([...t].reverse().find((m) => m.role === "bot")?.kind === "escalate") return { ignored: "escalated: the thread is the team's now" };
    replyThread = ev.threadTs; key = ev.threadTs; history = t;
  }
  if (!question) return { ignored: "empty" };
  await deps.adapters.notifier.react(ctx.token, ev.channel, ev.ts, "eyes").catch(() => false);
  const asker = await resolveAsker(deps, ctx, ev.user);
  const out = await converse(deps, ctx, { question, history, asker, slackUser: ev.user });
  await deliver(deps, ctx, ev.channel, replyThread, out);
  const at = new Date().toISOString();
  await saveThread(companyId, ev.channel, key, ev.user, [{ role: "user", text: question, user: ev.user, at }, { role: "bot", text: out.text, kind: out.kind, at }], history.length === 0);   // a DM gone quiet starts over
  await deps.adapters.notifier.unreact(ctx.token, ev.channel, ev.ts, "eyes").catch(() => false);
  return { answered: out.kind, channel: ev.channel, thread: replyThread };
}

type Out = { kind: "answer" | "clarify" | "escalate"; text: string; reason?: string };
/** Posts the outcome: one message, or for an escalation the two the owner asked for, the second a real mention. */
async function deliver(deps: BotDeps, ctx: Ctx, channel: string, thread: string | undefined, out: Out): Promise<void> {
  const post = (text: string) => deps.adapters.notifier.post(ctx.token, channel, text, undefined, thread);
  if (out.kind !== "escalate") { await post(out.text); return; }
  await post(out.text);
  if (ctx.escalateTo) await post(ESCALATE_PING(ctx.escalateTo));
  await asOperator((c) => c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'bot.escalated','slack',$2,$3)", [ctx.companyId, channel, { thread, reason: out.reason ?? null, pinged: ctx.escalateTo }]));
}
/** `failed`: a live source that did not answer; it is named, never papered over. */
const escalation = (ctx: Ctx, reason: string, failed?: string[]): Out => ({ kind: "escalate", reason,
  text: `${failed?.length ? `I couldn't get a live read (${failed.join("; ")}). ` : ""}${ctx.escalateTo ? ESCALATE_UNSURE(ctx.escalateName) : "I'm not sure how to get that information, and no one is set up for me to ping (`bot.escalate_to`)."}` });

// ---- the model ---------------------------------------------------------------------------------------------------------
export const BOT_TOOLS: BotToolDef[] = [
  { name: "get_metric", description: "Compute one named metric over a period. People (leads, MQLs, DQs), deals (closes, revenue) and calls (calls booked, shows, no-shows, cancellations, show rate) are read live from GHL, the source of truth; bookings made, cash and dials come from the engine's ledger. Returns the value (and rows when split; for MQLs how leads answered the work-situation question, for show rate every due call by outcome). An error that starts with \"GHL\" means GHL could not be read: say so, never substitute another number. The only source of numbers besides get_availability and run_readonly_query.",
    input_schema: { type: "object", additionalProperties: false, required: ["metric", "period", "group_by", "filters"], properties: {
      metric: { type: "string", enum: METRIC_NAMES },
      period: { type: "string", description: "The asker's period in plain words exactly as meant: 'this month', 'last month', 'this week', 'last week', 'today', 'yesterday', 'last 30 days', 'September', 'Sep 1 to Sep 15', '2026-09-01..2026-09-30'." },
      group_by: { type: "string", enum: [...GROUP_BYS, "none"] },
      filters: { type: "object", additionalProperties: false, required: ["closer", "setter", "source", "me"], properties: {
        closer: { type: "string", description: "A closer's name from the roster, or empty" }, setter: { type: "string", description: "A setter's name from the roster, or empty" },
        source: { type: "string", description: "A lead source exactly as the data names it, or empty" }, me: { type: "boolean", description: "true when the asker said my / me / I: the number is filtered to the asker" } } } } } },
  { name: "list_closes", description: "List every close in a period, newest first: the person, the closer credited, the day it was won (read live from GHL's Closer pipeline, the same people the closes metric counts). Use it for \"who closed\" / \"which deals\" questions.",
    input_schema: { type: "object", additionalProperties: false, required: ["period", "closer"], properties: {
      period: { type: "string", description: "The asker's period in plain words, as for get_metric" }, closer: { type: "string", description: "A closer's name from the roster, or empty" } } } },
  { name: "get_availability", description: "Open bookable calendar slots for the next days (at most 7), per day and per closer, read live from the booking calendars.",
    input_schema: { type: "object", additionalProperties: false, required: ["days"], properties: { days: { type: "integer", description: "1 to 7; 7 when not said" } } } },
  { name: "run_readonly_query", description: "Last resort, only when no metric fits (for example a list of individual people): one read-only SELECT over the company's own tables. The answer is labelled ad hoc.",
    input_schema: { type: "object", additionalProperties: false, required: ["sql", "why"], properties: { sql: { type: "string" }, why: { type: "string", description: "What the query returns, in plain words, shown to the asker" } } } },
  { name: "ask_clarification", description: "Ask the asker one short question when the period, the person, or a term is missing or could mean more than one thing. Ends your turn.",
    input_schema: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string" } } } },
  { name: "cannot_answer", description: "Say the tools cannot answer this (no metric or table holds it, or the data could not be read). Ends your turn; the team is pinged.",
    input_schema: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string" } } } },
  { name: "reply", description: "Finish: show these tool results to the asker. The message is rendered from the results; `note` is at most one short sentence of interpretation, with no number that is not in the results, or empty.",
    input_schema: { type: "object", additionalProperties: false, required: ["result_ids", "note"], properties: { result_ids: { type: "array", items: { type: "string" } }, note: { type: "string" } } } },
];

export const BOT_SYSTEM = `You answer a sales team's questions about their own numbers in Slack. Correct before clever: no answer beats a wrong answer.

How you work:
- Numbers come only from your tools. You never write a number yourself: the message the asker sees is rendered from the tool results you pick with \`reply\`. Your optional note is one short sentence and may only repeat numbers that are in those results.
- Use get_metric for anything the metric list covers. Split with group_by when the asker wants a breakdown ("by closer", "by source", "per day"). Several calls are fine; then \`reply\` with the ids you want shown, most important first.
- The period: pass the asker's own words. If the question has no period and the context gives no default, call ask_clarification for the period. Never assume one. "This month" means the calendar month so far in the company's time zone.
- "My", "me", "I": set filters.me = true. If the context says the asker is not on the roster, ask who they are in the CRM.
- A person named in the question must match the roster in the context; if the name is unclear or matches two people, ask.
- GHL is the truth for people, deals and calls. Those numbers are read live from GHL; if GHL cannot be read the tool says so and you call cannot_answer with that reason. Never answer them from run_readonly_query over the ledger.
- Ambiguous or unknown terms: ask. There are exactly two kinds of DQ: a marketing DQ (marketing_dqs; also called a DQL: filtered out before a sales call on financial signals, from the work-situation answer) and a sales DQ (sales_dqs: got on the call and was disqualified for any reason). "DQ" alone: ask which, unless the asker made it clear.
- Glossary: a lead is a person who entered their information (a GHL contact, by the date GHL added them). An MQL is a lead whose answer to the work-situation question ("What best describes your current work situation?") meets the employment standard; "Currently between jobs" or "Employed part-time" is a marketing DQ; a blank answer is not an MQL. A sales DQ is a Sales Call in GHL with a DQ disposition. Calls booked (for show rate) are the Sales Call records in GHL whose call time has passed in the period, cancellations included; show rate = shows ÷ those calls; a call with no outcome filed is "missing from EOD disposition". A close is a new person we collected cash from: a won card on the Closer pipeline (the setter pipeline's won is a show, not a sale); close rate = closes ÷ shows. Test contacts never count.
- Answers show numbers and the period, not definitions. When the asker asks what a number means, get the metric and reply with a one-sentence note restating its definition from the list below, with no number of your own.
- Calendar availability: get_availability.
- run_readonly_query only when no metric fits, e.g. a list of individual people. Write one SELECT against the tables described in the context; describe in \`why\` what it returns.
- If the tools cannot answer — no metric or table holds it, a tool keeps failing, or you would have to guess — call cannot_answer with the reason.
- End every turn with exactly one of reply, ask_clarification or cannot_answer.

Metrics (name: label — definition (split by)):
${catalogue()}`;

const SCHEMA_HINT = `Tables for run_readonly_query (rows are already limited to this company; harness rows have appointments.source='test' or raw->>'simulated'; the team's test contacts are tagged sys-test or have an email on a test domain — leave them out):
contacts(id, first_name, last_name, tags text[], ghl_added_at timestamptz = arrival, ghl_fields jsonb, merged_into uuid — skip rows where it is set)
appointments(id, contact_id, assigned_user_id → users.id = closer, starts_at, booked_at, status in new|confirmed|cancelled|showed|noshow|invalid, outcome_term → company_terms, call_outcome_term → company_terms, set_by text = setter name, tracking jsonb utm_*)
company_terms(id, domain appointment_outcome|call_outcome|appointment_type, category showed|noshow|cancelled|rescheduled|closed|deposit|follow_up|lost|unqualified|…, name)
payments(id, contact_id, amount numeric (refunds negative), status succeeded|failed|refunded, paid_at)
opportunities(id, contact_id, status open|won|lost, won_at, contract_value)
users(id, name, role closer|setter|owner|manager|staff)
recordings(id, contact_id, provider, started_at, raw jsonb)`;

type Held = { id: string; kind: "metric"; r: MetricResult } | { id: string; kind: "availability"; a: Availability } | { id: string; kind: "closes"; k: ClosesList } | { id: string; kind: "adhoc"; why: string; columns: string[]; rows: unknown[][]; truncated: boolean };

async function contextText(ctx: Ctx, asker: Asker, slackUser: string, now: DateTime): Promise<string> {
  const roster = await asCompany(ctx.companyId, (c) => many<{ name: string; role: string }>(c, "select name, role from users where company_id=$1 and active and role in ('closer','setter','owner','manager') order by role, name", [ctx.companyId]));
  const local = now.setZone(ctx.tz);
  return [
    `Company: ${ctx.name}. Time zone: ${ctx.tz}. Today is ${local.toFormat("cccc, LLLL d, yyyy")} (${local.toISODate()}).`,
    asker ? `Asker: ${asker.name} (${asker.role}).` : `Asker: Slack user ${slackUser}, not on the roster (no CRM user has their Slack id or email); "my" questions need them to say who they are.`,
    `Roster: ${roster.map((u) => `${u.name} (${u.role})`).join(", ") || "none"}.`,
    `A person's lead source is the CRM field ${ctx.sourceField ? `contacts.ghl_fields->>'${ctx.sourceField}'` : "(none bound)"}, else the latest booking's tracking->>'utm_source', else 'unknown'.`,
    SCHEMA_HINT,
  ].join("\n");
}

/** Runs the tool loop for one question. Never throws: any failure is an escalation. */
export async function converse(deps: BotDeps, ctx: Ctx, q: { question: string; history: Turn[]; asker: Asker; slackUser: string }): Promise<Out> {
  const model = deps.adapters.bot;
  if (!model || !ctx.apiKey) return escalation(ctx, "no AI key for the bot");
  const now = deps.now ?? DateTime.now();
  const held: Held[] = [];
  const failed: string[] = [];
  const up = (reason: string) => escalation(ctx, reason, failed);
  try {
    const messages: BotMessage[] = [];
    for (const t of q.history) messages.push({ role: t.role === "user" ? "user" : "assistant", content: t.text || "(empty)" });
    if (messages[0]?.role === "assistant") messages.unshift({ role: "user", content: "(earlier in this thread)" });
    messages.push({ role: "user", content: `${await contextText(ctx, q.asker, q.slackUser, now)}\n\nQuestion: ${q.question}` });
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const r = await model.next(ctx.apiKey, { system: BOT_SYSTEM, tools: BOT_TOOLS, messages });
      if (r.stop === "refusal") return up("the model declined");
      messages.push({ role: "assistant", content: r.content });
      if (!r.calls.length) return held.length ? render(held, held.map((h) => h.id), "") : up(`the model ended without a tool${r.text ? `: ${r.text.slice(0, 200)}` : ""}`);
      const results: unknown[] = [];
      // data first, so a reply in the same turn can name what was just computed
      for (const call of r.calls.filter((x) => !["ask_clarification", "cannot_answer", "reply"].includes(x.name))) {
        const res = await runTool(deps, ctx, q.asker, call.name, call.input, held, now);
        if (res.error && (call.name === "get_availability" || /^GHL /.test(res.content))) failed.push(res.content);
        results.push({ type: "tool_result", tool_use_id: call.id, content: res.content, ...(res.error ? { is_error: true } : {}) });
      }
      const end = r.calls.find((x) => ["ask_clarification", "cannot_answer", "reply"].includes(x.name));
      if (end?.name === "ask_clarification") return { kind: "clarify", text: String(end.input.question ?? "").trim() || "Can you say a bit more about what you need, and for which period?" };
      if (end?.name === "cannot_answer") return up(String(end.input.reason ?? ""));
      if (end?.name === "reply") {
        const ids = Array.isArray(end.input.result_ids) ? end.input.result_ids.map(String) : [];
        return held.length ? render(held, ids.length ? ids : held.map((h) => h.id), String(end.input.note ?? "")) : up("replied with no results");
      }
      messages.push({ role: "user", content: results });
    }
    return up(`no answer after ${MAX_TURNS} steps`);
  } catch (e) {
    return up(`error: ${String((e as Error).message).slice(0, 300)}`);
  }
}

async function runTool(deps: BotDeps, ctx: Ctx, asker: Asker, name: string, input: Record<string, unknown>, held: Held[], now: DateTime): Promise<{ content: string; error?: boolean }> {
  const id = `r${held.length + 1}`;
  const err = (m: string) => ({ content: m, error: true });
  try {
    if (name === "get_metric") {
      const metric = String(input.metric ?? "");
      const period = parsePeriod(String(input.period ?? ""), ctx.tz, now);
      if (!period) return err(`"${input.period}" is not a period I can read. Ask the asker for the period, or pass e.g. "this month", "last week", "Sep 1 to Sep 15".`);
      const f = (input.filters ?? {}) as Record<string, unknown>;
      if (f.me && !asker) return err("The asker is not on the roster, so \"my\" cannot be resolved. Ask who they are in the CRM.");
      const filters: Filters = { closer: str(f.closer), setter: str(f.setter), source: str(f.source), userId: f.me && asker ? asker.id : undefined };
      const groupBy = input.group_by && input.group_by !== "none" ? (String(input.group_by) as GroupBy) : undefined;
      const r = await asCompany(ctx.companyId, (c) => getMetric(c, ctx.companyId, { metric, period, groupBy, filters, now: now.toJSDate() }, deps.ghl ?? liveGhlReads));
      held.push({ id, kind: "metric", r });
      return { content: JSON.stringify({ id, metric: r.metric, label: r.label, source: r.source, period: r.period_label, value: r.value, display: fmt(r.unit, r.value), numerator: r.numerator, denominator: r.denominator, filters: r.filters,
        qualification: r.qualification, shows_breakdown: r.shows_breakdown, rows: r.rows?.slice(0, 40).map((x) => ({ label: x.label, display: fmt(r.unit, x.value), numerator: x.numerator, denominator: x.denominator })) }) };
    }
    if (name === "list_closes") {
      const period = parsePeriod(String(input.period ?? ""), ctx.tz, now);
      if (!period) return err(`"${input.period}" is not a period I can read. Ask the asker for the period, or pass e.g. "this month", "last week", "Sep 1 to Sep 15".`);
      const k = await asCompany(ctx.companyId, (c) => getCloses(c, ctx.companyId, { period, filters: { closer: str(input.closer) }, now: now.toJSDate() }, deps.ghl ?? liveGhlReads));
      held.push({ id, kind: "closes", k });
      return { content: JSON.stringify({ id, period: k.period_label, count: k.count, closes: k.closes.slice(0, 50) }) };
    }
    if (name === "get_availability") {
      const days = Math.min(7, Math.max(1, Math.round(Number(input.days) || 7)));
      const a = await asOperator((c) => getAvailability(c, ctx.companyId, deps.probes ?? liveProbes, days, now));
      held.push({ id, kind: "availability", a });
      return { content: JSON.stringify({ id, total: a.total, days: a.days, closers: a.closers.map((x) => ({ name: x.name, total: x.total })), unreadable: a.unreadable }) };
    }
    if (name === "run_readonly_query") {
      const chk = checkQuery(input.sql, 200);
      if (!chk.ok) return err(chk.error);
      const r = await runQuery(ctx.companyId, chk);
      held.push({ id, kind: "adhoc", why: String(input.why ?? "a query over the ledger"), columns: r.columns, rows: r.rows, truncated: r.truncated });
      return { content: JSON.stringify({ id, columns: r.columns, rows: r.rows.slice(0, 50), row_count: r.row_count, truncated: r.truncated }) };
    }
    return err(`no tool named ${name}`);
  } catch (e) {
    return err(e instanceof MetricError ? e.message : `failed: ${String((e as Error).message).slice(0, 300)}`);
  }
}
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Our rendering of the chosen results. The note survives only if every number in it is already in the message. */
function render(held: Held[], ids: string[], note: string): Out {
  const pick = ids.map((i) => held.find((h) => h.id === i)).filter((h): h is Held => !!h);
  const chosen = pick.length ? pick : held;
  const body = formatAnswer(chosen.flatMap((h) => (h.kind === "metric" ? [h.r] : [])), {
    availability: chosen.flatMap((h) => (h.kind === "availability" ? [h.a] : [])),
    closes: chosen.flatMap((h) => (h.kind === "closes" ? [h.k] : [])),
    adhoc: chosen.flatMap((h) => (h.kind === "adhoc" ? [{ why: h.why, columns: h.columns, rows: h.rows, truncated: h.truncated }] : [])),
  });
  const clean = note.trim().split(/\n/)[0].slice(0, 280);
  const flat = body.replace(/,/g, "");
  const ok = clean && (clean.match(/\d[\d,.]*/g) ?? []).every((n) => flat.includes(n.replace(/,/g, "").replace(/\.$/, "")));
  if (!ok || !clean) return { kind: "answer", text: body };
  const lines = body.split("\n");
  const keyEnd = lines.findIndex((l) => !l.startsWith("*") || l === "");
  lines.splice(keyEnd < 0 ? lines.length : keyEnd, 0, clean);
  return { kind: "answer", text: lines.join("\n") };
}

// ---- slash commands ----------------------------------------------------------------------------------------------------
export type SlashCommand = { command: string; text: string; userId: string; channelId: string; channelName?: string; teamId?: string; responseUrl?: string };
export type Shortcut = "mtd" | "weekly" | "monthly" | "show-rate" | "close-rate" | "cash" | "availability" | "leads" | "closes" | "help";
export const COMMANDS: Record<string, Shortcut> = { mtd: "mtd", weekly: "weekly", monthly: "monthly", "show-rate": "show-rate", "close-rate": "close-rate", cash: "cash", availability: "availability", leads: "leads", closes: "closes", help: "help", "ops-help": "help", "bot-help": "help" };
export type Plan = { shortcut: Exclude<Shortcut, "help">; title: string; period?: Period; days?: number };

/** What a command means before any work: its period from the text (or its default), or the reason it cannot be read. */
export function planCommand(cmd: SlashCommand, tz: string, now: DateTime = DateTime.now()): { help: true } | { error: string } | { plan: Plan } {
  const name = COMMANDS[cmd.command.replace(/^\//, "").toLowerCase()];
  if (!name) return { error: `I don't know the command ${cmd.command}.` };
  if (name === "help") return { help: true };
  const text = cmd.text.trim();
  if (name === "availability") {
    const m = /^(?:next\s+)?(\d{1,2})?(?:\s*days?)?$/i.exec(text);
    if (!m) return { error: `\`${cmd.command} ${text}\`: give a number of days (up to 7), e.g. \`${cmd.command} 3\`.` };
    const days = Math.min(7, Math.max(1, Number(m[1] ?? 7)));
    return { plan: { shortcut: name, title: `Availability, next ${days} days`, days } };
  }
  const fallback = name === "mtd" ? "this month" : name === "weekly" ? "last week" : name === "monthly" ? "last month" : "this month";
  if (name === "mtd" && text && !/^(mtd|this month|month to date)$/i.test(text)) return { error: `\`/mtd\` is always month to date. For another period try \`/monthly ${text}\`.` };
  const period = parsePeriod(text || fallback, tz, now);
  if (!period) return { error: `I couldn't read "${text}" as a period. Try \`${cmd.command} last month\`, \`${cmd.command} last 30 days\` or \`${cmd.command} Sep 1 to Sep 15\`.` };
  const titles: Record<string, string> = { mtd: "Month to date", weekly: period.name === "This week" ? "This week" : period.name === "Last week" ? "Last week" : "Week", monthly: period.name === "This month" ? "This month" : period.name === "Last month" ? "Last month" : period.name,
    "show-rate": "Show rate", "close-rate": "Close rate", cash: "Cash", leads: "Leads", closes: "Closes" };
  return { plan: { shortcut: name, title: titles[name], period } };
}

// people, calls and deals from GHL (D73); only cash is the ledger's
const SUMMARY = ["leads", "mqls", "calls_booked_due", "show_rate", "close_rate", "cash_collected"];
/** The body of a shortcut: deterministic, from the registry alone. */
export async function shortcutBody(deps: BotDeps, companyId: string, plan: Plan): Promise<string> {
  const now = deps.now ?? DateTime.now();
  if (plan.shortcut === "availability") return formatAvailability(await asOperator((c) => getAvailability(c, companyId, deps.probes ?? liveProbes, plan.days ?? 7, now)));
  return asCompany(companyId, async (c) => {
    const tz = (await one<{ timezone: string }>(c, "select timezone from companies where id=$1", [companyId]))!.timezone;
    const p = plan.period!, at = now.toJSDate();
    const m = (metric: string, groupBy?: GroupBy, period: Period = p) => getMetric(c, companyId, { metric, period, groupBy, now: at }, deps.ghl ?? liveGhlReads);
    switch (plan.shortcut) {
      case "mtd": case "weekly": case "monthly": {
        const cur = []; for (const x of SUMMARY) cur.push(await m(x));
        const prevP = previousPeriod(p, plan.shortcut === "weekly" ? "week" : "month", tz, now);
        const prev = []; for (const x of SUMMARY) prev.push(await m(x, undefined, prevP));
        const bySource = await m("cash_collected", "source");
        const top = (bySource.rows ?? []).filter((r) => (r.value ?? 0) > 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
        return formatSummary(cur, prev, [top ? `*Top source by cash: ${top.label}* (${fmt("money", top.value)})` : "*Top source by cash:* none yet"]);
      }
      case "show-rate": case "close-rate": {
        const metric = plan.shortcut === "show-rate" ? "show_rate" : "close_rate";
        const a = await m(metric, "closer"), b = await m(metric, "source");
        return formatAnswer([a, b]);
      }
      case "cash": {
        const rs = [await m("cash_gross", "closer"), await m("refunds", "closer"), await m("cash_collected", "closer")];
        return formatCombined(rs);
      }
      case "leads": {
        const rs = [await m("leads", "source"), await m("mqls", "source"), await m("marketing_dqs", "source")];
        return formatCombined(rs);
      }
      case "closes": return formatCloses(await getCloses(c, companyId, { period: p, now: at }, deps.ghl ?? liveGhlReads));
    }
    throw new Error(`no body for ${plan.shortcut}`);
  });
}

/** Runs a planned command and posts it where it was asked: a visible message in the channel (anyone follows up in its thread), or the asker's DM with the bot. */
export async function runCommand(deps: BotDeps, companyId: string, cmd: SlashCommand, plan: Plan): Promise<{ channel: string; ts: string } | { failed: string }> {
  const ctx = await asOperator((c) => loadCtx(c, companyId));
  if (!ctx) return { failed: "no Slack connection" };
  let body: string, escalated = false;
  try { body = await shortcutBody(deps, companyId, plan); }
  catch (e) {
    const why = String((e as Error).message).slice(0, 300);
    body = escalation(ctx, `/${plan.shortcut} failed: ${why}`, plan.shortcut === "availability" || /^GHL /.test(why) ? [why] : undefined).text;
    escalated = true;
  }
  const text = `📊 *${plan.title}* — asked by <@${cmd.userId}>\n${body}`;
  const dm = cmd.channelId.startsWith("D") || cmd.channelName === "directmessage";
  let posted: { ts: string; channel?: string } | null = null, where = cmd.channelId;
  try { posted = await deps.adapters.notifier.post(ctx.token, where, text); }
  catch (e) {
    // a DM between two people the bot is not part of, or a channel it was never invited to: the asker's own DM with the bot, else just to them
    if (dm) { where = cmd.userId; posted = await deps.adapters.notifier.post(ctx.token, where, text).catch(() => null); }
    if (!posted) {
      if (cmd.responseUrl && deps.respond) await deps.respond(cmd.responseUrl, { response_type: "ephemeral", text: `I'm not in this conversation, so only you can see this. Invite me to the channel to answer where everyone can follow up.\n\n${text}` });
      return { failed: String((e as Error).message) };
    }
  }
  const channel = posted.channel ?? where;
  if (escalated && ctx.escalateTo) await deps.adapters.notifier.post(ctx.token, channel, ESCALATE_PING(ctx.escalateTo), undefined, posted.ts).catch(() => null);
  const at = new Date().toISOString();
  await saveThread(companyId, channel, posted.ts, cmd.userId, [{ role: "user", text: `${cmd.command} ${cmd.text}`.trim(), user: cmd.userId, at }, { role: "bot", text: body, kind: escalated ? "escalate" : "answer", at }], true);
  return { channel, ts: posted.ts };
}

export { helpText };
