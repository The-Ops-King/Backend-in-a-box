import type { SlackApp } from "./app";
import { audit, messageAt, updateChannel, workspace } from "./data";
import { raiseAlert } from "./outbox";
import { answerQuestion } from "./bot";
import { may, presserOf, refusal } from "./people";
import { offerOfChannel, routeDm } from "./routing";
import { post, tell } from "./say";
import { signValue } from "./signed";
import { revokeWorkspace } from "./alerts";

/**
 * Slack's events (POST /slack/events), after the ack, as a job. The offer is the channel's (a DM: the person's).
 * - app_uninstalled, tokens_revoked (the bot's): the workspace is revoked, its offers' Slack posts are held, Tyler is told;
 * - member_joined_channel (the bot): the channel's bot_member; channel_rename: its name; channel_archive: the slot is
 *   broken, an alert on its offer;
 * - reaction_added on a question that takes reactions: the answer, from a person who may answer;
 * - app_mention in an offer's channel, message.im: the bot.
 * Message text the bot reads is used for the answer and not kept.
 */
export async function handleEvent(app: SlackApp, body: Record<string, any>, inboxId: number): Promise<string> {
  const teamId = String(body.team_id ?? "");
  const e = (body.event ?? {}) as Record<string, any>;
  const ws = await workspace(app.db, teamId);
  if (!ws) return "unknown workspace";
  const now = app.now();
  switch (e.type) {
    case "app_uninstalled": await revokeWorkspace(app, teamId, "uninstalled"); return "revoked";
    case "tokens_revoked": {
      const bots = (e.tokens?.bot ?? []) as string[];
      if (!bots.length) return "user tokens only";
      await revokeWorkspace(app, teamId, "tokens revoked"); return "revoked";
    }
    case "member_joined_channel": {
      if (e.user !== ws.botUserId) return "someone else joined";
      return (await updateChannel(app.db, teamId, String(e.channel), { botMember: true }, now)) ? "bot member" : "unmapped channel";
    }
    case "channel_rename": {
      const ch = e.channel ?? {};
      return (await updateChannel(app.db, teamId, String(ch.id), { name: String(ch.name ?? "") }, now)) ? "renamed" : "unmapped channel";
    }
    case "channel_archive": {
      const row = await updateChannel(app.db, teamId, String(e.channel), { archivedAt: now }, now);
      if (!row) return "unmapped channel";
      await raiseAlert(app.db, { offerId: row.offerId, key: `slack-archived:${row.channelId}`, kind: "slack_channel_archived", message: `The Slack channel ${row.name ? `#${row.name}` : row.channelId} (${row.slots.join(", ") || "no slot"}) was archived. Posts to it fail until its slot is given another channel.`, detail: { team: teamId, channel: row.channelId, slots: row.slots }, at: now });
      return "archived";
    }
    case "reaction_added": return reaction(app, teamId, ws.botUserId, e, inboxId);
    case "app_mention": return mention(app, teamId, ws.botUserId, e, inboxId);
    case "message": {
      if (e.channel_type !== "im") return "not a DM";
      if (e.bot_id || e.user === ws.botUserId || !e.user) return "own message";
      if (e.subtype && e.subtype !== "file_share") return `message ${e.subtype}`;
      return dm(app, teamId, ws.botUserId, e, inboxId);
    }
    default: return `ignored ${String(e.type ?? "?")}`;
  }
}

const question = (text: string, botUserId: string) => text.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g"), "").trim();

async function mention(app: SlackApp, teamId: string, botUserId: string, e: Record<string, any>, inboxId: number): Promise<string> {
  if (e.bot_id || e.user === botUserId) return "own message";
  const offer = await offerOfChannel(app, teamId, String(e.channel));
  if (!offer) return "unmapped channel";   // a channel that is no offer's: the bot says nothing there
  const text = question(String(e.text ?? ""), botUserId);
  if (!text) return "empty";
  return answerQuestion(app, { teamId, userId: String(e.user), channel: String(e.channel), threadTs: String(e.thread_ts ?? e.ts), text, offer, key: `event:${inboxId}` });
}

async function dm(app: SlackApp, teamId: string, botUserId: string, e: Record<string, any>, inboxId: number): Promise<string> {
  const text = question(String(e.text ?? ""), botUserId);
  if (!text) return "empty";
  const routed = await routeDm(app, teamId, String(e.user), text);
  const where = { offerId: null as string | null, teamId, channel: String(e.channel), ...(e.thread_ts ? { threadTs: String(e.thread_ts) } : {}) };
  if ("none" in routed) {
    // no offer to answer about: said in the DM, belonging to no offer (the DM is the person's own)
    await post(app, { ...where }, `event:${inboxId}`, { text: routed.none, blocks: [{ type: "section", text: { type: "mrkdwn", text: routed.none } }] }, { kind: "bot" });
    return "unrouted";
  }
  if ("pick" in routed) {
    const buttons = routed.pick.slice(0, 5).map((o) => ({ type: "button", action_id: "pick", text: { type: "plain_text", text: o.name }, value: signValue(app.env.stateSecret, "pick", { o: o.id, c: "_bot", t: text.slice(0, 1500), u: String(e.user), ...(e.thread_ts ? { th: String(e.thread_ts) } : {}) }, { now: app.now(), ttlSec: 900 }) }));
    await post(app, { ...where, offerId: routed.pick[0]!.id }, `event:${inboxId}`, { text: "Which offer is this about?", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Which offer is this about?" } }, { type: "actions", block_id: "pick", elements: buttons }] }, { kind: "bot" }, undefined, true);
    return "picker";
  }
  return answerQuestion(app, { teamId, userId: String(e.user), channel: String(e.channel), threadTs: e.thread_ts ? String(e.thread_ts) : undefined, text: routed.text, offer: routed.offer, key: `event:${inboxId}` });
}

/** A reaction on a question that takes reactions as answers: the answer, once, from someone who may answer. */
async function reaction(app: SlackApp, teamId: string, botUserId: string, e: Record<string, any>, inboxId: number): Promise<string> {
  if (e.user === botUserId) return "own reaction";
  const item = e.item ?? {};
  if (item.type !== "message") return "not a message";
  const msg = await messageAt(app.db, teamId, String(item.channel), String(item.ts));
  if (!msg?.offerId || !msg.runId || msg.kind !== "workflow") return "not a question";
  const outbox = await app.engine.store.tx((tx) => tx.outboxRow(msg.outboxId ?? -1));
  if (outbox?.kind !== "slack.ask") return "not a question";
  const allowed = (outbox.payload.answers as { reactions?: string[] } | undefined)?.reactions;
  const value = String(e.reaction ?? "").replace(/::skin-tone-\d$/, "");
  if (!allowed?.includes(value)) return "not an answer";
  const who = await presserOf(app, msg.offerId, teamId, String(e.user));
  if (!may(who, "ask")) {
    await audit(app.db, { offerId: msg.offerId, teamId, userId: String(e.user), action: "slack.refused", detail: { rule: "ask", reaction: value, roles: who.roles }, at: app.now() });
    await tell(app, { offerId: msg.offerId, teamId, user: String(e.user), channel: msg.channel, ...(msg.threadTs ? { threadTs: msg.threadTs } : {}) }, `event:${inboxId}`, refusal("ask"));
    return "refused";
  }
  const earlier = await app.engine.store.tx((tx) => tx.events({ offerId: msg.offerId!, types: ["ask.answered"], runId: msg.runId!, node: msg.node!, limit: 1 }));
  if (earlier[0] || msg.settled) return "already answered";
  await app.engine.answer({ offerId: msg.offerId, channel: msg.channel, ts: msg.ts, value, person: who.personId ?? `slack:${e.user}`, at: app.now(), dedupeKey: `slack:reaction:${teamId}:${msg.channel}:${msg.ts}:${e.user}:${value}` });
  await audit(app.db, { offerId: msg.offerId, teamId, userId: String(e.user), action: "slack.answered", detail: { run: msg.runId, node: msg.node, value, by: "reaction" }, at: app.now() });
  return "answered";
}
