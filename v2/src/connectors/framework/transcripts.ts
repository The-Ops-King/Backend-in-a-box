import type { VendorReads } from "@/engine/reads";
import { fathomTranscript } from "../fathom/client";
import { ghlTranscript } from "../ghl";
import type { Hub } from "./hub";
import type { Connection, J, Provider } from "./types";

/**
 * A call's transcript arrives after the call. The recorder is asked again 1, 3 and 10 minutes after the recording came
 * in; found, `recording.transcript_ready` is recorded; still missing after the third look, it is given up on,
 * `recording.transcript_missing` is recorded and the offer is alerted. A transcript's words are never stored: a step
 * that needs them reads them from the recorder (`connectorReads`).
 */
export const TRANSCRIPT_DELAYS_MS = [60_000, 180_000, 600_000];

/** The recorder's words for one recording, by provider. */
export async function transcriptOf(hub: Hub, conn: Connection, provider: Provider, externalId: string): Promise<string | null> {
  if (provider === "ghl") return ghlTranscript(hub, conn, externalId);
  if (provider === "fathom") return fathomTranscript(hub, conn, externalId);
  return null;
}

export async function scheduleTranscript(hub: Hub, w: { offerId: string; connectionId: string; provider: Provider; recordingId: string; fact: J }): Promise<void> {
  const now = hub.now();
  const at = new Date(now.getTime() + TRANSCRIPT_DELAYS_MS[0]!);
  const row = await hub.state.addTranscriptWait({ ...w, tries: 0, nextAt: at, status: "waiting", updatedAt: now });
  if (row) await hub.enqueue("transcript_wait", { id: row.id }, { runAt: at, jobKey: `transcript:${row.id}` });
}

/** One look for a waiting transcript (the transcript_wait job). */
export async function lookForTranscript(hub: Hub, id: number): Promise<"ready" | "waiting" | "gave_up" | "nothing"> {
  const w = await hub.state.transcriptWait(id);
  if (!w || w.status !== "waiting") return "nothing";
  const now = hub.now();
  if (w.nextAt > now) return "waiting";
  const conn = await hub.state.connectionById(w.connectionId);
  const text = conn ? await transcriptOf(hub, conn, w.provider, w.recordingId) : null;
  const tries = w.tries + 1;
  const fact = w.fact as { contactId?: string | null; recording_id?: string; appointmentId?: string | null };
  const base = { offerId: w.offerId, occurredAt: now, source: w.provider, contactId: fact.contactId ?? null, appointmentId: fact.appointmentId ?? null };
  if (text) {
    await hub.ingest({ ...base, type: "recording.transcript_ready", dedupeKey: `${w.provider}:transcript:${w.recordingId}`, payload: { recording_id: fact.recording_id ?? w.recordingId, recording: { id: fact.recording_id ?? w.recordingId, has_transcript: true, transcript_status: "ready" } } });
    await hub.state.updateTranscriptWait(id, { status: "ready", tries, updatedAt: now });
    return "ready";
  }
  if (tries >= TRANSCRIPT_DELAYS_MS.length) {
    await hub.ingest({ ...base, type: "recording.transcript_missing", dedupeKey: `${w.provider}:transcript-missing:${w.recordingId}`, payload: { recording_id: fact.recording_id ?? w.recordingId, recording: { id: fact.recording_id ?? w.recordingId, has_transcript: false, transcript_status: "none" } } });
    await hub.state.updateTranscriptWait(id, { status: "gave_up", tries, updatedAt: now });
    await hub.alert({ offerId: w.offerId, key: `transcript:${w.provider}:${w.recordingId}`, kind: "transcript_missing", message: `No transcript came for the ${w.provider} recording ${w.recordingId} after ${tries} looks over ${Math.round(TRANSCRIPT_DELAYS_MS.reduce((a, b) => a + b, 0) / 60_000)} minutes; it was given up on.`, detail: { provider: w.provider, recording: w.recordingId } });
    return "gave_up";
  }
  const next = new Date(now.getTime() + TRANSCRIPT_DELAYS_MS[tries]!);
  await hub.state.updateTranscriptWait(id, { tries, nextAt: next, updatedAt: now });
  await hub.enqueue("transcript_wait", { id }, { runAt: next, jobKey: `transcript:${id}` });
  return "waiting";
}

/** What only a recorder can answer, from the offer's recording connections: the engine's VendorReads.transcripts. */
export function connectorReads(hub: Hub): VendorReads {
  return {
    transcripts: async (offerId, ids) => {
      const out: Record<string, string> = {};
      for (const id of ids) {
        const [provider, ...rest] = id.split(":");
        const external = rest.join(":");
        if (!external || (provider !== "ghl" && provider !== "fathom")) continue;
        const conn = provider === "ghl" ? await hub.connectionFor(offerId, "crm") : await hub.connectionFor(offerId, "recording");
        if (!conn || conn.provider !== provider) continue;
        const text = await transcriptOf(hub, conn, provider, external);
        if (text) out[id] = text;
      }
      return out;
    },
  };
}
