import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The signatures each door checks over the raw body, before anything is kept. A bad one is refused (401) and kept
 * nowhere. Replays outside five minutes are refused where the vendor signs a timestamp.
 */

export type Verdict = { ok: true } | { ok: false; why: string };
const TOLERANCE_S = 300;

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * Standard Webhooks (standardwebhooks.com), as Whop and Fathom send them and as the generic signed door takes them:
 * webhook-id, webhook-timestamp (unix seconds), webhook-signature ("v1,<base64>", several during a key rotation);
 * HMAC-SHA256 over "{id}.{timestamp}.{raw body}". The secret is used as given and, for a whsec_ secret, base64-decoded.
 */
export function verifyStandardWebhook(secret: string, h: { id: string | null; timestamp: string | null; signature: string | null }, raw: string, now: Date): Verdict {
  if (!h.id || !h.timestamp || !h.signature) return { ok: false, why: "missing webhook-id, webhook-timestamp or webhook-signature" };
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > TOLERANCE_S) return { ok: false, why: "timestamp outside five minutes" };
  const payload = `${h.id}.${h.timestamp}.${raw}`;
  const keys = [Buffer.from(secret, "utf8")];
  if (secret.startsWith("whsec_")) keys.push(Buffer.from(secret.slice(6), "base64"));
  const given = h.signature.split(/\s+/).map((s) => s.replace(/^v1,/, "")).filter(Boolean);
  for (const k of keys) {
    const expected = createHmac("sha256", k).update(payload).digest("base64");
    if (given.some((g) => same(g, expected))) return { ok: true };
  }
  return { ok: false, why: "signature mismatch" };
}

export function signStandardWebhook(secret: string, id: string, timestamp: number, raw: string): string {
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64")}`;
}

/** Typeform: `Typeform-Signature: sha256=<base64 of HMAC-SHA256(secret, raw body)>`. Typeform signs no timestamp. */
export function verifyTypeform(secret: string, header: string | null, raw: string): Verdict {
  if (!header) return { ok: false, why: "no Typeform-Signature header" };
  return same(header.trim(), signTypeform(secret, raw)) ? { ok: true } : { ok: false, why: "signature mismatch" };
}
export const signTypeform = (secret: string, raw: string) => `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("base64")}`;

/** Calendly: `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(signing key, "t.raw body")>`. */
export function verifyCalendly(key: string, header: string | null, raw: string, now: Date): Verdict {
  if (!header) return { ok: false, why: "no Calendly-Webhook-Signature header" };
  const parts = Object.fromEntries(header.split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  if (!parts.t || !parts.v1 || !Number.isFinite(t)) return { ok: false, why: "malformed Calendly-Webhook-Signature" };
  if (Math.abs(now.getTime() / 1000 - t) > TOLERANCE_S) return { ok: false, why: "timestamp outside five minutes" };
  return same(parts.v1, createHmac("sha256", key).update(`${parts.t}.${raw}`).digest("hex")) ? { ok: true } : { ok: false, why: "signature mismatch" };
}
export const signCalendly = (key: string, t: number, raw: string) => `t=${t},v1=${createHmac("sha256", key).update(`${t}.${raw}`).digest("hex")}`;

export const standardHeaders = (req: Request) => ({ id: req.headers.get("webhook-id"), timestamp: req.headers.get("webhook-timestamp"), signature: req.headers.get("webhook-signature") });
