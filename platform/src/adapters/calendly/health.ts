import { calendly } from "./client";

/**
 * Read-only probes for the hourly sweep (D33).
 * Calendly's API does not list calendar connections directly; a host whose Google/Outlook calendar dropped stops having
 * bookable times, so each mapped event type is asked for its available times over the next 7 days (the API's maximum window).
 * An error or an empty answer on an active type is the alert.
 */
export async function calendlyAvailableTimes(token: string, eventTypeUri: string, from: Date, to: Date): Promise<{ ok: true; slots: number; times: string[] } | { ok: false; error: string }> {
  try {
    const r = await calendly<{ collection?: { status?: string; start_time?: string }[] }>(token, `/event_type_available_times?event_type=${encodeURIComponent(eventTypeUri)}&start_time=${encodeURIComponent(from.toISOString())}&end_time=${encodeURIComponent(to.toISOString())}`);
    const times = (r.collection ?? []).filter((s) => s.status !== "unavailable").map((s) => s.start_time ?? "").filter(Boolean);
    return { ok: true, slots: times.length, times };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 200) }; }
}
