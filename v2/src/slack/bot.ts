import { and, eq, sql } from "drizzle-orm";
import { slackBotUsage } from "@/db/schema";
import { localDay } from "@/engine/time";
import { definitionOf } from "@/engine/interpreter";
import { type GroupBy, labelOf, metric, metricDef } from "@/reports/metrics";
import type { SlackApp } from "./app";
import { context, sections } from "./blocks";
import { fmt, periodOf, withMetrics, working } from "./commands";
import { contactOf, searchContacts } from "./contacts";
import { audit, offerSettings, platformSettingsOf } from "./data";
import { raiseAlert } from "./outbox";
import { may, presserOf, type Presser } from "./people";
import { queryViews, viewColumns } from "./query-views";
import type { Offer } from "./routing";
import { post } from "./say";

/**
 * The bot: a mention in an offer's channel, or a DM, answered about that one offer from the metric layer (the same
 * definitions the wrap-ups use, so an answer and a report never disagree). The model only chooses which reads to make;
 * its tools are reads, and every one of them is bound to the offer the routing found, never one the model names. It
 * cannot change config, unlock sends or send to a contact: it has no tool that could. Answers show their working (the
 * metric, the period, the filter). The model and the prompt are platform settings (bot.model, bot.prompt); the offer's
 * own words come from its config (bot.vocabulary). A daily token budget per offer (bot.daily_token_budget, else the
 * platform's) stops it for the day, and tells Tyler.
 */
export type BotTool = { name: string; description: string; input_schema: Record<string, unknown> };
export type BotMessage = { role: "user" | "assistant"; content: unknown };
export type BotCall = { id: string; name: string; input: Record<string, unknown> };
export type BotReply = { text: string; calls: BotCall[]; usage: { input: number; output: number }; content?: unknown };
/** The AI port for the bot: one turn of a tool-using model (a fake in tests). */
export interface BotModel { next(x: { model: string; system: string; tools: BotTool[]; messages: BotMessage[]; maxTokens: number }): Promise<BotReply> }

export const MAX_TURNS = 6;
export const DEFAULT_PROMPT = [
  "You answer questions from a sales team about their own offer's numbers and its workflows, in Slack.",
  "Every number you give must come from a tool result in this conversation; never estimate or invent one. If the tools cannot answer, say so plainly.",
  "Prefer the metric tool; use query_views only when no metric answers the question.",
  "You can only read. You cannot change settings, workflows or sends, and you never message a contact; if asked to, say that changes are made by Tyler.",
  "Keep answers short, plain and in Slack formatting.",
].join(" ");

const PERIODS = ["today", "yesterday", "this week", "last week", "this month", "last month"];
export const TOOLS: BotTool[] = [
  { name: "metric", description: "One of the offer's metrics over a period, in total or split by closer, setter or source. The only source of numbers besides query_views.", input_schema: { type: "object", properties: { name: { type: "string", description: "a metric name from the list in the context" }, period: { type: "string", enum: PERIODS }, group_by: { type: "string", enum: ["closer", "setter", "source"] } }, required: ["name", "period"] } },
  { name: "contact_journey", description: "One contact's facts (what happened to them, in order) and the workflow runs about them. Find them by name, email or phone.", input_schema: { type: "object", properties: { contact: { type: "string" } }, required: ["contact"] } },
  { name: "workflow_explain", description: "What one of the offer's workflows does, step by step, as its definition says.", input_schema: { type: "object", properties: { workflow: { type: "string", description: "its key or name" } }, required: ["workflow"] } },
  { name: "open_alerts", description: "The offer's open alerts.", input_schema: { type: "object", properties: {} } },
  { name: "query_views", description: `Last resort: one read-only SELECT over this offer's views (${Object.entries(viewColumns()).map(([v, c]) => `${v}(${c.join(", ")})`).join("; ")}). 5-second limit.`, input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
];

type Ask = { teamId: string; userId: string; channel: string; threadTs?: string | undefined; text: string; offer: Offer; key: string };

/** Answers one question about one offer, and posts the answer where it was asked. Gives back what happened. */
export async function answerQuestion(app: SlackApp, q: Ask): Promise<string> {
  const now = app.now();
  const reply = async (text: string, work: string[] = []) => {
    await post(app, { offerId: q.offer.id, teamId: q.teamId, channel: q.channel, ...(q.threadTs ? { threadTs: q.threadTs } : {}) }, `bot:${q.key}`, { text, blocks: [...sections(text), ...(work.length ? [context(...work.slice(0, 10))] : [])] }, { kind: "bot" });
  };
  const who = await presserOf(app, q.offer.id, q.teamId, q.userId);
  if (!may(who, "member")) { await reply(`I only answer people on ${q.offer.name}'s team.`); return "not on team"; }
  const [platform, settings] = await Promise.all([platformSettingsOf(app.db), offerSettings(app.db, q.offer.id)]);
  const model = platform["bot.model"];
  if (!app.bot || typeof model !== "string" || !model) { await reply("I'm not set up to answer questions yet."); return "no model"; }
  const budget = Number(settings["bot.daily_token_budget"] ?? platform["bot.daily_token_budget"] ?? 0);
  const day = localDay(now, q.offer.zone).day;
  const spent = async () => (await app.db.select().from(slackBotUsage).where(and(eq(slackBotUsage.offerId, q.offer.id), eq(slackBotUsage.day, day))))[0]?.tokens ?? 0;
  const overBudget = async () => {
    await raiseAlert(app.db, { offerId: null, key: `bot-budget:${q.offer.id}:${day}`, kind: "bot_budget", message: `The bot reached ${q.offer.name}'s daily token budget (${budget.toLocaleString("en-US")}); it answers again tomorrow.`, detail: { offer: q.offer.id, day }, at: now });
    await reply("I've used up today's budget for questions on this offer. Slash commands still work; I'll be back tomorrow.");
    return "over budget";
  };
  if (!(budget > 0) || (await spent()) >= budget) return overBudget();
  const charge = async (n: number) => { await app.db.insert(slackBotUsage).values({ offerId: q.offer.id, day, tokens: n }).onConflictDoUpdate({ target: [slackBotUsage.offerId, slackBotUsage.day], set: { tokens: sql`${slackBotUsage.tokens} + ${n}` } }); };

  const metrics = await withMetrics(app, q.offer.id, async (mc) => Object.keys(mc.defs).filter((k) => !k.startsWith("_")).map((k) => { try { const d = metricDef(mc.defs, k); return `${k} (${d.label})`; } catch { return null; } }).filter(Boolean));
  const system = `${typeof platform["bot.prompt"] === "string" && platform["bot.prompt"] ? platform["bot.prompt"] : DEFAULT_PROMPT}`;
  const contextText = [`Offer: ${q.offer.name}. Its clock: ${q.offer.zone}. Now: ${now.toISOString()}.`, `Metrics: ${metrics.join(", ") || "none defined"}.`,
    ...(typeof settings["bot.vocabulary"] === "string" && settings["bot.vocabulary"] ? [`This offer's words: ${settings["bot.vocabulary"]}`] : []), `Asked by: ${who.name}${who.roles.length ? ` (${who.roles.join(", ")})` : who.operator ? " (operator)" : ""}.`].join("\n");
  const messages: BotMessage[] = [{ role: "user", content: `${contextText}\n\nQuestion: ${q.text}` }];
  const work: string[] = [];
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const r = await app.bot.next({ model, system, tools: TOOLS, messages, maxTokens: 1024 });
      await charge(r.usage.input + r.usage.output);
      if (!r.calls.length) {
        await reply(r.text.trim() || "I couldn't work that out.", work);
        await audit(app.db, { offerId: q.offer.id, teamId: q.teamId, userId: q.userId, action: "bot.answered", detail: { turns: turn + 1, tools: work.length }, at: app.now() });
        return "answered";
      }
      messages.push({ role: "assistant", content: r.content ?? [...(r.text ? [{ type: "text", text: r.text }] : []), ...r.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }))] });
      const results: unknown[] = [];
      for (const c of r.calls) {
        const out = await runTool(app, q, who, c, work);
        results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out).slice(0, 20_000), ...(out && typeof out === "object" && "error" in out ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
      if (budget > 0 && (await spent()) >= budget) return overBudget();
    }
    await reply("I couldn't get to an answer in a few steps; try asking more narrowly, or use a slash command (`/help`).", work);
    return "gave up";
  } catch (e) {
    await reply(`I couldn't answer that just now (${e instanceof Error ? e.message.slice(0, 200) : "error"}).`);
    return "failed";
  }
}

/** One tool call, bound to the routed offer: whatever the model put in the input, it never names the offer. */
export async function runTool(app: SlackApp, q: Pick<Ask, "offer" | "teamId" | "userId">, who: Presser, c: BotCall, work: string[]): Promise<unknown> {
  const offerId = q.offer.id;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (c.name) {
    case "metric": {
      const name = s(c.input.name), by = s(c.input.group_by) as GroupBy | "";
      const p = periodOf(s(c.input.period), { kind: "monthly", which: "in_progress" }, app.now(), q.offer.zone);
      if (!p) return { error: `period is one of ${PERIODS.join(", ")}` };
      return withMetrics(app, offerId, async (mc) => {
        let def;
        try { def = metricDef(mc.defs, name); } catch (e) { return { error: (e as Error).message }; }
        const r = await metric(mc, name, p, by || undefined);
        const how = `${working(mc.defs, name)} · ${p.label} (${p.from} to ${p.to})${by ? ` · by ${by}` : ""}`;
        work.push(how);
        return {
          metric: name, label: def.label, unit: def.unit, period: { name: p.name, from: p.from, to: p.to, label: p.label }, value: r.value, formatted: fmt(def.unit, r.value),
          ...(r.numerator !== undefined ? { numerator: r.numerator, denominator: r.denominator } : {}), ...(r.unavailable ? { unavailable: r.unavailable } : {}),
          ...(by ? { rows: [...r.rows].map(([k, v]) => ({ who: by === "source" ? k || "no source" : labelOf(k, mc.people), value: v, formatted: fmt(def.unit, v) })) } : {}), working: how,
        };
      });
    }
    case "contact_journey": {
      const key = s(c.input.contact);
      const exact = await contactOf(app.db, offerId, key);
      const found = exact ? [exact] : await searchContacts(app.db, offerId, key, 5);
      if (!found.length) return { error: `no contact on this offer matches "${key}"` };
      if (found.length > 1) return { candidates: found.map((f) => ({ name: f.name, email: f.email, phone: f.phone })), note: "several match: ask which one" };
      const who = found[0]!;
      return app.engine.store.tx(async (tx) => {
        const facts = await tx.events({ offerId, contactId: who.id, order: "asc", limit: 100 });
        const runs = await tx.runs({ offerId, about: { contactId: who.id }, limit: 50 });
        const wfs = new Map((await tx.workflows(offerId)).map((w) => [w.id, w.name]));
        work.push(`contact journey: ${who.name} (${facts.length} facts, ${runs.length} runs)`);
        return { contact: { name: who.name, email: who.email, phone: who.phone }, facts: facts.map((e) => ({ type: e.type, at: e.occurredAt.toISOString(), source: e.source })), runs: runs.map((r) => ({ workflow: wfs.get(r.workflowId) ?? r.workflowId, status: r.status, at_step: r.currentNode, started: r.startedAt.toISOString(), ended: r.finishedAt?.toISOString() ?? null, why: r.endReason })) };
      });
    }
    case "workflow_explain": {
      const want = s(c.input.workflow).toLowerCase();
      return app.engine.store.tx(async (tx) => {
        const w = (await tx.workflows(offerId)).find((x) => x.key.toLowerCase() === want || x.name.toLowerCase() === want);
        if (!w?.currentVersionId) return { error: `this offer has no workflow "${s(c.input.workflow)}"` };
        const { def } = definitionOf((await tx.version(w.currentVersionId))!);
        work.push(`workflow: ${w.name}`);
        return { key: w.key, name: w.name, enabled: w.enabled, delivery: w.delivery, description: (def as { description?: string }).description ?? null, steps: def.nodes.map((n) => ({ id: n.id, type: n.type, title: (n as { title?: string }).title ?? "" })) };
      });
    }
    case "open_alerts": {
      const open = await app.engine.store.tx((tx) => tx.alerts({ offerId, open: true }));
      work.push(`open alerts: ${open.length}`);
      return { alerts: open.map((a) => ({ kind: a.kind, message: a.message, opened: a.openedAt.toISOString() })) };
    }
    case "query_views": {
      const roles = (await platformSettingsOf(app.db))["bot.query_views_roles"];
      const allowed = Array.isArray(roles) ? roles.map(String) : ["operator"];
      if (!((who.operator && allowed.includes("operator")) || who.roles.some((r) => allowed.includes(r)))) return { error: "query_views is not open to this person; answer from the metrics instead" };
      const r = await queryViews(app.db, offerId, s(c.input.sql));
      await audit(app.db, { offerId, teamId: q.teamId, userId: q.userId, action: "bot.query_views", detail: { sql: s(c.input.sql).slice(0, 4000), ok: r.ok, rows: r.ok ? r.rows.length : 0, ...(r.ok ? {} : { why: r.why }) }, at: app.now() });
      work.push(`read-only query (${r.ok ? `${r.rows.length} rows` : "refused"})`);
      return r.ok ? { rows: r.rows, truncated: r.truncated } : { error: r.why };
    }
    default:
      return { error: `there is no tool "${c.name}": I can only read (metric, contact_journey, workflow_explain, open_alerts, query_views)` };
  }
}
