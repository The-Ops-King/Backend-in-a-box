import { ghl } from "./client";

/**
 * Read-only probes for the hourly sweep (D33). Nothing here writes.
 * A closer's Google/Outlook sync dropping is not exposed by GHL as a flag; the symptom is a calendar with no bookable
 * slots. So the calendar check asks for free slots over the next days: an error or an empty answer is the alert.
 */
export async function ghlLocationOk(pit: string, locationId: string): Promise<{ ok: boolean; name?: string; error?: string }> {
  try { const r = await ghl<{ location?: { name?: string } }>(pit, "GET", `/locations/${locationId}`); return { ok: true, name: r.location?.name }; }
  catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 200) }; }
}

/** Bookable slots on a calendar between two instants (GET /calendars/{id}/free-slots, epoch ms), or one team member's (`userId`). Returns the count, or an error. */
export async function ghlFreeSlots(pit: string, calendarId: string, from: Date, to: Date, timezone: string, userId?: string): Promise<{ ok: true; slots: number; times: string[] } | { ok: false; error: string }> {
  try {
    const r = await ghl<Record<string, unknown>>(pit, "GET", `/calendars/${calendarId}/free-slots?startDate=${from.getTime()}&endDate=${to.getTime()}&timezone=${encodeURIComponent(timezone)}${userId ? `&userId=${encodeURIComponent(userId)}` : ""}`, { version: "2021-04-15" });
    // the answer is keyed by date: { "2026-10-09": { slots: ["2026-10-09T09:00:00-04:00", …] }, traceId }
    const times: string[] = [];
    for (const [k, v] of Object.entries(r)) { if (k === "traceId") continue; const s = (v as { slots?: unknown[] } | undefined)?.slots; if (Array.isArray(s)) times.push(...s.map(String)); }
    return { ok: true, slots: times.length, times };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 200) }; }
}

/** The calendar's team (GET /calendars/{id} → calendar.teamMembers[].userId): whose free slots make up its pooled ones (D72). */
export async function ghlCalendarTeam(pit: string, calendarId: string): Promise<{ ok: true; userIds: string[] } | { ok: false; error: string }> {
  try { const r = await ghl<{ calendar?: { teamMembers?: { userId: string }[] } }>(pit, "GET", `/calendars/${calendarId}`, { version: "2021-04-15" }); return { ok: true, userIds: [...new Set((r.calendar?.teamMembers ?? []).map((t) => t.userId).filter(Boolean))] }; }
  catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 200) }; }
}

/**
 * D276: what GHL answers for one dialer call's recording and transcript, as it answers (status and the start of its body), read only.
 * For an offer whose calls never come back with a transcript: a recording that is there with no transcript is GHL's transcription
 * being off; no recording at all is call recording being off; a 401/403 is the token's scopes.
 */
export async function ghlCallMediaProbe(pit: string, locationId: string, messageId: string): Promise<{ recording: { status: number; type: string | null; bytes: number | null; body?: string }; transcript: { status: number; segments: number | null; body?: string } }> {
  const BASE = "https://services.leadconnectorhq.com", headers = { Authorization: `Bearer ${pit}`, Version: "2021-04-15" };
  const rec = await fetch(`${BASE}/conversations/messages/${messageId}/locations/${locationId}/recording`, { headers: { ...headers, Range: "bytes=0-1023" } });
  const recType = rec.headers.get("content-type");
  const recording = { status: rec.status, type: recType, bytes: Number(rec.headers.get("content-range")?.split("/")[1] ?? rec.headers.get("content-length") ?? NaN) || null, ...(recType?.includes("json") || !rec.ok ? { body: (await rec.text()).slice(0, 300) } : {}) };
  if (!recording.body) await rec.body?.cancel();
  const tr = await fetch(`${BASE}/conversations/locations/${locationId}/messages/${messageId}/transcription`, { headers: { ...headers, Accept: "application/json" } });
  const text = await tr.text();
  let segments: number | null = null;
  try { const j = JSON.parse(text) as unknown; segments = Array.isArray(j) ? j.length : Array.isArray((j as { transcription?: unknown[] }).transcription) ? (j as { transcription: unknown[] }).transcription.length : null; } catch { /* not JSON */ }
  return { recording, transcript: { status: tr.status, segments, ...(tr.ok && segments ? {} : { body: text.slice(0, 300) }) } };
}
