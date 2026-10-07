import type { RecordingInput } from "../recordings";

/**
 * Fathom's webhook body is the Meeting object (fathom/01-api-facts.md): recording_id, title/meeting_title, url/share_url,
 * scheduled/recording start and end, calendar_invitees[{name,email,is_external}], recorded_by{name,email},
 * transcript[{speaker{display_name, matched_calendar_invitee_email}, text, timestamp}], default_summary{markdown_formatted}.
 */
export type FathomMeeting = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const when = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined);

export function parseFathomMeeting(m: FathomMeeting): { ok: true; input: RecordingInput } | { ok: false; why: string } {
  const id = m.recording_id ?? m.id;
  if (id === undefined || id === null || String(id).trim() === "") return { ok: false, why: "recording_id missing" };
  const startedAt = when(m.recording_start_time) ?? when(m.scheduled_start_time) ?? when(m.created_at);
  if (!startedAt) return { ok: false, why: "no start time on the meeting" };
  const endedAt = when(m.recording_end_time) ?? when(m.scheduled_end_time);
  const rb = (m.recorded_by ?? {}) as Record<string, unknown>;
  const invitees = (Array.isArray(m.calendar_invitees) ? m.calendar_invitees : []).map((i) => { const r = i as Record<string, unknown>; return { name: str(r.name), email: str(r.email)?.toLowerCase(), isExternal: typeof r.is_external === "boolean" ? r.is_external : undefined }; }).filter((i) => i.name || i.email);
  const transcript = Array.isArray(m.transcript) ? m.transcript.map((t) => { const r = t as Record<string, unknown>; const sp = (r.speaker ?? {}) as Record<string, unknown>; return { speaker: str(sp.display_name) ?? "Speaker", email: str(sp.matched_calendar_invitee_email)?.toLowerCase(), text: String(r.text ?? ""), timestamp: str(r.timestamp) }; }) : undefined;
  const summary = str(((m.default_summary ?? {}) as Record<string, unknown>).markdown_formatted);
  return { ok: true, input: {
    provider: "fathom", externalId: String(id), title: str(m.meeting_title) ?? str(m.title), startedAt, endedAt,
    durationMin: endedAt ? Math.round((endedAt.getTime() - startedAt.getTime()) / 60000) : undefined,
    url: str(m.url), shareUrl: str(m.share_url) ?? str(m.url),
    recordedBy: { name: str(rb.name), email: str(rb.email)?.toLowerCase() }, invitees, transcript, summary,
    raw: { meeting_type: m.meeting_type, calendar_invitees_domains_type: m.calendar_invitees_domains_type, action_items: Array.isArray(m.action_items) ? m.action_items.length : undefined, transcript_language: m.transcript_language },
  } };
}
