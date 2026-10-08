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

/** Bookable slots on a calendar between two instants (GET /calendars/{id}/free-slots, epoch ms). Returns the count, or an error. */
export async function ghlFreeSlots(pit: string, calendarId: string, from: Date, to: Date, timezone: string): Promise<{ ok: true; slots: number; times: string[] } | { ok: false; error: string }> {
  try {
    const r = await ghl<Record<string, unknown>>(pit, "GET", `/calendars/${calendarId}/free-slots?startDate=${from.getTime()}&endDate=${to.getTime()}&timezone=${encodeURIComponent(timezone)}`, { version: "2021-04-15" });
    // the answer is keyed by date: { "2026-10-09": { slots: ["2026-10-09T09:00:00-04:00", …] }, traceId }
    const times: string[] = [];
    for (const [k, v] of Object.entries(r)) { if (k === "traceId") continue; const s = (v as { slots?: unknown[] } | undefined)?.slots; if (Array.isArray(s)) times.push(...s.map(String)); }
    return { ok: true, slots: times.length, times };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 200) }; }
}
