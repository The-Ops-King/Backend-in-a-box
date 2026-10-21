import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { outbox, runs } from "@/db/schema";
import { type CallContext, PortError, type SlackButton, type SlackPort } from "@/engine/ports";
import { AUTH_CODES, type SlackApi, SlackApiError, TRANSIENT_CODES } from "./api";
import { type Block, type Button, card } from "./blocks";
import { type Db, recordMessage } from "./data";
import type { SlackEnv } from "./env";
import { signValue } from "./signed";
import { type Target, botToken, workspaceFor } from "./tokens";

/**
 * The platform's Slack port: the engine's SlackPort (post, update, DM, react, unreact) and what the app's own
 * behavior needs besides (open a modal, an ephemeral line, a reply through a response_url). Messages are built from the
 * platform's layouts; a sandbox post says so first. Every post a run made is recorded in slack_messages with its run,
 * step, workflow and tag.
 *
 * Failures, as the engine's dispatcher reads them: a rate limit (HTTP 429) is waited out for its Retry-After, here, up to
 * `maxWaitMs`, and tried again (three times); longer, or still limited, is transient. Slack's own trouble (5xx, a
 * network failure before sending) is transient: the dispatcher tries three times in all, then fails the row with an
 * alert. A token Slack refuses is auth: the offer's Slack connection pauses and its rows wait. A network failure after
 * the request may have reached Slack is ambiguous: never sent again. Anything else Slack refused is permanent, with an
 * alert. Nothing is dropped without one.
 */
export type SlackDeps = { db: Db; api: SlackApi; env: SlackEnv; now: () => Date; sleep?: (ms: number) => Promise<void>; maxWaitMs?: number };

export interface PlatformSlackPort extends SlackPort {
  /** Any Web API method for a workspace, with the same rate-limit and failure handling. */
  send(t: Target, method: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  openModal(t: Target, triggerId: string, view: Record<string, unknown>): Promise<void>;
  respond(url: string, body: Record<string, unknown>): Promise<void>;
}

const RATE_TRIES = 3;

export function toPortError(e: unknown): PortError {
  if (e instanceof PortError) return e;
  if (!(e instanceof SlackApiError)) return new PortError("ambiguous", e instanceof Error ? e.message : String(e));
  if (e.code === "ratelimited") return new PortError("transient", `${e.message}: rate limited, retry after ${e.retryAfterSec ?? 1}s`, 429);
  if (AUTH_CODES.has(e.code)) return new PortError("auth", e.message, e.status);
  if ((e.code === "network" || e.code === "not_json") && e.sent === "maybe") return new PortError("ambiguous", `${e.message}: the request may have reached Slack`, e.status);
  if (TRANSIENT_CODES.has(e.code) || e.status >= 500) return new PortError("transient", e.message, e.status);
  return new PortError("permanent", e.message, e.status);
}

/** The persona: `as` is the name; of several icons one is chosen by the call's key, so a retry wears the same face. */
export function persona(p: { as?: string; icons?: string[] }, key: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.as) out.username = p.as;
  const icons = (p.icons ?? []).filter(Boolean);
  if (icons.length) {
    const icon = icons[createHash("sha256").update(key).digest()[0]! % icons.length]!;
    if (/^https?:\/\//.test(icon)) out.icon_url = icon;
    else out.icon_emoji = icon.startsWith(":") ? icon : `:${icon}:`;
  }
  return out;
}

export function createSlackPort(d: SlackDeps): PlatformSlackPort {
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxWait = d.maxWaitMs ?? 30_000;
  const limitedUntil = new Map<string, number>();

  async function send(t: Target, method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ws = await workspaceFor(d.db, t);
    const token = await botToken(d, ws);
    for (let attempt = 1; ; attempt++) {
      const until = limitedUntil.get(ws.teamId) ?? 0, wait = until - d.now().getTime();
      if (wait > 0) {
        if (wait > maxWait) throw new PortError("transient", `Slack asked to wait ${Math.ceil(wait / 1000)}s (rate limit)`, 429);
        await sleep(wait);
      }
      try {
        return await d.api.call(method, token, args);
      } catch (e) {
        if (e instanceof SlackApiError && e.code === "ratelimited") {
          const ms = (e.retryAfterSec ?? 1) * 1000;
          limitedUntil.set(ws.teamId, d.now().getTime() + ms);
          if (attempt < RATE_TRIES && ms <= maxWait) continue;
        }
        throw toPortError(e);
      }
    }
  }

  /** The run and step an outbox row's call is for (its idempotency key is the row's), for a post's record and its buttons. */
  async function rowOf(c: CallContext) {
    return (await d.db.select({ id: outbox.id, runId: outbox.runId, node: outbox.node, kind: outbox.kind, tag: sql<string | null>`${outbox.payload}->>'remember'`, workflowId: runs.workflowId })
      .from(outbox).innerJoin(runs, eq(runs.id, outbox.runId)).where(eq(outbox.idempotencyKey, c.idempotencyKey)))[0];
  }

  type Answers = { buttons?: { value: string; label: string; style?: "primary" | "danger" }[]; reactions?: string[]; form?: string } | undefined;
  function buttonsOf(c: CallContext, row: Awaited<ReturnType<typeof rowOf>>, buttons: SlackButton[] | undefined, answers: Answers): Button[] {
    const sign = (a: string, v: string) => signValue(d.env.stateSecret, "button", { o: c.offerId, a, v, ...(row ? { r: row.runId, s: row.node } : {}) });
    const out: Button[] = (buttons ?? []).map((b) => ({ actionId: b.action, label: b.label, value: sign(b.action, b.value), ...(b.style === "primary" || b.style === "danger" ? { style: b.style } : {}) }));
    for (const b of answers?.buttons ?? []) out.push({ actionId: "ask", label: b.label, value: sign("ask", b.value), ...(b.style ? { style: b.style } : {}) });
    return out;
  }

  async function record(c: CallContext, row: Awaited<ReturnType<typeof rowOf>>, posted: { channel: string; ts: string; threadTs?: string }, sandbox: boolean) {
    const ws = await workspaceFor(d.db, { offerId: c.offerId });
    await recordMessage(d.db, { offerId: c.offerId, teamId: ws.teamId, channel: posted.channel, ts: posted.ts, threadTs: posted.threadTs ?? null, kind: "workflow", workflowId: row?.workflowId ?? null, runId: row?.runId ?? null, node: row?.node ?? null, tag: row?.tag ?? null, outboxId: row?.id ?? null, sandbox, createdAt: d.now() });
  }

  return {
    send,
    async post(c, p) {
      const row = await rowOf(c);
      const m = card({ text: p.text, buttons: buttonsOf(c, row, p.buttons, p.answers as Answers), sandbox: p.sandbox });
      const r = await send({ offerId: c.offerId }, "chat.postMessage", { channel: p.channel, text: m.text, blocks: m.blocks, ...(p.threadTs ? { thread_ts: p.threadTs } : {}), ...persona(p, c.idempotencyKey), unfurl_links: false });
      const posted = { channel: String(r.channel ?? p.channel), ts: String(r.ts), ...(p.threadTs ? { threadTs: p.threadTs } : {}) };
      await record(c, row, posted, p.sandbox);
      return { channel: posted.channel, ts: posted.ts };
    },
    async dm(c, p) {
      if (!p.user) return null;
      const row = await rowOf(c);
      const im = await send({ offerId: c.offerId }, "conversations.open", { users: p.user });
      const channel = String((im.channel as { id?: string } | undefined)?.id ?? "");
      if (!channel) throw new PortError("permanent", "Slack opened no DM");
      const m = card({ text: p.text, buttons: buttonsOf(c, row, p.buttons, p.answers as Answers) });
      const r = await send({ offerId: c.offerId }, "chat.postMessage", { channel, text: m.text, blocks: m.blocks, ...persona(p, c.idempotencyKey), unfurl_links: false });
      await record(c, row, { channel, ts: String(r.ts) }, false);
      return { channel, ts: String(r.ts) };
    },
    async react(c, p) {
      for (const name of p.emojis) {
        try { await send({ offerId: c.offerId }, "reactions.add", { channel: p.channel, timestamp: p.ts, name: name.replace(/:/g, "") }); }
        catch (e) { if (!(e instanceof PortError && /already_reacted/.test(e.message))) throw e; }
      }
    },
    async unreact(c, p) {
      for (const name of p.emojis) {
        try { await send({ offerId: c.offerId }, "reactions.remove", { channel: p.channel, timestamp: p.ts, name: name.replace(/:/g, "") }); }
        catch (e) { if (!(e instanceof PortError && /no_reaction/.test(e.message))) throw e; }
      }
    },
    async update(c, p) {
      const row = await rowOf(c);
      const m = card({ text: p.text, buttons: buttonsOf(c, row, p.buttons, undefined) });
      await send({ offerId: c.offerId }, "chat.update", { channel: p.channel, ts: p.ts, text: m.text, blocks: m.blocks });
    },
    async openModal(t, triggerId, view) { await send(t, "views.open", { trigger_id: triggerId, view }); },
    async respond(url, body) {
      try { await d.api.respond(url, body); } catch (e) { throw toPortError(e); }
    },
  };
}

export type { Block };
