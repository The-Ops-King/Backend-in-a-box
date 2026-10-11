import type { PoolClient } from "pg";
import { many } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import type { Node } from "./definition";

/**
 * D89: a reply is kept as "it came in" plus Jev's read, never its text. The poll stores the message row (ids, channel, when, who)
 * without its body or subject; waking a reply wait, counting replies and the settle and boundary logic need nothing more.
 *
 * A step whose settings read the words (`{{reply.inbound_since_send}}`, `{{reply.last_inbound.body}}`, `.subject`) gets them from
 * GHL by message id just before it runs (`CrmRead.messageBodies`, one read per thread), and the context lets go of them right after,
 * the way D87 treats a transcript (transcripts.ts). The run's context carries only the ids (`reply.message_ids`, the messages since
 * our last send, oldest first; `reply.last_inbound.message_id`). A CRM that does not answer throws, so the step is retried under the
 * failure policy (D66, D77) and never reads an empty text as the reply. What the step leaves behind (its result, a var it set) is
 * scrubbed of the words before anything is saved; the classify event keeps the input's length, not the input.
 */

type Deps = { c: PoolClient; adapters: Adapters; adapterCompany: Company; company: { id: string }; ctx: Record<string, unknown> };

const TEXT_REF = /\{\{[^}]*\breply\.(inbound_since_send|last_inbound\.(body|subject))\b/;
/** Whether a template string reads a reply's words. */
export const mentionsReplyText = (s: string): boolean => TEXT_REF.test(s);
/** Whether a step's settings read a reply's words. */
export const readsReplyText = (node: Node): boolean => mentionsReplyText(JSON.stringify(node));

type Reply = { message_ids?: unknown; last_inbound?: { message_id?: unknown; body?: unknown; subject?: unknown } | null; inbound_since_send?: unknown };

/**
 * Fills `reply.inbound_since_send` (every message since our last send, in order, one per line) and `reply.last_inbound.body` /
 * `.subject` from GHL. Returns the words it put in the context (for `scrubReplyText` and `dropReplies`), or null when the step reads
 * none. With no reply to read, nothing is set and the step sees what it saw before (an empty input: classify skips).
 */
export async function hydrateReplies(d: Deps, node: Node): Promise<string[] | null> {
  if (!readsReplyText(node)) return null;
  const reply = d.ctx.reply as Reply | undefined;
  if (!reply || typeof reply !== "object") return [];
  const since = Array.isArray(reply.message_ids) ? reply.message_ids.filter((x): x is string => typeof x === "string") : [];
  const lastId = typeof reply.last_inbound?.message_id === "string" ? reply.last_inbound.message_id : undefined;
  const ids = [...new Set([...since, ...(lastId ? [lastId] : [])])];
  if (!ids.length) return [];
  // the thread each message is in, so one read of a thread answers all of its messages; a row retention already dropped is read by id
  const rows = await many<{ ghl_message_id: string; ghl_conversation_id: string | null }>(d.c, "select ghl_message_id, ghl_conversation_id from messages where company_id=$1 and ghl_message_id = any($2::text[])", [d.company.id, ids]);
  const conv = new Map(rows.map((r) => [r.ghl_message_id, r.ghl_conversation_id]));
  const words = await d.adapters.read.messageBodies(d.adapterCompany, ids.map((id) => ({ id, conversationId: conv.get(id) ?? null })));
  const held: string[] = [];
  const keep = (t: string | undefined) => { if (t) held.push(t); return t; };
  const joined = since.map((id) => words.get(id)?.body ?? "").filter(Boolean).join("\n");
  if (since.length) reply.inbound_since_send = keep(joined) || undefined;
  if (lastId && reply.last_inbound && typeof reply.last_inbound === "object") {
    const w = words.get(lastId);
    reply.last_inbound.body = keep(w?.body) ?? null;
    if (w?.subject) reply.last_inbound.subject = keep(w.subject);
  }
  for (const id of since) keep(words.get(id)?.body);
  return held;
}

/** Takes the words `hydrateReplies` put in the context back out, so nothing the run saves carries them. */
export function dropReplies(ctx: Record<string, unknown>): void {
  const reply = ctx.reply as Reply | undefined;
  if (!reply || typeof reply !== "object") return;
  delete reply.inbound_since_send;
  if (reply.last_inbound && typeof reply.last_inbound === "object") { delete reply.last_inbound.body; delete reply.last_inbound.subject; }
}

/** Where a reply's words were, in what a step leaves behind. */
export const REDACTED = "[their reply]";

/**
 * Replaces the words of a reply wherever they landed in a value about to be saved (a step's result, a var a step set): each whole
 * text, and (unless `cut: false`) a text cut short at the end of a string (a `would_post` preview is cut at 160 characters). Strings
 * only; the shape stays.
 */
export function scrubReplyText<T>(value: T, texts: string[], opts: { cut?: boolean } = {}): T {
  const ts = [...new Set(texts.filter((t) => t.trim()))].sort((a, b) => b.length - a.length);
  if (!ts.length) return value;
  const scrub = (s: string): string => {
    let out = s;
    for (const t of ts) out = out.split(t).join(REDACTED);
    // a preview cut inside the reply ends with the start of it
    if (opts.cut !== false) for (const t of ts) for (let k = Math.min(t.length - 1, out.length); k >= 2; k--) if (out.endsWith(t.slice(0, k))) { out = out.slice(0, out.length - k) + REDACTED; break; }
    return out;
  };
  const walk = (v: unknown): unknown => typeof v === "string" ? scrub(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(value) as T;
}
