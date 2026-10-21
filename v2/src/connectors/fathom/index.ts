import type { Hub } from "../framework/hub";
import { scheduleTranscript } from "../framework/transcripts";
import type { CanonicalFact, Connection, J, Normalized } from "../framework/types";
import { normEmail } from "@/engine/gate";
import { fathomMeetings } from "./client";

/**
 * Fathom, behind the recording port. Its webhook (Standard Webhooks, whsec_ secret returned once when made) delivers the
 * Meeting object (v1's fathom.ts): recording_id, title, url / share_url, recording and scheduled times,
 * calendar_invitees [{ name, email, is_external }], recorded_by, transcript [...] when asked for, default_summary.
 *
 * | Fathom delivery | Canonical fact |
 * | --- | --- |
 * | a meeting, one prospect matched | recording.received (with the booking it is, when the prospect has one within a day) |
 * | a meeting, no one prospect | recording.unlinked (the team links it) |
 *
 * The prospect is found by v1's first rung, one hit or nothing: an invitee email that is a known contact (the team's own
 * emails taken out). v1's later rungs (the meeting link, an invitee name, the closer's calendar) are not built here.
 * A meeting delivered without its transcript is looked for again 1, 3 and 10 minutes on. The words are never stored.
 */

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const when = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined);
const DAY_MS = 86_400_000;

export async function meetingFact(hub: Hub, conn: Connection, m: J, source: string): Promise<{ fact?: CanonicalFact; why?: string; hasTranscript: boolean; id?: string }> {
  const id = str(m.recording_id) ?? (m.recording_id !== undefined ? String(m.recording_id) : undefined) ?? str(m.id);
  if (!id) return { why: "no recording_id", hasTranscript: false };
  const started = when(m.recording_start_time) ?? when(m.scheduled_start_time) ?? when(m.created_at);
  if (!started) return { why: "no start time", hasTranscript: false, id };
  const ended = when(m.recording_end_time) ?? when(m.scheduled_end_time);
  const rb = (m.recorded_by ?? {}) as J;
  const staff = await hub.staffEmails(conn.offerId);
  const recorder = normEmail(str(rb.email));
  const invitees = (Array.isArray(m.calendar_invitees) ? (m.calendar_invitees as J[]) : []).map((i) => ({ name: str(i.name), email: normEmail(str(i.email)) || undefined, external: i.is_external }));
  const prospects = invitees.filter((i) => i.email && i.email !== recorder && !staff.has(i.email) && i.external !== false);
  const hits = new Map<string, string>();
  for (const p of prospects) { const h = await hub.matchContact(conn.offerId, { email: p.email! }); if (h) hits.set(h.id, p.email!); }
  const hasTranscript = Array.isArray(m.transcript) && m.transcript.length > 0;
  const recordingId = `fathom:${id}`;
  const recording = {
    id: recordingId, provider: "fathom", external_id: id, title: str(m.meeting_title) ?? str(m.title) ?? null, started_at: started.toISOString(), ...(ended ? { ended_at: ended.toISOString(), duration_min: Math.round((ended.getTime() - started.getTime()) / 60_000) } : {}),
    share_url: str(m.share_url) ?? str(m.url) ?? null, url: str(m.url) ?? null, kind: "meeting", recorded_by: { name: str(rb.name) ?? null, email: recorder || null }, has_transcript: hasTranscript,
  };
  if (hits.size !== 1) {
    return {
      hasTranscript, id,
      fact: {
        offerId: conn.offerId, type: "recording.unlinked", occurredAt: started, source, dedupeKey: `fathom:recording:${id}`, contactId: null,
        payload: { recording_id: recordingId, recording, title: recording.title, duration_min: (recording as J).duration_min ?? null, reason: hits.size ? "more than one invitee matched a contact" : "no invitee matched a contact", attendees: prospects.map((p) => p.email).join(", "), recorded_by: recorder || null, share_url: recording.share_url },
      },
    };
  }
  const contactId = [...hits.keys()][0]!;
  const appts = await hub.store.tx((tx) => tx.projFind("appointments", conn.offerId, { where: { contactId } }));
  const near = appts.filter((a) => a.startsAt && a.status !== "cancelled" && Math.abs(a.startsAt.getTime() - started.getTime()) <= DAY_MS)
    .sort((a, b) => Math.abs(a.startsAt!.getTime() - started.getTime()) - Math.abs(b.startsAt!.getTime() - started.getTime()))[0];
  return {
    hasTranscript, id,
    fact: { offerId: conn.offerId, type: "recording.received", occurredAt: started, source, dedupeKey: `fathom:recording:${id}`, contactId, appointmentId: near?.id ?? null, payload: { recording_id: recordingId, recording } },
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
