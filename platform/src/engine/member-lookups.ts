/** D316: the live reads `memberCheck` makes, from the offer's own connections. Each is left out when the offer has no such tool. */
import { bookingFor, type Adapters, type Company } from "@/adapters/types";
import { calendly } from "@/adapters/calendly/client";
import { fathomTeamMembers } from "@/adapters/fathom/client";
import type { MemberLookups } from "./member-check";

export function liveMemberLookups(a: { ac: Company; adapters: Adapters; bindings: Record<string, string>; slackToken: string | null; now?: Date }): MemberLookups {
  const { ac, adapters, bindings, slackToken } = a;
  const out: MemberLookups = { ghlUsers: () => adapters.read.listUsers(ac), calendars: () => bookingFor(adapters, ac).listCalendars(ac) };
  if (ac.booking.source === "calendly") {
    const { token, organization } = ac.booking as { token: string; organization: string };
    out.calendlyMember = async (email) => ((await calendly<{ collection?: unknown[] }>(token, `/organization_memberships?organization=${encodeURIComponent(organization)}&email=${encodeURIComponent(email)}`)).collection ?? []).length > 0;
    out.openTimes = async (id) => {
      const now = a.now ?? new Date();
      const q = new URLSearchParams({ event_type: `https://api.calendly.com/event_types/${id}`, start_time: new Date(now.getTime() + 5 * 60e3).toISOString(), end_time: new Date(now.getTime() + 7 * 864e5 - 60e3).toISOString() });
      return ((await calendly<{ collection?: unknown[] }>(token, `/event_type_available_times?${q}`)).collection ?? []).length;
    };
  }
  const n = adapters.notifier;
  if (slackToken) out.slack = {
    find: (email) => n.lookupUserByEmail(slackToken, email),
    active: async (id) => (n.userActive ? n.userActive(slackToken, id) : null),
    members: async (ch) => (n.channelMembers ? n.channelMembers(slackToken, ch) : null),
  };
  const key = bindings["secret.fathom_api_key"];
  if (key) out.fathom = {
    team: () => fathomTeamMembers(key),
    latest: async (email) => {
      if (!adapters.recorder?.meetings) return null;
      const to = a.now ?? new Date(), from = new Date(to.getTime() - 30 * 864e5);
      const ms = await adapters.recorder.meetings(key, from, to);
      const at = ms.filter((m) => ((m.recorded_by as { email?: string } | undefined)?.email ?? "").toLowerCase() === email)
        .map((m) => String(m.recording_start_time ?? m.created_at ?? m.scheduled_start_time ?? "")).filter(Boolean).sort();
      return at.pop() ?? null;
    },
  };
  return out;
}
