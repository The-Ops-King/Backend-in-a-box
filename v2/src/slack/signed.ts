import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Values the platform puts into Slack and reads back: the install `state`, a button's `value`, a modal's
 * `private_metadata`. Each is `<payload>.<mac>`, base64url, the MAC an HMAC-SHA256 under SLACK_STATE_SECRET over the
 * payload, so the offer, run and step a press names are ours, never something a person could type. `p` says what the
 * value is for, so one kind is never accepted as another; `exp` (seconds) ends it.
 */
export type Purpose = "install" | "button" | "modal" | "pick";

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest().subarray(0, 18);

export function signValue(secret: string, purpose: Purpose, payload: Record<string, unknown>, x: { now?: Date; ttlSec?: number } = {}): string {
  const now = Math.floor((x.now ?? new Date()).getTime() / 1000);
  const body = b64(JSON.stringify({ ...payload, p: purpose, ...(x.ttlSec ? { exp: now + x.ttlSec } : {}) }));
  return `${body}.${b64(mac(secret, body))}`;
}

export function openValue<T extends Record<string, unknown> = Record<string, unknown>>(secret: string, purpose: Purpose, value: string | null | undefined, now: Date = new Date()): T | null {
  if (!value || typeof value !== "string") return null;
  const [body, sig, extra] = value.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const want = mac(secret, body), got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let data: Record<string, unknown>;
  try { data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!data || typeof data !== "object" || data.p !== purpose) return null;
  if (typeof data.exp === "number" && data.exp < Math.floor(now.getTime() / 1000)) return null;
  return data as T;
}

export const nonce = () => randomBytes(9).toString("base64url");
