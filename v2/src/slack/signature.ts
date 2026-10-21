import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack's clock and ours may differ by this much; an older request is refused (a replay). */
export const WINDOW_SEC = 300;

/**
 * Slack signs every request: `v0=` HMAC-SHA256 of `v0:<timestamp>:<raw body>` under the app's signing secret, in
 * X-Slack-Signature, with the timestamp in X-Slack-Request-Timestamp. Checked over the raw bytes before anything reads
 * the body; a timestamp outside five minutes is refused whatever the signature.
 */
export function verifySlackRequest(secret: string, h: { timestamp: string | null; signature: string | null }, raw: string, now: Date = new Date()): { ok: true } | { ok: false; why: string } {
  if (!h.timestamp || !h.signature) return { ok: false, why: "missing signature headers" };
  if (!/^\d+$/.test(h.timestamp)) return { ok: false, why: "the timestamp is not a number" };
  if (Math.abs(now.getTime() / 1000 - Number(h.timestamp)) > WINDOW_SEC) return { ok: false, why: "timestamp outside the five-minute window" };
  const expected = Buffer.from(signRequest(secret, h.timestamp, raw));
  const got = Buffer.from(h.signature);
  return expected.length === got.length && timingSafeEqual(expected, got) ? { ok: true } : { ok: false, why: "signature mismatch" };
}

/** The signature Slack sends for a body at a timestamp (what a test or a recorded request carries). */
export const signRequest = (secret: string, timestamp: string, raw: string) => `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
