import type { SlackApp } from "./app";
import { type Block, type Message, context } from "./blocks";
import { type PostPayload, type SlackOutKind, enqueueSlack } from "./outbox";

/**
 * What the app says back in Slack, always through the platform's Slack outbox (written, then delivered by a job), each
 * under a key that makes it once: a private line to the person, the original message settled after a press, a reply in
 * a thread, a reaction.
 */
type Where = { offerId: string | null; teamId: string };

async function put(app: SlackApp, w: Where, kind: SlackOutKind, key: string, payload: Record<string, unknown>, alertId?: number) {
  const row = await enqueueSlack(app.db, { offerId: w.offerId, teamId: w.teamId, kind, key, payload: payload as never, alertId: alertId ?? null, now: app.now() });
  if (row.status === "queued") await app.enqueue("slack_outbox", { id: row.id });
  return row;
}

/** A line only the person sees: through the response_url Slack gave the request, else as an ephemeral in the channel. */
export async function tell(app: SlackApp, w: Where & { user: string; channel?: string | null; responseUrl?: string | null; threadTs?: string }, key: string, text: string, blocks?: Block[]) {
  if (w.responseUrl) return put(app, w, "respond", key, { url: w.responseUrl, body: { response_type: "ephemeral", replace_original: false, text, ...(blocks ? { blocks } : {}) } });
  if (w.channel) return put(app, w, "ephemeral", key, { channel: w.channel, user: w.user, text, ...(blocks ? { blocks } : {}), ...(w.threadTs ? { threadTs: w.threadTs } : {}) });
  return undefined;
}

/** The message that was pressed, its buttons gone and a line saying who did what and when. */
export async function settle(app: SlackApp, w: Where & { channel: string; ts: string }, original: { text?: string; blocks?: Block[] } | null, line: string) {
  return put(app, w, "update", `settle:${w.teamId}:${w.channel}:${w.ts}`, { channel: w.channel, ts: w.ts, settleLine: line, ...(original?.blocks?.length ? { original } : {}) });
}

export async function post(app: SlackApp, w: Where & { channel: string; threadTs?: string }, key: string, m: Message, record: PostPayload["record"], alertId?: number, forget?: boolean) {
  return put(app, w, "post", key, { channel: w.channel, text: m.text, blocks: m.blocks, ...(w.threadTs ? { threadTs: w.threadTs } : {}), record, ...(forget ? { forget: true } : {}) }, alertId);
}

export async function react(app: SlackApp, w: Where & { channel: string; ts: string }, key: string, name: string, alertId?: number) {
  return put(app, w, "react", key, { channel: w.channel, ts: w.ts, name }, alertId);
}

export const line = (text: string): Message => ({ text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
export const withContext = (m: Message, ...lines: string[]): Message => ({ text: m.text, blocks: [...m.blocks, context(...lines)] });

/** An ephemeral answer replaced in place (the Send / Cancel under /agreement), through the response_url. */
export async function respondReplace(app: SlackApp, w: Where & { responseUrl?: string | null }, key: string, text: string) {
  if (!w.responseUrl) return undefined;
  return put(app, w, "respond", key, { url: w.responseUrl, body: { response_type: "ephemeral", replace_original: true, text } });
}
