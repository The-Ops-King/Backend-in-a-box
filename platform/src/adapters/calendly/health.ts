import { calendly, calendlyAll, uuidOf } from "./client";

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

/**
 * Per-closer availability (D72): who hosts an event type, the schedule the event type uses for each host, and each
 * host's busy times. A round robin's available times are pooled (a time shows when ANY host is free) and do not say
 * which host, so the engine decides per host from these three reads.
 */
export type CalendlyHost = { uri: string; email: string; name: string };
export async function calendlyEventTypeHosts(token: string, eventTypeUri: string, organization?: string): Promise<{ ok: true; duration: number; hosts: CalendlyHost[] } | { ok: false; error: string }> {
  try {
    const { resource } = await calendly<{ resource: { duration: number } }>(token, `/event_types/${uuidOf(eventTypeUri)}`);
    let hosts: CalendlyHost[];
    try {
      const ms = await calendlyAll<{ member: { uri: string; email: string; name?: string } }>(token, `/event_type_memberships?event_type=${encodeURIComponent(eventTypeUri)}&count=100`);
      hosts = ms.map((m) => ({ uri: m.member.uri, email: m.member.email, name: m.member.name ?? m.member.email }));
    } catch (e) {
      // the hosts endpoint takes a personal access token only; else the type is found under each member's own listing (as listCalendars does)
      if (!organization) throw e;
      const members = await calendlyAll<{ user: { uri: string; email: string; name?: string } }>(token, `/organization_memberships?organization=${encodeURIComponent(organization)}&count=100`);
      hosts = [];
      for (const m of members) {
        let types: { uri: string }[] = [];
        try { types = await calendlyAll<{ uri: string }>(token, `/event_types?user=${encodeURIComponent(m.user.uri)}&count=100`); } catch { continue; }
        if (types.some((t) => uuidOf(t.uri) === uuidOf(eventTypeUri))) hosts.push({ uri: m.user.uri, email: m.user.email, name: m.user.name ?? m.user.email });
      }
    }
    return { ok: true, duration: resource.duration, hosts };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 200) }; }
}

/** One schedule as the event type applies it: `user` set when each host has their own, absent when every host shares it. Rules are weekday rules and date overrides, local to `timezone`. */
export type CalendlyRule = { type: "wday" | "date"; wday?: string; date?: string; intervals: { from: string; to: string }[] };
export type CalendlySchedule = { user?: string; timezone: string; rules: CalendlyRule[] };
export async function calendlyEventTypeSchedules(token: string, eventTypeUri: string): Promise<{ ok: true; schedules: CalendlySchedule[] } | { ok: false; error: string }> {
  try {
    const list = await calendlyAll<{ availability_rule?: { timezone?: string; user?: string; rules?: CalendlyRule[] } }>(token, `/event_type_availability_schedules?event_type=${encodeURIComponent(eventTypeUri)}`);
    return { ok: true, schedules: list.flatMap((s) => (s.availability_rule?.timezone ? [{ user: s.availability_rule.user || undefined, timezone: s.availability_rule.timezone, rules: s.availability_rule.rules ?? [] }] : [])) };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 200) }; }
}

/** A host's busy times (Calendly bookings and connected calendars that check for conflicts), at most 7 days. A Calendly booking counts with its buffers. */
export async function calendlyBusyTimes(token: string, userUri: string, from: Date, to: Date): Promise<{ ok: true; busy: { start: string; end: string }[] } | { ok: false; error: string }> {
  try {
    const r = await calendly<{ collection?: { start_time: string; end_time: string; buffered_start_time?: string | null; buffered_end_time?: string | null }[] }>(token, `/user_busy_times?user=${encodeURIComponent(userUri)}&start_time=${encodeURIComponent(from.toISOString())}&end_time=${encodeURIComponent(to.toISOString())}`);
    return { ok: true, busy: (r.collection ?? []).map((b) => ({ start: b.buffered_start_time || b.start_time, end: b.buffered_end_time || b.end_time })) };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 200) }; }
}
