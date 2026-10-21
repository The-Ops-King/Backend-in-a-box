import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import { alerts, connections, slackAlertState, slackChannels, slackOutbox } from "@/db/schema";
import { backoff, MAX_TRIES } from "@/engine/dispatcher";
import { PortError } from "@/engine/ports";
import { settled } from "./blocks";
import { type Db, recordMessage, workspace, workspaceOf } from "./data";
import type { PlatformSlackPort } from "./port";

/**
 * The platform's own Slack outbox: what the app says that no run asked for (an alert, its repeats and its ✅, the bot's
 * answers, a press's edit of the message it answered, a reply through a response_url). Written first with its key, so
 * saying it twice is one row; delivered after, outside any transaction. Its gate: nothing goes through a workspace that
 * is revoked or an offer whose Slack connection is paused (the row waits, nothing is lost), and a post goes only to one
 * of the offer's own channels, a DM, or, for what belongs to no offer, the operator's channel. Failures as the engine's
 * outbox: transient tried three times in all with backoff, then failed with an alert; ambiguous is unknown, never sent
 * again, with an alert; auth pauses the connection.
 */
export type SlackOutKind = "post" | "update" | "react" | "respond" | "ephemeral";
export type SlackOutRow = typeof slackOutbox.$inferSelect;

/** `forget`: once sent, its blocks are not kept (they carry what a person wrote, such as the question under a picker). */
export type PostPayload = { channel: string; text: string; blocks?: unknown[]; threadTs?: string; as?: string; icons?: string[]; record: { kind: "alert" | "bot" | "command" | "support"; tag?: string }; forget?: boolean };
/** An edit: the words given, or (`settleLine`) the message as Slack holds it now, its buttons gone and that line added. */
export type UpdatePayload = { channel: string; ts: string; text?: string; blocks?: unknown[]; settleLine?: string; original?: { text?: string; blocks?: unknown[] } };
export type ReactPayload = { channel: string; ts: string; name: string };
export type RespondPayload = { url: string; body: Record<string, unknown> };
export type EphemeralPayload = { channel: string; user: string; text: string; blocks?: unknown[]; threadTs?: string };

export type OutDeps = { db: Db; port: PlatformSlackPort; now: () => Date; random?: () => number; operatorChannel?: () => Promise<{ teamId: string; channel: string } | undefined> };

export async function enqueueSlack(db: Db, x: { offerId: string | null; teamId?: string | null; kind: SlackOutKind; key: string; payload: PostPayload | UpdatePayload | ReactPayload | RespondPayload | EphemeralPayload; alertId?: number | null; now: Date }): Promise<SlackOutRow> {
  const rows = await db.insert(slackOutbox).values({ offerId: x.offerId, teamId: x.teamId ?? null, kind: x.kind, idempotencyKey: x.key, payload: x.payload, alertId: x.alertId ?? null, createdAt: x.now, nextAttemptAt: x.now })
    .onConflictDoNothing({ target: slackOutbox.idempotencyKey }).returning();
  return rows[0] ?? (await db.select().from(slackOutbox).where(eq(slackOutbox.idempotencyKey, x.key)))[0]!;
}

const scoped = (offerId: string | null, key: string) => `${offerId ?? "platform"}:${key}`;

/** Opens an alert unless one with its key is open (the engine's alerts table: one open alert per key). */
export async function raiseAlert(db: Db, a: { offerId: string | null; key: string; kind: string; message: string; detail?: Record<string, unknown>; runId?: string | null; outboxId?: number | null; at: Date }): Promise<{ id: number; raised: boolean }> {
  const key = scoped(a.offerId, a.key);
  const rows = await db.insert(alerts).values({ offerId: a.offerId, key, kind: a.kind, message: a.message, detail: a.detail ?? {}, runId: a.runId ?? null, outboxId: a.outboxId ?? null, openedAt: a.at })
    .onConflictDoNothing({ target: alerts.key, where: isNull(alerts.resolvedAt) }).returning({ id: alerts.id });
  if (rows[0]) return { id: rows[0].id, raised: true };
  return { id: (await db.select({ id: alerts.id }).from(alerts).where(and(eq(alerts.key, key), isNull(alerts.resolvedAt))))[0]!.id, raised: false };
}
export async function resolveAlertKey(db: Db, offerId: string | null, key: string, at: Date): Promise<void> {
  await db.update(alerts).set({ resolvedAt: at }).where(and(eq(alerts.key, scoped(offerId, key)), isNull(alerts.resolvedAt)));
}

/** Whether the row may go now: "go", "wait" (the workspace or connection is paused), or a reason it never may. */
async function platformGate(d: OutDeps, row: SlackOutRow): Promise<"go" | "wait" | { refuse: string }> {
  const ws = row.offerId ? await workspaceOf(d.db, row.offerId) : row.teamId ? await workspace(d.db, row.teamId) : undefined;
  if (!ws || ws.revokedAt) return "wait";
  if (row.offerId && (await d.db.select().from(connections).where(and(eq(connections.offerId, row.offerId), eq(connections.port, "slack"))))[0]?.status === "paused_auth") return "wait";
  if (row.kind !== "post" && row.kind !== "ephemeral") return "go";
  const channel = (row.payload as PostPayload).channel;
  if (/^D[A-Z0-9-]+$/.test(channel)) return "go";   // a DM: Slack gives each one an id starting with D
  if (row.offerId) {
    const mapped = (await d.db.select().from(slackChannels).where(and(eq(slackChannels.teamId, ws.teamId), eq(slackChannels.channelId, channel))))[0];
    return mapped?.offerId === row.offerId ? "go" : { refuse: `the channel ${channel} is not one of the offer's channels` };
  }
  const op = await d.operatorChannel?.();
  return op && op.teamId === ws.teamId && op.channel === channel ? "go" : { refuse: `the channel ${channel} is not the operator's channel` };
}

/** Delivers one row if it is due. Gives back what happened to it. */
export async function deliverSlack(d: OutDeps, id: number): Promise<"sent" | "waiting" | "retry" | "failed" | "unknown" | "skipped"> {
  const now = d.now();
  const claimed = await d.db.transaction(async (t) => {
    const row = (await t.select().from(slackOutbox).where(eq(slackOutbox.id, id)).for("update", { skipLocked: true }))[0];
    if (!row || row.status !== "queued" || (row.nextAttemptAt && row.nextAttemptAt > now)) return undefined;
    await t.update(slackOutbox).set({ status: "sending", attempts: row.attempts + 1 }).where(eq(slackOutbox.id, id));
    return { ...row, attempts: row.attempts + 1 };
  });
  if (!claimed) return "skipped";
  const gate = await platformGate(d, claimed);
  // held, not lost: it waits (no next attempt) until the workspace is installed again or the connection is fixed
  if (gate === "wait") { await d.db.update(slackOutbox).set({ status: "queued", attempts: claimed.attempts - 1, nextAttemptAt: null }).where(eq(slackOutbox.id, id)); return "waiting"; }
  if (typeof gate === "object") return fail(d, claimed, new PortError("permanent", gate.refuse));
  const target = claimed.offerId ? { offerId: claimed.offerId } : { teamId: claimed.teamId! };
  let result: Record<string, unknown> = {};
  try {
    switch (claimed.kind) {
      case "post": {
        const p = claimed.payload as PostPayload;
        const r = await d.port.send(target, "chat.postMessage", { channel: p.channel, text: p.text, ...(p.blocks ? { blocks: p.blocks } : {}), ...(p.threadTs ? { thread_ts: p.threadTs } : {}), ...(p.as ? { username: p.as } : {}), ...(p.icons?.[0] ? { icon_emoji: p.icons[0] } : {}), unfurl_links: false });
        result = { channel: String(r.channel ?? p.channel), ts: String(r.ts) };
        const ws = claimed.offerId ? await workspaceOf(d.db, claimed.offerId) : await workspace(d.db, claimed.teamId!);
        await recordMessage(d.db, { offerId: claimed.offerId, teamId: ws!.teamId, channel: result.channel as string, ts: result.ts as string, threadTs: p.threadTs ?? null, kind: p.record.kind, tag: p.record.tag ?? null, alertId: claimed.alertId, createdAt: d.now() });
        // an alert's first post: its thread is where it is said again
        if (claimed.alertId && !p.threadTs) await d.db.update(slackAlertState).set({ teamId: ws!.teamId, channel: result.channel as string, ts: result.ts as string }).where(eq(slackAlertState.alertId, claimed.alertId));
        break;
      }
      case "update": {
        const p = claimed.payload as UpdatePayload;
        let m = { text: p.text ?? "", blocks: p.blocks };
        if (p.settleLine) {
          const now = p.original?.blocks?.length ? p.original : await current(d, target, p.channel, p.ts);
          m = settled((now ?? { text: "" }) as never, p.settleLine);
        }
        await d.port.send(target, "chat.update", { channel: p.channel, ts: p.ts, text: m.text, ...(m.blocks ? { blocks: m.blocks } : {}) });
        break;
      }
      case "react": {
        const p = claimed.payload as ReactPayload;
        try { await d.port.send(target, "reactions.add", { channel: p.channel, timestamp: p.ts, name: p.name }); }
        catch (e) { if (!(e instanceof PortError && /already_reacted/.test(e.message))) throw e; }
        break;
      }
      case "respond": { const p = claimed.payload as RespondPayload; await d.port.respond(p.url, p.body); break; }
      case "ephemeral": { const p = claimed.payload as EphemeralPayload; await d.port.send(target, "chat.postEphemeral", { channel: p.channel, user: p.user, text: p.text, ...(p.blocks ? { blocks: p.blocks } : {}), ...(p.threadTs ? { thread_ts: p.threadTs } : {}) }); break; }
    }
  } catch (e) {
    return fail(d, claimed, e);
  }
  const forget = claimed.kind === "post" && (claimed.payload as PostPayload).forget;
  await d.db.update(slackOutbox).set({ status: "sent", result, settledAt: d.now(), lastError: null, ...(forget ? { payload: { ...(claimed.payload as PostPayload), blocks: [] } } : {}) }).where(eq(slackOutbox.id, id));
  return "sent";
}

/** A message as Slack holds it now (to settle it without keeping its words). */
async function current(d: OutDeps, target: { offerId: string } | { teamId: string }, channel: string, ts: string): Promise<{ text?: string; blocks?: unknown[] } | undefined> {
  for (const method of ["conversations.history", "conversations.replies"]) {
    const r = await d.port.send(target, method, method === "conversations.history" ? { channel, latest: ts, inclusive: true, limit: 1 } : { channel, ts, limit: 1 });
    const m = ((r.messages ?? []) as { ts?: string; text?: string; blocks?: unknown[] }[]).find((x) => x.ts === ts);
    if (m) return { text: m.text ?? "", blocks: m.blocks ?? [] };
  }
  return undefined;
}

async function fail(d: OutDeps, row: SlackOutRow, e: unknown): Promise<"retry" | "failed" | "unknown" | "waiting"> {
  const err = e instanceof PortError ? e : new PortError("ambiguous", e instanceof Error ? e.message : String(e));
  const now = d.now(), message = err.message.slice(0, 500);
  // an alert about a post that was itself an alert's is kept on the dashboard only, so a broken Slack does not feed itself
  const detail = { slackOutboxId: row.id, kind: row.kind, ...(row.alertId ? { slackSilent: true } : {}) };
  if (err.failure === "auth") {
    if (row.offerId) await d.db.insert(connections).values({ offerId: row.offerId, port: "slack", status: "paused_auth", reason: message, pausedAt: now }).onConflictDoUpdate({ target: [connections.offerId, connections.port], set: { status: "paused_auth", reason: message, pausedAt: now } });
    await raiseAlert(d.db, { offerId: row.offerId, key: "auth:slack", kind: "connection_auth", message: `The Slack connection refused its token; Slack posts wait until it is fixed: ${message}`, detail, at: now });
    await d.db.update(slackOutbox).set({ status: "queued", attempts: row.attempts - 1, lastError: message, nextAttemptAt: null }).where(eq(slackOutbox.id, row.id));
    return "waiting";
  }
  if (err.failure === "transient" && row.attempts < MAX_TRIES) {
    await d.db.update(slackOutbox).set({ status: "queued", lastError: message, nextAttemptAt: new Date(now.getTime() + backoff(row.attempts, d.random ?? Math.random)) }).where(eq(slackOutbox.id, row.id));
    return "retry";
  }
  const unknown = err.failure === "ambiguous";
  await d.db.update(slackOutbox).set({ status: unknown ? "unknown" : "failed", lastError: message, settledAt: now }).where(eq(slackOutbox.id, row.id));
  await raiseAlert(d.db, {
    offerId: row.offerId, key: `slack-out:${row.id}`, kind: unknown ? "outbox_unknown" : "outbox_failed",
    message: unknown ? `It is not known whether a Slack ${row.kind} went out; it will not be sent again: ${message}` : `A Slack ${row.kind} failed${err.failure === "transient" ? ` after ${row.attempts} tries` : ""}: ${message}`, detail, at: now,
  });
  return unknown ? "unknown" : "failed";
}

/** Everything due now, once each. */
export async function deliverDueSlack(d: OutDeps, limit = 200): Promise<number> {
  const due = await d.db.select({ id: slackOutbox.id }).from(slackOutbox).where(and(eq(slackOutbox.status, "queued"), lte(slackOutbox.nextAttemptAt, d.now()))).orderBy(asc(slackOutbox.id)).limit(limit);
  let n = 0;
  for (const r of due) if ((await deliverSlack(d, r.id)) === "sent") n++;
  return n;
}

/** Rows held for a workspace or its offers (after it is installed again): due now. */
export async function wakeSlackRows(db: Db, x: { offerIds: string[]; teamId: string }, now: Date): Promise<void> {
  if (x.offerIds.length) await db.update(slackOutbox).set({ nextAttemptAt: now }).where(and(eq(slackOutbox.status, "queued"), inArray(slackOutbox.offerId, x.offerIds)));
  await db.update(slackOutbox).set({ nextAttemptAt: now }).where(and(eq(slackOutbox.status, "queued"), eq(slackOutbox.teamId, x.teamId)));
}
