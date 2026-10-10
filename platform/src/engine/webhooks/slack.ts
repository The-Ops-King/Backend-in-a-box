import { createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { one } from "@/db/client";
import { dispatchEvent, emitEvent } from "../dispatch";
import type { SlackMessage } from "../bot";

/** Slack signs every request: v0=HMAC-SHA256(signing secret, "v0:<timestamp>:<body>"); five minutes of clock drift allowed. */
export function verifySlackSignature(secret: string, h: { timestamp: string | null; signature: string | null }, raw: string, now = Date.now()): { ok: true } | { ok: false; why: string } {
  if (!h.timestamp || !h.signature) return { ok: false, why: "missing signature headers" };
  const ts = Number(h.timestamp); if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return { ok: false, why: "timestamp outside the five-minute window" };
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${h.timestamp}:${raw}`).digest("hex")}`;
  const a = Buffer.from(expected), b = Buffer.from(h.signature);
  return a.length === b.length && timingSafeEqual(a, b) ? { ok: true } : { ok: false, why: "signature mismatch" };
}

export type SlackReaction = { kind: "reaction"; eventId: string; user: string; reaction: string; channel: string; ts: string; removed: boolean };
export type SlackQuestion = { kind: "message" } & SlackMessage;
export type SlackInbound = { kind: "challenge"; challenge: string } | SlackReaction | SlackQuestion | { kind: "ignored"; type: string };

/** The shapes the door understands: Slack's URL check, a reaction added or removed on a message, and a message for the bot (a mention, a DM, a reply in a thread; D70). */
export function parseSlackEvent(body: unknown): SlackInbound {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.type === "url_verification" && typeof b.challenge === "string") return { kind: "challenge", challenge: b.challenge };
  if (b.type !== "event_callback") return { kind: "ignored", type: String(b.type ?? "?") };
  const e = (b.event ?? {}) as Record<string, unknown>; const item = (e.item ?? {}) as Record<string, unknown>;
  if ((e.type === "reaction_added" || e.type === "reaction_removed") && item.type === "message" && typeof item.channel === "string" && typeof item.ts === "string" && typeof e.user === "string" && typeof e.reaction === "string")
    return { kind: "reaction", eventId: String(b.event_id ?? `${e.event_ts}`), user: e.user, reaction: e.reaction.replace(/::skin-tone-\d$/, ""), channel: item.channel, ts: item.ts, removed: e.type === "reaction_removed" };
  if ((e.type === "app_mention" || e.type === "message") && typeof e.channel === "string" && typeof e.ts === "string" && (typeof e.user === "string" || typeof e.bot_id === "string"))
    return { kind: "message", eventId: String(b.event_id ?? `${e.channel}:${e.ts}:${e.type}`), teamId: typeof b.team_id === "string" ? b.team_id : undefined, type: e.type, channel: e.channel,
      channelType: typeof e.channel_type === "string" ? e.channel_type : undefined, user: typeof e.user === "string" ? e.user : undefined, botId: typeof e.bot_id === "string" ? e.bot_id : undefined,
      subtype: typeof e.subtype === "string" ? e.subtype : undefined, text: typeof e.text === "string" ? e.text : "", ts: e.ts, threadTs: typeof e.thread_ts === "string" ? e.thread_ts : undefined };
  return { kind: "ignored", type: String(e.type ?? b.type ?? "?") };
}

export type ReactionOutcome = { ignored: string } | { event: number; runs_started: number; runs_woken: number };
/**
 * A reaction on a post the engine remembered under a tag becomes a `slack.reaction` event (D45): who tapped (by name when
 * on the roster), the tag's kind and ref, the run's contact and appointment. Workflows may start from it, and a run parked
 * on a `wait_for_reaction` for that very post wakes now (D53); its step reads the tap from the event. Removals and the
 * bot's own reactions are not facts.
 */
export async function reactionArrived(c: PoolClient, companyId: string, ev: SlackReaction): Promise<ReactionOutcome> {
  if (ev.removed) return { ignored: "reaction_removed" };
  const conn = await one<{ bot_user_id: string | null }>(c, "select bot_user_id from slack_connections where company_id=$1", [companyId]);
  if (conn?.bot_user_id && conn.bot_user_id === ev.user) return { ignored: "own reaction" };
  const post = await one<{ tag: string; run_id: string | null }>(c, "select tag, run_id from slack_posts where company_id=$1 and channel=$2 and ts=$3", [companyId, ev.channel, ev.ts]);
  if (!post) return { ignored: "not a post the engine remembers" };
  const run = post.run_id ? await one<{ contact_id: string | null; appointment_id: string | null; opportunity_id: string | null }>(c, "select contact_id, appointment_id, opportunity_id from runs where id=$1", [post.run_id]) : null;
  const who = await one<{ name: string }>(c, "select name from users where company_id=$1 and slack_user_id=$2", [companyId, ev.user]);
  const [kind, ...rest] = post.tag.split(":"); const ref = rest.join(":");
  const event = await emitEvent(c, { company_id: companyId, contact_id: run?.contact_id ?? null, opportunity_id: run?.opportunity_id ?? null, appointment_id: run?.appointment_id ?? null, event_type: "slack.reaction", source: "slack",
    data: { reaction: ev.reaction, user: ev.user, user_name: who?.name ?? "a team member", tag: post.tag, kind, ref, channel: ev.channel, ts: ev.ts } });
  const started = await dispatchEvent(c, event, { contact: run?.contact_id ? { id: run.contact_id } : undefined, appointment: run?.appointment_id ? { id: run.appointment_id } : undefined });
  const woken = await c.query("update runs set next_run_at=now() where company_id=$1 and status='waiting' and wake_on_tag=$2", [companyId, post.tag]);
  return { event: event.id, runs_started: started.length, runs_woken: woken.rowCount ?? 0 };
}
