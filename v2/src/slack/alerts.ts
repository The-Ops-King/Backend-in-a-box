import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { alerts, connections, offers, slackAlertState, slackChannels, slackWorkspaces } from "@/db/schema";
import { partsIn } from "@/engine/time";
import type { AlertRow } from "@/engine/types";
import { operatorChannel, type SlackApp } from "./app";
import { alertLayout, clockTime } from "./blocks";
import { audit, offerRow, offerSettings, offersOfTeam, platformSettingsOf } from "./data";
import { raiseAlert } from "./outbox";
import type { BlockAction, Pressed } from "./interactions";
import { refuse } from "./interactions";
import { may, presserOf } from "./people";
import { post, react, settle, tell } from "./say";
import { signValue } from "./signed";

/**
 * Alerts, as platform behavior: the same on every offer. One open alert per offer and cause key (the engine's alerts
 * table). Raised: a post in the offer's alerts channel (slack.channel.alerts), with Retry, Resolve and Pause. Still open:
 * a reply in its thread every N minutes, only inside the operator's working hours, and only after its cause is checked
 * again and found still true. Resolved: a reply and a ✅ on the original. An alert that belongs to no offer (or an offer
 * with no alerts channel) goes to the operator's channel. N, the hours and their clock are platform settings in the
 * database (alerts.repeat_minutes, alerts.repeat_hours, alerts.repeat_zone), never constants here.
 */

/** Whether `now` is inside an "HH:MM-HH:MM" window on the zone's clock (a window across midnight works too). */
export function inHours(now: Date, hours: string, zone: string): boolean {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(hours);
  if (!m) throw new Error(`alerts.repeat_hours "${hours}" is not HH:MM-HH:MM`);
  const p = partsIn(now, zone), at = p.h * 60 + p.mi, from = +m[1]! * 60 + +m[2]!, to = +m[3]! * 60 + +m[4]!;
  return from <= to ? at >= from && at < to : at >= from || at < to;
}

export type RepeatRule = { everyMin: number; hours: string; zone: string };
export async function repeatRule(app: Pick<SlackApp, "db">): Promise<RepeatRule> {
  const s = await platformSettingsOf(app.db);
  const every = s["alerts.repeat_minutes"], hours = s["alerts.repeat_hours"], zone = s["alerts.repeat_zone"];
  if (typeof every !== "number" || every < 1) throw new Error("the platform setting alerts.repeat_minutes is not set");
  if (typeof hours !== "string" || typeof zone !== "string") throw new Error("the platform settings alerts.repeat_hours and alerts.repeat_zone are not set");
  return { everyMin: every, hours, zone };
}

/** Whether an open alert's cause is still there: checked before it is said again. "unknown": only a person can tell (said once, kept open). */
export type Cause = "open" | "fixed" | "unknown";
type Check = (app: SlackApp, a: AlertRow) => Promise<Cause>;
export const CAUSE_CHECKS: Record<string, Check> = {
  connection_auth: async (app, a) => {
    if (!a.offerId) return "unknown";
    const port = /:auth:([a-z]+)$/.exec(a.key)?.[1];
    const c = (await app.db.select().from(connections).where(and(eq(connections.offerId, a.offerId), eq(connections.port, port ?? ""))))[0];
    return c && c.status !== "connected" ? "open" : "fixed";
  },
  circuit_breaker: async (app, a) => (a.offerId && (await offerRow(app.db, a.offerId))?.sendsPausedAt ? "open" : "fixed"),
  sandbox_no_test_channel: async (app, a) => (a.offerId && (await offerSettings(app.db, a.offerId))["slack.channel.test"] ? "fixed" : "open"),
  slack_revoked: async (app, a) => {
    const team = /slack-revoked:(.+)$/.exec(a.key)?.[1];
    const w = team ? (await app.db.select().from(slackWorkspaces).where(eq(slackWorkspaces.teamId, team)))[0] : undefined;
    return w?.revokedAt ? "open" : "fixed";
  },
  slack_channel_archived: async (app, a) => {
    const d = a.detail as { team?: string; channel?: string };
    const ch = d.team && d.channel ? (await app.db.select().from(slackChannels).where(and(eq(slackChannels.teamId, d.team), eq(slackChannels.channelId, d.channel))))[0] : undefined;
    return ch?.archivedAt ? "open" : "fixed";
  },
  run_held: async (app, a) => (a.runId && (await app.engine.store.tx((tx) => tx.run(a.runId!)))?.status === "paused" ? "open" : "fixed"),
};
const causeOf = (app: SlackApp, a: AlertRow): Promise<Cause> => (CAUSE_CHECKS[a.kind] ?? (async () => "unknown" as Cause))(app, a);

const TITLES: Record<string, string> = {
  connection_auth: "Token rejected", circuit_breaker: "Sends paused", outbox_failed: "A step's effect failed", outbox_unknown: "Not known whether it went",
  frequency_cap: "Message held (daily cap)", blank_hold: "Message held (blank words)", unmapped_channel: "Post held (not one of the offer's channels)",
  sandbox_no_test_channel: "Sandbox post held", slack_revoked: "Slack disconnected", slack_channel_archived: "Slack channel archived", bot_budget: "Bot budget reached", run_held: "Run paused on a step",
};
const levelOf = (a: AlertRow): "error" | "warning" => (["frequency_cap", "blank_hold", "bot_budget", "outbox_unknown"].includes(a.kind) ? "warning" : "error");

const openFor = (from: Date, to: Date) => {
  const min = Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000));
  return min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} hour${Math.round(min / 60) === 1 ? "" : "s"}` : `${Math.round(min / 1440)} days`;
};

/** Where an alert is said: its offer's alerts channel (mapped to that offer), else the operator's channel; nowhere if neither is set. */
async function destination(app: SlackApp, a: AlertRow): Promise<{ offerId: string | null; teamId: string; channel: string } | undefined> {
  if (a.offerId) {
    const ch = (await offerSettings(app.db, a.offerId))["slack.channel.alerts"];
    if (typeof ch === "string" && ch) {
      const mapped = (await app.db.select().from(slackChannels).where(and(eq(slackChannels.offerId, a.offerId), eq(slackChannels.channelId, ch))))[0];
      if (mapped && !mapped.archivedAt) return { offerId: a.offerId, teamId: mapped.teamId, channel: ch };
    }
  }
  const op = await operatorChannel(app);
  return op ? { offerId: null, teamId: op.teamId, channel: op.channel } : undefined;
}

export type Announced = { raised: number; repeated: number; resolved: number; quiet: number; checkedFixed: number };

/** The alert sweep (a job every minute): says what is due, as the rules above. */
export async function announceAlerts(app: SlackApp): Promise<Announced> {
  const now = app.now(), rule = await repeatRule(app), out: Announced = { raised: 0, repeated: 0, resolved: 0, quiet: 0, checkedFixed: 0 };
  const rows = await app.db.select({ a: alerts, st: slackAlertState, offerName: offers.name }).from(alerts).leftJoin(slackAlertState, eq(slackAlertState.alertId, alerts.id)).leftJoin(offers, eq(offers.id, alerts.offerId))
    .where(or(isNull(alerts.resolvedAt), and(isNotNull(slackAlertState.ts), isNull(slackAlertState.resolvedSaidAt)))).orderBy(asc(alerts.id));
  const working = inHours(now, rule.hours, rule.zone);
  for (const { a: raw, st, offerName } of rows) {
    const a = raw as AlertRow;
    if ((a.detail as { slackSilent?: boolean }).slackSilent) continue;
    if (!a.resolvedAt && !st) {
      const dest = await destination(app, a);
      if (!dest) continue;   // no channel to say it in: it stays on the dashboard
      await app.db.insert(slackAlertState).values({ alertId: a.id, teamId: dest.teamId, channel: dest.channel, saidCount: 1, lastSaidAt: now }).onConflictDoNothing();
      const sign = (action: string) => signValue(app.env.stateSecret, "button", { o: a.offerId, a: action, v: String(a.id) });
      const m = alertLayout({
        level: levelOf(a), title: `${!dest.offerId && offerName ? `${offerName}: ` : ""}${TITLES[a.kind] ?? "Alert"}`, text: a.message,
        buttons: [{ actionId: "alert_retry", label: "Retry", value: sign("alert_retry") }, { actionId: "alert_resolve", label: "Resolve", value: sign("alert_resolve"), style: "primary" }, { actionId: "alert_pause", label: "Pause", value: sign("alert_pause") }],
      });
      await post(app, dest, `alert:${a.id}:raised`, m, { kind: "alert", tag: `alert:${a.id}` }, a.id);
      out.raised++;
      continue;
    }
    if (!st) continue;
    const thread = st.ts && st.channel && st.teamId ? { offerId: a.offerId && (await destinationIsOffer(app, a, st.channel)) ? a.offerId : null, teamId: st.teamId, channel: st.channel, threadTs: st.ts } : undefined;
    let resolvedAt = a.resolvedAt;
    if (!resolvedAt) {
      if (!thread || st.quiet) continue;   // its first post is not out yet, or only a person can say it is over
      const due = !st.lastSaidAt || now.getTime() - st.lastSaidAt.getTime() >= rule.everyMin * 60_000;
      if (!due) continue;
      const cause = await causeOf(app, a);
      if (cause === "fixed") {
        await app.db.update(alerts).set({ resolvedAt: now }).where(eq(alerts.id, a.id));
        resolvedAt = now; out.checkedFixed++;
      } else if (st.pausedAt) {
        continue;   // paused: never said again while open; its ✅ still comes when it clears
      } else if (cause === "unknown") {
        await app.db.update(slackAlertState).set({ quiet: true, lastSaidAt: now }).where(eq(slackAlertState.alertId, a.id));
        out.quiet++; continue;
      } else {
        if (!working) continue;   // outside the operator's hours: said when they open
        const n = st.saidCount + 1;
        await post(app, thread, `alert:${a.id}:repeat:${n}`, { text: `⏰ Still open (${openFor(a.openedAt, now)}): ${a.message}`, blocks: [{ type: "section", text: { type: "mrkdwn", text: `⏰ Still open · ${openFor(a.openedAt, now)}` } }] }, { kind: "alert", tag: `alert:${a.id}` }, a.id);
        await app.db.update(slackAlertState).set({ saidCount: n, lastSaidAt: now }).where(eq(slackAlertState.alertId, a.id));
        out.repeated++; continue;
      }
    }
    if (resolvedAt && thread && !st.resolvedSaidAt) {
      await post(app, thread, `alert:${a.id}:resolved`, { text: `✅ Resolved (open for ${openFor(a.openedAt, resolvedAt)})`, blocks: [{ type: "section", text: { type: "mrkdwn", text: `✅ Resolved · open for ${openFor(a.openedAt, resolvedAt)}` } }] }, { kind: "alert", tag: `alert:${a.id}` }, a.id);
      await react(app, { offerId: thread.offerId, teamId: thread.teamId, channel: thread.channel, ts: thread.threadTs }, `alert:${a.id}:check`, "white_check_mark", a.id);
      await app.db.update(slackAlertState).set({ resolvedSaidAt: now }).where(eq(slackAlertState.alertId, a.id));
      out.resolved++;
    }
  }
  return out;
}

async function destinationIsOffer(app: SlackApp, a: AlertRow, channel: string) {
  return !!(await app.db.select().from(slackChannels).where(and(eq(slackChannels.offerId, a.offerId!), eq(slackChannels.channelId, channel))))[0];
}

/** Retry, Resolve and Pause on an alert (the platform's own post, or a workflow's post with these buttons): the alert id is in the signed value. */
export async function pressAlert(app: SlackApp, x: BlockAction, v: Pressed, inboxId: number): Promise<string> {
  const where = { offerId: v.o, teamId: x.teamId, user: x.userId, channel: x.channel, responseUrl: x.responseUrl };
  const who = await presserOf(app, v.o, x.teamId, x.userId);
  if (!may(who, "alert")) return refuse(app, x, who, "alert", inboxId);
  const id = Number(v.v);
  const a = Number.isInteger(id) ? (await app.db.select().from(alerts).where(eq(alerts.id, id)))[0] as AlertRow | undefined : undefined;
  if (!a || (a.offerId ?? null) !== (v.o ?? null)) { await tell(app, where, `press:${inboxId}`, "I can't find that alert any more."); return "no alert"; }
  const now = app.now(), zone = a.offerId ? (await offerRow(app.db, a.offerId))!.zone : (await repeatRule(app)).zone;
  const st = (await app.db.select().from(slackAlertState).where(eq(slackAlertState.alertId, a.id)))[0];
  const msg = x.channel && x.ts ? { offerId: v.o, teamId: x.teamId, channel: x.channel, ts: x.ts } : undefined;
  const done = async (line: string, action: string) => {
    if (msg) await settle(app, msg, x.message, `${line} · ${clockTime(now, zone)}`);
    await audit(app.db, { offerId: a.offerId, teamId: x.teamId, userId: x.userId, action: `alert.${action}`, detail: { alert: a.id, key: a.key }, at: now });
    return action;
  };
  if (a.resolvedAt) { await tell(app, where, `press:${inboxId}`, "Already handled: this alert was resolved."); return "stale"; }
  if (x.actionId === "alert_resolve") {
    const r = await app.db.update(alerts).set({ resolvedAt: now }).where(and(eq(alerts.id, a.id), isNull(alerts.resolvedAt))).returning({ id: alerts.id });
    if (!r.length) { await tell(app, where, `press:${inboxId}`, "Already handled: this alert was resolved."); return "stale"; }
    return done(`✅ Resolved by <@${x.userId}>`, "resolved");
  }
  if (x.actionId === "alert_pause") {
    if (st?.pausedAt) { await tell(app, where, `press:${inboxId}`, `Already handled: paused by ${st.pausedBy ?? "someone"}.`); return "stale"; }
    if (st) await app.db.update(slackAlertState).set({ pausedAt: now, pausedBy: `<@${x.userId}>` }).where(eq(slackAlertState.alertId, a.id));
    else await app.db.insert(slackAlertState).values({ alertId: a.id, pausedAt: now, pausedBy: `<@${x.userId}>` });
    return done(`⏸️ Paused by <@${x.userId}>: no more reminders. It still closes here once it's fixed`, "paused");
  }
  if (x.actionId === "alert_retry") {
    const run = a.runId ? await app.engine.store.tx((tx) => tx.run(a.runId!)) : undefined;
    if (!run || run.status !== "paused" || run.wake?.kind !== "hold") {
      await tell(app, where, `press:${inboxId}`, "This alert has no single step to retry. Fix the cause, then press Resolve.");
      return "nothing to retry";
    }
    await app.engine.resume(run.id, "retry");
    return done(`🔁 Retried by <@${x.userId}>`, "retried");
  }
  return "ignored";
}

/** app_uninstalled or tokens_revoked: the workspace is revoked, its offers' Slack connections pause (their posts are held), and the operator is told. */
export async function revokeWorkspace(app: SlackApp, teamId: string, reason: "uninstalled" | "tokens revoked"): Promise<void> {
  const now = app.now();
  const ws = (await app.db.update(slackWorkspaces).set({ revokedAt: now, revokedReason: reason, updatedAt: now }).where(eq(slackWorkspaces.teamId, teamId)).returning())[0];
  if (!ws) return;
  const linked = await offersOfTeam(app.db, teamId);
  for (const o of linked) await app.db.insert(connections).values({ offerId: o.id, port: "slack", status: "paused", reason: `Slack ${reason}`, pausedAt: now }).onConflictDoUpdate({ target: [connections.offerId, connections.port], set: { status: "paused", reason: `Slack ${reason}`, pausedAt: now } });
  await raiseAlert(app.db, { offerId: null, key: `slack-revoked:${teamId}`, kind: "slack_revoked", message: `Slack was ${reason} in ${ws.teamName ?? teamId}${linked.length ? ` (${linked.map((o) => o.name).join(", ")})` : ""}. Its posts are held until the app is installed again (Connect Slack).`, detail: { team: teamId, offers: linked.map((o) => o.id) }, at: now });
  await audit(app.db, { teamId, action: `slack.${reason === "uninstalled" ? "uninstalled" : "tokens_revoked"}`, detail: { offers: linked.map((o) => o.id) }, at: now });
}
