import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack signs every request: v0=HMAC-SHA256(signing secret, "v0:<timestamp>:<body>"); five minutes of clock drift allowed. */
export function verifySlackSignature(secret: string, h: { timestamp: string | null; signature: string | null }, raw: string, now = Date.now()): { ok: true } | { ok: false; why: string } {
  if (!h.timestamp || !h.signature) return { ok: false, why: "missing signature headers" };
  const ts = Number(h.timestamp); if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return { ok: false, why: "timestamp outside the five-minute window" };
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${h.timestamp}:${raw}`).digest("hex")}`;
  const a = Buffer.from(expected), b = Buffer.from(h.signature);
  return a.length === b.length && timingSafeEqual(a, b) ? { ok: true } : { ok: false, why: "signature mismatch" };
}

export type SlackReaction = { kind: "reaction"; eventId: string; user: string; reaction: string; channel: string; ts: string; removed: boolean };
export type SlackInbound = { kind: "challenge"; challenge: string } | SlackReaction | { kind: "ignored"; type: string };

/** The two shapes the door understands: Slack's URL check, and a reaction added or removed on a message. */
export function parseSlackEvent(body: unknown): SlackInbound {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.type === "url_verification" && typeof b.challenge === "string") return { kind: "challenge", challenge: b.challenge };
  if (b.type !== "event_callback") return { kind: "ignored", type: String(b.type ?? "?") };
  const e = (b.event ?? {}) as Record<string, unknown>; const item = (e.item ?? {}) as Record<string, unknown>;
  if ((e.type === "reaction_added" || e.type === "reaction_removed") && item.type === "message" && typeof item.channel === "string" && typeof item.ts === "string" && typeof e.user === "string" && typeof e.reaction === "string")
    return { kind: "reaction", eventId: String(b.event_id ?? `${e.event_ts}`), user: e.user, reaction: e.reaction.replace(/::skin-tone-\d$/, ""), channel: item.channel, ts: item.ts, removed: e.type === "reaction_removed" };
  return { kind: "ignored", type: String(e.type ?? b.type ?? "?") };
}
