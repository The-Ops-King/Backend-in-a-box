import type { Hub } from "../framework/hub";
import type { Connection } from "../framework/types";
import { GhlApi, targetOf } from "./api";
import { GhlTokens } from "./auth";
import { type GhlPorts, ghlPorts } from "./ports";

/** One GHL client per hub: its rate limiter is per location, shared by every offer and port on that location. */
const apis = new WeakMap<Hub, GhlApi>();
export function ghlApi(hub: Hub): GhlApi {
  let a = apis.get(hub);
  if (!a) { a = new GhlApi(hub, new GhlTokens(hub)); apis.set(hub, a); }
  return a;
}

export async function ghlPortsFor(hub: Hub, conn: Connection): Promise<GhlPorts> {
  return ghlPorts(hub, ghlApi(hub), conn, await hub.fieldMap(conn.offerId, "ghl"));
}

/**
 * A call's transcript from GHL's dialer, as text ("speaker: words" lines), or null when there is none (yet). GHL answers
 * 400 CONVERSATIONS_MSG_RECORDING_NOT_FOUND for a call with no recording; "not yet" and "never" look the same.
 */
export async function ghlTranscript(hub: Hub, conn: Connection, messageId: string): Promise<string | null> {
  const t = targetOf(conn);
  const out = await ghlApi(hub).call(t, { method: "GET", path: `/conversations/locations/${t.locationId}/messages/${encodeURIComponent(messageId)}/transcription`, accept: [400, 404, 422] });
  if ("confirmed" in out || out.status >= 400) return null;
  const b = out.body as unknown;
  const segs = (Array.isArray(b) ? b : Array.isArray((b as { transcription?: unknown }).transcription) ? (b as { transcription: unknown[] }).transcription : []) as { speaker?: unknown; transcript?: unknown; text?: unknown }[];
  const lines = segs.map((s) => ({ speaker: String(s.speaker ?? "?"), text: String(s.transcript ?? s.text ?? "").trim() })).filter((s) => s.text);
  return lines.length ? lines.map((l) => `Speaker ${l.speaker}: ${l.text}`).join("\n") : null;
}
