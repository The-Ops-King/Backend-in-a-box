import type { Hub } from "../framework/hub";
import { scheduleTranscript } from "../framework/transcripts";
import type { CanonicalFact, Connection, J, Normalized } from "../framework/types";
import { normEmail } from "@/engine/gate";
import { matchRecording } from "../framework/recordings";
import { fathomMeetings } from "./client";

/**
 * Fathom, behind the recording port. Its webhook (Standard Webhooks, whsec_ secret returned once when made) delivers the
 * Meeting object (v1's fathom.ts): recording_id, title, url / share_url, recording and scheduled times,
 * calendar_invitees [{ name, email, is_external }], recorded_by, transcript [...] when asked for, default_summary.
 *
 * | Fathom delivery | Canonical fact |
 * | --- | --- |
 * | a meeting, one prospect matched | recording.received (with the booking it is, within the offer's window; `matched_by` the rung) |
 * | a meeting, no one prospect | recording.unlinked (the team links it) |
 *
 * The prospect (and their booking) is found by v1's ladder (`framework/recordings.ts`): an invitee email that is a known
 * contact (the team's own emails taken out), the meeting link, an invitee's exact name, the closer's calendar; one hit
 * or nothing. Its time thresholds are the offer's settings; a rung whose setting is unset is not tried.
 * A meeting delivered without its transcript is looked for again 1, 3 and 10 minutes on. The words are never stored.
 */

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const when = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined);

export async function meetingFact(hub: Hub, conn: Connection, m: J, source: string): Promise<{ fact?: CanonicalFact; why?: string; hasTranscript: boolean; id?: string }> {
  const id = str(m.recording_id) ?? (m.recording_id !== undefined ? String(m.recording_id) : undefined) ?? str(m.id);
  if (!id) return { why: "no recording_id", hasTranscript: false };
  const started = when(m.recording_start_time) ?? when(m.scheduled_start_time) ?? when(m.created_at);
  if (!started) return { why: "no start time", hasTranscript: false, id };
  const ended = when(m.recording_end_time) ?? when(m.scheduled_end_time);
  const rb = (m.recorded_by ?? {}) as J;
  const recorder = normEmail(str(rb.email));
  const invitees = (Array.isArray(m.calendar_invitees) ? (m.calendar_invitees as J[]) : []).map((i) => ({ name: str(i.name), email: normEmail(str(i.email)) || undefined, external: typeof i.is_external === "boolean" ? i.is_external : undefined }));
  const seen = await matchRecording(hub, conn.offerId, { startedAt: started, meetingUrl: str(m.meeting_url), recorder: { email: recorder || undefined, name: str(rb.name) }, invitees });
  const hasTranscript = Array.isArray(m.transcript) && m.transcript.length > 0;
  const recordingId = `fathom:${id}`;
  const recording = {
    id: recordingId, provider: "fathom", external_id: id, title: str(m.meeting_title) ?? str(m.title) ?? null, started_at: started.toISOString(), ...(ended ? { ended_at: ended.toISOString(), duration_min: Math.round((ended.getTime() - started.getTime()) / 60_000) } : {}),
    share_url: str(m.share_url) ?? str(m.url) ?? null, url: str(m.url) ?? null, kind: "meeting", recorded_by: { name: str(rb.name) ?? null, email: recorder || null }, has_transcript: hasTranscript,
  };
  const off = seen.rungsOff.length ? { rungs_off: seen.rungsOff } : {};
  if (!seen.match) {
    return {
      hasTranscript, id,
      fact: {
        offerId: conn.offerId, type: "recording.unlinked", occurredAt: started, source, dedupeKey: `fathom:recording:${id}`, contactId: null,
        payload: { recording_id: recordingId, recording, title: recording.title, duration_min: (recording as J).duration_min ?? null, reason: seen.reason ?? "no one matched", attendees: seen.attendees, recorded_by: recorder || null, share_url: recording.share_url, ...off },
      },
    };
  }
  const { contactId, appointmentId, by } = seen.match;
  return {
    hasTranscript, id,
    fact: { offerId: conn.offerId, type: "recording.received", occurredAt: started, source, dedupeKey: `fathom:recording:${id}`, contactId, appointmentId, payload: { recording_id: recordingId, recording, matched_by: by, appointment_matched: !!appointmentId, ...off } },
  };
}

export async function normalizeFathom(hub: Hub, conn: Connection, body: J): Promise<Normalized> {
  const r = await meetingFact(hub, conn, body, "fathom");
  if (!r.fact) return { facts: [], outcome: r.why ?? "nothing" };
  const fact = r.fact;
  return {
    facts: [fact], outcome: "facts",
    commit: async () => { if (!r.hasTranscript) await scheduleTranscript(hub, { offerId: conn.offerId, connectionId: conn.id, provider: "fathom", recordingId: r.id!, fact: { contactId: fact.contactId ?? null, appointmentId: fact.appointmentId ?? null, recording_id: `fathom:${r.id}` } }); },
  };
}

export async function reconcileFathom(hub: Hub, conn: Connection, from: Date, to: Date): Promise<{ facts: CanonicalFact[] }> {
  const facts: CanonicalFact[] = [];
  for (const m of await fathomMeetings(hub, conn, from, to)) { const r = await meetingFact(hub, conn, m, "reconcile"); if (r.fact) facts.push(r.fact); }
  return { facts };
}
