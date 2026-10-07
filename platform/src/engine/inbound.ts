import type { PoolClient } from "pg";
import { one } from "@/db/client";
import type { CompanyRow } from "./context";
import { dispatchEvent } from "./dispatch";
import { notifyTeam } from "./notify";
import { recordRecording, type RecordingInput } from "./recordings";

/**
 * D22: every inbound fact has more than one door (the provider's own webhook, a Zap forwarding it) and every door lands
 * here. What happens after the door is identical: ledger row, match ladder, team alert on a miss, workflows on a hit.
 */
export async function ingestRecording(c: PoolClient, company: CompanyRow, bindings: Record<string, string>, input: RecordingInput): Promise<Record<string, unknown>> {
  const r = await recordRecording(c, company.id, input);
  if (r.outcome === "duplicate") return { ok: true, duplicate: true, recording: r.recording.id };
  if (r.outcome === "unlinked") {
    const who = input.invitees.map((i) => i.email ?? i.name).filter(Boolean).join(", ") || "nobody listed";
    await notifyTeam(c, company, bindings, "alerts", `*Unmatched recording* · ${input.title ?? "untitled"} · ${input.durationMin ?? "?"} min\n${r.reason}\n*Attendees:* ${who} · *Recorded by:* ${input.recordedBy?.email ?? "—"}\n${input.shareUrl ?? ""}\nLink it: ${(process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "")}/c/${company.slug}/recordings`);
    return { ok: true, unlinked: true, recording: r.recording.id, reason: r.reason };
  }
  const appt = r.appointmentId ? await one<Record<string, unknown>>(c, "select a.id, a.starts_at, a.status, json_build_object('category', t.category) as term from appointments a join company_terms t on t.id=a.appointment_term where a.id=$1", [r.appointmentId]) : null;
  const started = await dispatchEvent(c, r.event, { contact: { id: r.contactId }, appointment: appt ?? undefined, recording: { id: r.recording.id, title: input.title, duration_min: input.durationMin } });
  return { ok: true, event: r.event.id, recording: r.recording.id, matched_by: r.recording.linked_by, appointment: r.appointmentId, runs_started: started.length };
}

/** `x-engine-secret` or `Authorization: Bearer` must equal the company's inbound secret (install returns it). */
export const zapierAuthorized = (req: Request, bindings: Record<string, string>) => {
  const secret = bindings["secret.zapier_inbound"];
  const given = req.headers.get("x-engine-secret") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return !!secret && !!given && given === secret;
};
