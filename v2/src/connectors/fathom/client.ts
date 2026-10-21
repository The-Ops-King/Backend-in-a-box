import { PortError } from "@/engine/ports";
import { attemptOnce, failFor, withPolicy } from "../framework/http";
import type { Hub } from "../framework/hub";
import type { Connection, J } from "../framework/types";

/**
 * Fathom's external API (v1's fathom/client.ts, verified 2026-10-14): base https://api.fathom.ai/external/v1, header
 * X-Api-Key. Reads only: a recording's transcript, and the meetings recorded in a window (the reconcile).
 */
export const FATHOM_BASE = "https://api.fathom.ai/external/v1";

async function get(hub: Hub, conn: Connection, path: string, accept: number[] = []): Promise<{ status: number; body: unknown }> {
  const key = conn.credentials.api_key;
  if (!key) throw new PortError("auth", "the Fathom connection has no API key");
  const out = await withPolicy(hub.http, "Fathom", () => attemptOnce(hub.http, `${FATHOM_BASE}${path}`, { method: "GET", headers: { "x-api-key": key, accept: "application/json" } }, 20_000), { write: false });
  if ("confirmed" in out) throw new Error("unreachable");
  if (out.res.status >= 400 && !accept.includes(out.res.status)) throw failFor("Fathom", out.res, `GET ${path.split("?")[0]}`);
  return { status: out.res.status, body: out.res.body };
}

/** One recording's transcript as text, or null when Fathom has none for it. UNVERIFIED live: the endpoint's shape (v1 to-verify). */
export async function fathomTranscript(hub: Hub, conn: Connection, recordingId: string): Promise<string | null> {
  const r = await get(hub, conn, `/recordings/${encodeURIComponent(recordingId)}/transcript`, [404]);
  if (r.status === 404) return null;
  const b = r.body as { transcript?: unknown } | unknown[];
  const lines = (Array.isArray(b) ? b : Array.isArray((b as { transcript?: unknown }).transcript) ? (b as { transcript: unknown[] }).transcript : []) as J[];
  const text = lines.map((l) => { const sp = (l.speaker ?? {}) as J; return { speaker: typeof l.speaker === "string" ? l.speaker : String(sp.display_name ?? "Speaker"), text: String(l.text ?? "").trim() }; })
    .filter((l) => l.text).map((l) => `${l.speaker}: ${l.text}`).join("\n");
  return text || null;
}

/** Every meeting recorded between two times, without transcripts: `GET /meetings?created_after=&cursor=` (newest first). */
export async function fathomMeetings(hub: Hub, conn: Connection, from: Date, to: Date): Promise<J[]> {
  const out: J[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 40; page++) {
    const q = new URLSearchParams({ created_after: new Date(from.getTime() - 86_400_000).toISOString(), include_transcript: "false" });
    if (cursor) q.set("cursor", cursor);
    const r = await get(hub, conn, `/meetings?${q}`);
    const body = r.body as { items?: J[]; next_cursor?: string | null };
    for (const m of body.items ?? []) {
      const at = Date.parse(String(m.recording_start_time ?? m.scheduled_start_time ?? m.created_at ?? ""));
      if (at >= from.getTime() && at <= to.getTime()) out.push(m);
    }
    if (!body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return out;
}
