import { calendly, calendlyPost, uuidOf } from "./client";

/**
 * D310: a new team member's own calendar, made as a copy of a teammate's (Tyler: "create her a 15 and 45 min calendar").
 * Calendly's create endpoint takes only owner, name, duration, description, locations, color and active, so that much is copied;
 * what it cannot set (booking questions, buffers, notice, reminders, the link's slug, availability beyond the owner's default
 * working hours) is listed by name so it is finished by hand, never left looking done.
 */
type Location = { kind?: string; location?: string; additional_info?: string; phone_number?: string };
type SourceType = {
  uri: string; name: string; duration: number; duration_options?: number[] | null; description_plain?: string | null; color?: string; locale?: string;
  locations?: Location[] | null; custom_questions?: { name: string; enabled?: boolean }[]; kind?: string; pooling_type?: string | null;
};
export type EventTypeCopy = {
  from: { id: string; name: string; duration: number };
  create: { owner: string; name: string; duration: number; description?: string; locations?: Location[]; color?: string; locale?: string; active: true };
  by_hand: string[];
};

export async function planEventTypeCopy(token: string, organization: string, a: { from: string; ownerEmail: string; name: string; duration?: number }): Promise<{ ok: true; plan: EventTypeCopy } | { ok: false; error: string }> {
  const m = await calendly<{ collection: { user: { uri: string; email: string } }[] }>(token, `/organization_memberships?organization=${encodeURIComponent(organization)}&email=${encodeURIComponent(a.ownerEmail)}`);
  const owner = m.collection?.[0]?.user; if (!owner) return { ok: false, error: `no member of the Calendly organization has ${a.ownerEmail}` };
  const { resource: s } = await calendly<{ resource: SourceType }>(token, `/event_types/${uuidOf(a.from)}`);
  if (s.pooling_type) return { ok: false, error: `"${s.name}" is a ${s.pooling_type} calendar: only a one-person calendar is copied` };
  const duration = a.duration ?? s.duration;
  if (!Number.isInteger(duration) || duration < 1 || duration > 720) return { ok: false, error: "duration: whole minutes, 1 to 720" };
  const locations = (s.locations ?? []).filter((l) => l.kind).map((l) => Object.fromEntries(Object.entries({ kind: l.kind, location: l.location, additional_info: l.additional_info, phone_number: l.phone_number }).filter(([, v]) => v != null && v !== ""))) as Location[];
  const questions = (s.custom_questions ?? []).filter((q) => q.enabled !== false).map((q) => q.name);
  return { ok: true, plan: {
    from: { id: uuidOf(s.uri), name: s.name, duration: s.duration },
    create: { owner: owner.uri, name: a.name, duration, ...(s.description_plain ? { description: s.description_plain } : {}), ...(locations.length ? { locations } : {}), ...(s.color ? { color: s.color } : {}), ...(s.locale ? { locale: s.locale } : {}), active: true },
    by_hand: [
      ...(questions.length ? [`booking questions, as on "${s.name}": ${questions.join("; ")}`] : []),
      "buffers before and after, minimum notice, daily limit",
      "reminders and follow-up emails or texts (Workflows)",
      "the link's slug (Calendly picks one from the name)",
      "availability: the new calendar uses the owner's default working hours",
    ],
  } };
}

export async function createEventType(token: string, plan: EventTypeCopy): Promise<{ id: string; scheduling_url: string | null }> {
  const { resource } = await calendlyPost<{ resource: { uri: string; scheduling_url?: string } }>(token, "/event_types", plan.create);
  return { id: uuidOf(resource.uri), scheduling_url: resource.scheduling_url ?? null };
}
