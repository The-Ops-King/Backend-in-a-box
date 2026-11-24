/**
 * D365: a Zoom "Webhook only" app, per offer (secret.zoom_webhook). Zoom signs every request as
 * v0=HMAC_SHA256(secret, "v0:{x-zm-request-timestamp}:{raw body}") in x-zm-signature, and proves the endpoint by asking it to answer
 * endpoint.url_validation with HMAC_SHA256(secret, plainToken). The same rules the TRC dashboard's receiver has kept since Nov 11.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const hmacHex = (secret: string, message: string) => createHmac("sha256", secret).update(message).digest("hex");
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** True when the request really comes from Zoom and is recent (5 minutes, against replays). */
export function zoomSignatureOk(secret: string, raw: string, timestamp: string | null, signature: string | null, nowMs = Date.now()): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts * 1000) > 5 * 60_000) return false;
  return same(signature, `v0=${hmacHex(secret, `v0:${timestamp}:${raw}`)}`);
}

export const urlValidationAnswer = (secret: string, plainToken: string) => ({ plainToken, encryptedToken: hmacHex(secret, plainToken) });

type ZoomBody = {
  event?: string;
  payload?: { plainToken?: string; object?: { id?: string | number; uuid?: string; topic?: string; start_time?: string; end_time?: string;
    participant?: { email?: string; user_name?: string; join_time?: string; leave_time?: string; participant_user_id?: string; id?: string } } };
};

export type ZoomEvent =
  | { kind: "participant"; event: "joined" | "left"; meetingId: string; uuid: string; topic: string | null; meetingStart: Date | null; key: string; email: string | null; name: string | null; at: Date }
  | { kind: "ended"; meetingId: string; uuid: string; topic: string | null; meetingStart: Date | null; endedAt: Date };

/** The event, or why it is not one the engine uses (webinars, other events). */
export function parseZoomEvent(body: ZoomBody, now = new Date()): { ok: true; event: ZoomEvent } | { ok: false; why: string } {
  const o = body.payload?.object;
  if (!o?.uuid || o.id === undefined) return { ok: false, why: "no meeting in the event" };
  const base = { meetingId: String(o.id), uuid: o.uuid, topic: o.topic ?? null, meetingStart: o.start_time ? new Date(o.start_time) : null };
  if (body.event === "meeting.ended") return { ok: true, event: { kind: "ended", ...base, endedAt: o.end_time ? new Date(o.end_time) : now } };
  if (body.event !== "meeting.participant_joined" && body.event !== "meeting.participant_left") return { ok: false, why: `not used: ${body.event ?? "no event"}` };
  const p = o.participant;
  if (!p) return { ok: false, why: "no participant in the event" };
  const email = p.email?.trim().toLowerCase() || null, name = p.user_name?.trim() || null;
  const key = email ?? (name ? `name:${name.toLowerCase()}` : null);
  const joined = body.event.endsWith("joined");
  const at = joined ? p.join_time : p.leave_time;
  if (!key || !at) return { ok: false, why: "participant without a name or a time" };
  return { ok: true, event: { kind: "participant", event: joined ? "joined" : "left", ...base, key, email, name, at: new Date(at) } };
}

/** Note-taker bots are not people on the call ("Nick's Fathom Notetaker"). */
export const ZOOM_BOT = /notetaker|note taker|fathom|otter|fireflies|read\.ai|tl;dv|tldv|recorder|\bbot\b/i;
