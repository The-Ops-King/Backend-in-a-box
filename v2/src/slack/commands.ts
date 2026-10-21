import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { personIdentities } from "@/db/schema";
import { type GroupBy, type MetricCtx, labelOf, metric, metricDef } from "@/reports/metrics";
import { type Period, type PeriodKind, periodFor } from "@/reports/periods";
import { renderReport, table } from "@/reports/render";
import { type SlackApp, operatorChannel } from "./app";
import { type Button, card, formSummary, reportTable } from "./blocks";
import type { BlockAction } from "./interactions";
import { audit, confirmIdentity, offerRow, offerSettings, removeIdentity } from "./data";
import { type Rule, may, presserOf, refusal } from "./people";
import { type Offer, routeCommand } from "./routing";
import { post, tell } from "./say";
import { openValue, signValue } from "./signed";

/**
 * Slash commands, one request URL (/slack/commands), simple names with no prefix. Each is answered from the metric
 * layer (the definitions the wrap-ups use) or the engine, privately to the person who asked, after the ack. Which
 * commands an offer has, and which of its metrics each one reads, is the offer's config (setting slack.commands);
 * /help lists only what is on. Who may run each is the platform's rule.
 */
export const COMMANDS: Record<string, { does: string; who: Rule; usage?: string }> = {
  mtd: { does: "Month-to-date numbers", who: "member" },
  weekly: { does: "Last week's numbers (or `this week`)", who: "member" },
  monthly: { does: "Last month's numbers (or `this month`)", who: "member" },
  "show-rate": { does: "Show rate, optionally `by closer` or `by source`", who: "member" },
  "close-rate": { does: "Close rate, optionally `by closer` or `by source`", who: "member" },
  cash: { does: "Cash collected, optionally `by closer` or `by source`", who: "member" },
  leads: { does: "Leads, optionally `by source`", who: "member" },
  closes: { does: "Closes, optionally `by closer`", who: "member" },
  leaderboard: { does: "This week's leaderboard", who: "member" },
  availability: { does: "Open slots per calendar for the next N days (`/availability 3`)", who: "member" },
  support: { does: "Opens a ticket to Tyler (`/support what's wrong`)", who: "member" },
  agreement: { does: "Opens the agreement form, or sends one with a contact (`/agreement ana@example.com`)", who: "agreement" },
  team: { does: "The people and their roles; `add @person role` or `remove @person`", who: "team" },
  help: { does: "What each command does, for this offer", who: "member" },
};
/** Always on: /help, and /team (the operator's own). The rest are on where the offer's config turns them on. */
const ALWAYS = ["help", "team"];
const ONE_METRIC = ["show-rate", "close-rate", "cash", "leads", "closes"] as const;

/** The offer's slash-command config (setting slack.commands). */
export const CommandConfig = z.object({
  enabled: z.array(z.string()).default([]),
  /** The metrics /mtd, /weekly and /monthly show, in order. */
  summary: z.array(z.string()).default([]),
  /** Which metric each one-metric command reads. */
  metric: z.record(z.string()).default({}),
  /** The report definitions /leaderboard and /availability render. */
  leaderboard: z.string().optional(),
  availability: z.string().optional(),
}).strict();
export type CommandConfig = z.infer<typeof CommandConfig>;

export type SlashCommand = { teamId: string; channelId: string; userId: string; command: string; text: string; responseUrl: string | null; triggerId: string | null };

export function parseCommand(form: URLSearchParams): SlashCommand | null {
  const teamId = form.get("team_id"), userId = form.get("user_id"), command = form.get("command");
  if (!teamId || !userId || !command) return null;
  return { teamId, userId, command, channelId: form.get("channel_id") ?? "", text: form.get("text") ?? "", responseUrl: form.get("response_url"), triggerId: form.get("trigger_id") };
}

const nameOf = (command: string) => command.replace(/^\//, "").toLowerCase();

async function configOf(app: SlackApp, offerId: string): Promise<CommandConfig | { problem: string }> {
  const raw = (await offerSettings(app.db, offerId))["slack.commands"];
  if (raw === undefined) return { problem: "Slash commands aren't set up for this offer yet (setting slack.commands)." };
  const r = CommandConfig.safeParse(raw);
  return r.success ? r.data : { problem: `This offer's slash-command setup doesn't read: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
}

/** The work after the ack: routed to an offer, checked, answered. Gives back what was done. */
export async function handleCommand(app: SlackApp, cmd: SlashCommand, inboxId: number): Promise<string> {
  const name = nameOf(cmd.command);
  const where = { offerId: null as string | null, teamId: cmd.teamId, user: cmd.userId, channel: cmd.channelId, responseUrl: cmd.responseUrl };
  const say = (text: string, offerId: string | null = null, blocks?: unknown[]) => tell(app, { ...where, offerId }, `cmd:${inboxId}`, text, blocks as never);
  if (!COMMANDS[name]) { await say(`I don't know ${cmd.command}. Try \`/help\` for what I can do.`); return "unknown"; }
  const routed = await routeCommand(app, cmd);
  if ("none" in routed) { await say(routed.none); return "unrouted"; }
  if ("pick" in routed) {
    const buttons: Button[] = routed.pick.slice(0, 5).map((o) => ({ actionId: "pick", label: o.name, value: signValue(app.env.stateSecret, "pick", { o: o.id, c: name, t: routed.text, u: cmd.userId }, { now: app.now(), ttlSec: 900 }) }));
    await say(`Which offer is \`${cmd.command}\` for?`, null, [{ type: "section", text: { type: "mrkdwn", text: `Which offer is \`${cmd.command}\` for?` } }, { type: "actions", block_id: "pick", elements: buttons.map((b) => ({ type: "button", action_id: b.actionId, text: { type: "plain_text", text: b.label }, value: b.value })) }]);
    return "picker";
  }
  return runCommand(app, cmd, name, routed.offer, routed.text, inboxId);
}

/** A press on the offer picker: only the person who asked may pick; the command then runs for that offer. */
export async function picked(app: SlackApp, x: BlockAction, v: Record<string, unknown>, inboxId: number): Promise<string> {
  if (v.u !== x.userId) return "not theirs";
  const offer = await offerRow(app.db, String(v.o));
  if (!offer) return "no offer";
  const cmd: SlashCommand = { teamId: x.teamId, channelId: x.channel ?? "", userId: x.userId, command: `/${String(v.c ?? "")}`, text: String(v.t ?? ""), responseUrl: x.responseUrl, triggerId: x.triggerId };
  if (v.c === "_bot") { const { answerQuestion } = await import("./bot"); return answerQuestion(app, { teamId: x.teamId, userId: x.userId, channel: x.channel ?? "", threadTs: typeof v.th === "string" ? v.th : undefined, text: String(v.t ?? ""), offer, key: `pick:${inboxId}` }); }
  return runCommand(app, cmd, String(v.c), offer, String(v.t ?? ""), inboxId);
}

async function runCommand(app: SlackApp, cmd: SlashCommand, name: string, offer: Offer, text: string, inboxId: number): Promise<string> {
  const where = { offerId: offer.id, teamId: cmd.teamId, user: cmd.userId, channel: cmd.channelId, responseUrl: cmd.responseUrl };
  const say = (t: string, blocks?: unknown[]) => tell(app, where, `cmd:${inboxId}`, t, blocks as never);
  const who = await presserOf(app, offer.id, cmd.teamId, cmd.userId);
  const rule = COMMANDS[name]!.who;
  if (!may(who, rule)) {
    await audit(app.db, { offerId: offer.id, teamId: cmd.teamId, userId: cmd.userId, action: "slack.refused", detail: { command: name, rule, roles: who.roles }, at: app.now() });
    await say(refusal(rule));
    return "refused";
  }
  const cfg = await configOf(app, offer.id);
  if (name === "help") { await say(helpText(offer, "problem" in cfg ? null : cfg, who.operator)); return "help"; }
  if (name === "team") return team(app, cmd, offer, text, inboxId);
  if ("problem" in cfg) { await say(cfg.problem); return "not set up"; }
  if (!cfg.enabled.includes(name)) { await say(`\`/${name}\` isn't turned on for ${offer.name}. \`/help\` lists what is.`); return "disabled"; }
  try {
    switch (name) {
      case "mtd": case "weekly": case "monthly": return await summary(app, offer, cfg, name, text, say);
      case "show-rate": case "close-rate": case "cash": case "leads": case "closes": return await oneMetric(app, offer, cfg, name, text, say);
      case "leaderboard": return await report(app, offer, cfg.leaderboard, "leaderboard", {}, say);
      case "availability": {
        const m = /^(?:next\s+)?(\d{1,2})?\s*(?:days?)?$/i.exec(text.trim());
        if (!m) { await say("Give a number of days (up to 7), e.g. `/availability 3`."); return "bad args"; }
        return await report(app, offer, cfg.availability, "availability", { days: String(Math.min(7, Math.max(1, Number(m[1] ?? 7)))) }, say);
      }
      case "support": return await support(app, cmd, offer, text, inboxId, say);
      case "agreement": { const { agreementCommand } = await import("./agreement"); return await agreementCommand(app, cmd, offer, text, inboxId); }
    }
  } catch (e) {
    await say(`I couldn't answer that: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
  return "ignored";
}

export function helpText(offer: Offer, cfg: CommandConfig | null, operator: boolean): string {
  const on = Object.keys(COMMANDS).filter((c) => ALWAYS.includes(c) || cfg?.enabled.includes(c)).filter((c) => c !== "team" || operator);
  return [`*Commands for ${offer.name}*`, ...on.map((c) => `\`/${c}\` ${COMMANDS[c]!.does}`), ...(cfg ? [] : ["_The number commands aren't set up for this offer yet._"]), "Or mention me with a question about the numbers."].join("\n");
}

// ---- numbers ------------------------------------------------------------------------------------------------------------

/** "this week", "last month", "today": a period on the offer's clock. */
export function periodOf(text: string, fallback: { kind: PeriodKind; which: "just_ended" | "in_progress" }, now: Date, zone: string): Period | null {
  const t = text.trim().toLowerCase();
  if (!t) return periodFor(fallback.kind, fallback.which, now, zone);
  const m = /^(this|last)\s+(week|month)$/.exec(t);
  if (m) return periodFor(m[2] === "week" ? "weekly" : "monthly", m[1] === "this" ? "in_progress" : "just_ended", now, zone);
  if (t === "today") return periodFor("daily", "in_progress", now, zone);
  if (t === "yesterday") return periodFor("daily", "just_ended", now, zone);
  if (t === "mtd" || t === "month to date") return periodFor("monthly", "in_progress", now, zone);
  return null;
}

/** Runs `fn` with the offer's metric layer, in one read of the store. */
export async function withMetrics<T>(app: SlackApp, offerId: string, fn: (mc: MetricCtx) => Promise<T>): Promise<T> {
  return app.engine.store.tx(async (tx) => {
    const mc: MetricCtx = { tx, offerId, settings: await tx.settings(offerId), now: app.now(), defs: await tx.reportDefinitions(offerId, "metric"), people: await tx.projFind("people", offerId), cache: new Map() };
    return fn(mc);
  });
}

export function fmt(unit: string, v: number | null): string {
  if (v === null || v === undefined) return "—";
  if (unit === "money") return `${v < 0 ? "−" : ""}$${Math.abs(Math.round(v)).toLocaleString("en-US")}`;
  if (unit === "rate") return `${Math.round(v * 100)}%`;
  if (unit === "minutes") return `${Math.round(v)} min`;
  return Math.round(v * 100) / 100 === Math.round(v) ? v.toLocaleString("en-US") : String(v);
}

/** How a metric is worked out, in a line: where it reads, the time its period is on, and its filter. */
export function working(defs: Record<string, unknown>, name: string): string {
  const d = metricDef(defs, name);
  if ("rate" in d) return `\`${name}\`: ${d.rate.num} ÷ ${d.rate.den}`;
  const val = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) && "setting" in v ? `setting ${(v as { setting: string }).setting}` : JSON.stringify(v));
  const where = d.where.map((f) => `${f.col}${f.field ? `.<${f.field.setting}>` : ""} ${f.op}${f.value !== undefined ? ` ${val(f.value)}` : ""}`).join(", ");
  const from = d.from === "daily_facts" ? `daily ${d.agg} of ${d.fact}` : `${d.agg}${d.of ? ` of ${d.of}` : ""} over ${d.from} by ${d.time}`;
  return `\`${name}\`: ${from}${where ? ` where ${where}` : ""}`;
}

type Say = (text: string, blocks?: unknown[]) => Promise<unknown>;

async function summary(app: SlackApp, offer: Offer, cfg: CommandConfig, name: string, text: string, say: Say): Promise<string> {
  if (name === "mtd" && text.trim() && !/^(mtd|this month|month to date)$/i.test(text.trim())) { await say("`/mtd` is always month to date. For another period try `/monthly last month` or `/weekly this week`."); return "bad args"; }
  const fallback = name === "weekly" ? { kind: "weekly" as const, which: "just_ended" as const } : name === "monthly" ? { kind: "monthly" as const, which: "just_ended" as const } : { kind: "monthly" as const, which: "in_progress" as const };
  const p = periodOf(text, fallback, app.now(), offer.zone);
  if (!p) { await say(`I couldn't read "${text}" as a period. Try \`this week\`, \`last week\`, \`this month\` or \`last month\`.`); return "bad args"; }
  if (!cfg.summary.length) { await say("This offer's summary has no metrics yet (slack.commands.summary)."); return "not set up"; }
  const rows: string[][] = [], work: string[] = [];
  await withMetrics(app, offer.id, async (mc) => {
    for (const m of cfg.summary) {
      const def = metricDef(mc.defs, m), r = await metric(mc, m, p);
      rows.push([def.label, r.unavailable ? "—" : fmt(def.unit, r.value)]);
      work.push(working(mc.defs, m) + (r.unavailable ? ` (not there: ${r.unavailable})` : ""));
    }
  });
  const title = `${name === "mtd" ? "Month to date" : p.name} · ${p.label}`;
  const m = reportTable({ title, table: table(rows), working: [`${p.from} to ${p.to}, ${offer.zone}`, ...work] });
  await say(m.text, m.blocks);
  return name;
}

async function oneMetric(app: SlackApp, offer: Offer, cfg: CommandConfig, name: (typeof ONE_METRIC)[number], text: string, say: Say): Promise<string> {
  const metricName = cfg.metric[name];
  if (!metricName) { await say(`\`/${name}\` has no metric set for this offer (slack.commands.metric).`); return "not set up"; }
  const by = /\bby\s+(closer|setter|source)\b/i.exec(text)?.[1]?.toLowerCase() as GroupBy | undefined;
  const rest = text.replace(/\bby\s+(closer|setter|source)\b/i, "").trim();
  const p = periodOf(rest, { kind: "monthly", which: "in_progress" }, app.now(), offer.zone);
  if (!p) { await say(`I couldn't read "${rest}" as a period. Try \`this week\`, \`last month\` or \`today\`, and optionally \`by closer\` or \`by source\`.`); return "bad args"; }
  let out!: { title: string; rows: string[][]; work: string[] };
  await withMetrics(app, offer.id, async (mc) => {
    const def = metricDef(mc.defs, metricName);
    const r = await metric(mc, metricName, p, by);
    const rows: string[][] = [[`${def.label}${r.numerator !== undefined ? ` (${r.numerator}/${r.denominator})` : ""}`, r.unavailable ? "—" : fmt(def.unit, r.value)]];
    if (by) for (const [k, v] of [...r.rows].sort((a, b) => b[1] - a[1])) rows.push([by === "source" ? k || "no source" : labelOf(k, mc.people), fmt(def.unit, v)]);
    out = { title: `${def.label}${by ? ` by ${by}` : ""} · ${p.name} · ${p.label}`, rows, work: [`${p.from} to ${p.to}, ${offer.zone}`, working(mc.defs, metricName) + (r.unavailable ? ` (not there: ${r.unavailable})` : "")] };
  });
  const m = reportTable({ title: out.title, table: table(out.rows), working: out.work });
  await say(m.text, m.blocks);
  return name;
}

async function report(app: SlackApp, offer: Offer, key: string | undefined, what: string, params: Record<string, unknown>, say: Say): Promise<string> {
  if (!key) { await say(`\`/${what}\` has no report set for this offer (slack.commands.${what}).`); return "not set up"; }
  const body = await app.engine.store.tx(async (tx) => {
    const o = (await tx.offer(offer.id))!;
    const r = (await renderReport({ tx, offer: o, settings: await tx.settings(offer.id), now: app.now(), ...(app.reads ? { reads: app.reads } : {}) }, { key, period: "in_progress", params, ctx: {} })) as { body?: unknown };
    return typeof r?.body === "string" ? r.body : JSON.stringify(r);
  });
  const m = card({ text: body, footer: `report \`${key}\`, from the same definitions as the posted reports` });
  await say(m.text, m.blocks);
  return what;
}

async function support(app: SlackApp, cmd: SlashCommand, offer: Offer, text: string, inboxId: number, say: Say): Promise<string> {
  if (!text.trim()) { await say("Say what's wrong after the command, e.g. `/support the wrap-up didn't post today`."); return "bad args"; }
  const op = await operatorChannel(app);
  if (!op) { await say("There's no support channel set up yet; tell Tyler directly."); return "no channel"; }
  const m = formSummary({ title: `🎫 Support request · ${offer.name}`, fields: [["From", `<@${cmd.userId}>`], ["Where", cmd.channelId ? `<#${cmd.channelId}>` : "a DM"], ["What", text.trim().slice(0, 2000)]] });
  await post(app, { offerId: null, teamId: op.teamId, channel: op.channel }, `support:${inboxId}`, m, { kind: "support" });
  await audit(app.db, { offerId: offer.id, teamId: cmd.teamId, userId: cmd.userId, action: "slack.support", detail: {}, at: app.now() });
  await say("Got it. It's with Tyler.");
  return "support";
}

/** /team (the operator): the people and their roles; `add <@U> role[,role] Name` and `remove <@U>` change the team by facts. */
async function team(app: SlackApp, cmd: SlashCommand, offer: Offer, text: string, inboxId: number): Promise<string> {
  const say = (t: string) => tell(app, { offerId: offer.id, teamId: cmd.teamId, user: cmd.userId, channel: cmd.channelId, responseUrl: cmd.responseUrl }, `cmd:${inboxId}`, t);
  const now = app.now();
  const add = /^add\s+<@([A-Z0-9]+)(?:\|[^>]*)?>\s+([a-z,]+)\s*(.*)$/i.exec(text.trim());
  const remove = /^remove\s+<@([A-Z0-9]+)(?:\|[^>]*)?>\s*$/i.exec(text.trim());
  const people = await app.engine.store.tx((tx) => tx.projFind("people", offer.id));
  const ids = await app.db.select().from(personIdentities).where(and(eq(personIdentities.offerId, offer.id), eq(personIdentities.kind, "slack")));
  const slackOf = (personId: string) => ids.find((i) => i.offerId === offer.id && i.personId === personId && i.teamId === cmd.teamId)?.userId;
  if (add) {
    const [, user, roles, name] = add;
    const known = ids.find((i) => i.offerId === offer.id && i.teamId === cmd.teamId && i.userId === user);
    const personId = known?.personId ?? `slack-${cmd.teamId}-${user}`;
    await app.engine.ingest({ offerId: offer.id, type: known ? "person.updated" : "person.added", occurredAt: now, source: "slack", dedupeKey: `slack:team:${inboxId}`, payload: { person: { id: personId, roles: roles!.toLowerCase().split(",").filter(Boolean), slack_user_id: user, ...(name?.trim() ? { name: name.trim() } : {}) }, by: `slack:${cmd.userId}` } });
    await confirmIdentity(app.db, { offerId: offer.id, personId, teamId: cmd.teamId, userId: user!, by: `slack:${cmd.userId}`, now });
    await audit(app.db, { offerId: offer.id, teamId: cmd.teamId, userId: cmd.userId, action: "slack.team_add", detail: { user, roles }, at: now });
    await say(`Added <@${user}> to ${offer.name} as ${roles}.`);
    return "team add";
  }
  if (remove) {
    const user = remove[1]!;
    const known = ids.find((i) => i.offerId === offer.id && i.teamId === cmd.teamId && i.userId === user);
    if (!known) { await say(`<@${user}> isn't on ${offer.name}'s team.`); return "team none"; }
    await app.engine.ingest({ offerId: offer.id, type: "person.removed", occurredAt: now, source: "slack", dedupeKey: `slack:team:${inboxId}`, payload: { person: { id: known.personId }, by: `slack:${cmd.userId}` } });
    await removeIdentity(app.db, offer.id, cmd.teamId, user);
    await audit(app.db, { offerId: offer.id, teamId: cmd.teamId, userId: cmd.userId, action: "slack.team_remove", detail: { user }, at: now });
    await say(`Removed <@${user}> from ${offer.name}'s team.`);
    return "team remove";
  }
  if (text.trim()) { await say("`/team` lists the team; `/team add @person closer,setter Their Name` adds one; `/team remove @person` removes one."); return "bad args"; }
  const active = people.filter((p) => p.active).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  await say(active.length ? [`*${offer.name}'s team*`, ...active.map((p) => `• ${p.name ?? p.id}: ${p.roles.join(", ") || "no role"}${slackOf(p.id) ? ` (<@${slackOf(p.id)}>)` : " (not linked in Slack)"}`)].join("\n") : `${offer.name} has no one on its team yet.`);
  return "team";
}
