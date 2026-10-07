import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Standard Webhooks (standardwebhooks.com), as Whop and Fathom both send them: headers webhook-id, webhook-timestamp
 * (unix seconds), webhook-signature ("v1,<base64>", several space-separated during key rotation); HMAC-SHA256 over
 * "{id}.{timestamp}.{raw body}". The key is the secret as given; a whsec_ secret is also tried base64-decoded, which is
 * what the spec means by it. Timestamps more than five minutes off are a replay.
 */
export function verifyStandardWebhook(secret: string, headers: { id: string | null; timestamp: string | null; signature: string | null }, raw: string, now = Date.now()): { ok: true } | { ok: false; why: string } {
  if (!headers.id || !headers.timestamp || !headers.signature) return { ok: false, why: "missing webhook headers" };
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return { ok: false, why: "timestamp outside tolerance" };
  const payload = `${headers.id}.${headers.timestamp}.${raw}`;
  const keys: Buffer[] = [Buffer.from(secret, "utf8")];
  if (secret.startsWith("whsec_")) { try { keys.push(Buffer.from(secret.slice(6), "base64")); } catch { /* not base64 */ } }
  const given = headers.signature.split(/\s+/).map((s) => s.replace(/^v1,/, "")).filter(Boolean);
  for (const key of keys) {
    const expected = createHmac("sha256", key).update(payload).digest("base64");
    for (const g of given) { const a = Buffer.from(g), b = Buffer.from(expected); if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true }; }
  }
  return { ok: false, why: "signature mismatch" };
}
export const webhookHeaders = (req: Request) => ({ id: req.headers.get("webhook-id"), timestamp: req.headers.get("webhook-timestamp"), signature: req.headers.get("webhook-signature") });
