import { createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { one } from "@/db/client";
import type { CompanyRow } from "./context";
import { dispatchEvent } from "./dispatch";
import { recordRecording, type RecordingInput } from "./recordings";

/**
 * D22: every inbound fact has more than one door (the provider's own webhook, a Zap forwarding it) and every door lands
 * here. What happens after the door is identical: ledger row, match ladder, workflows on a hit and on a miss (`recording.unlinked`, D88).
 */
export async function ingestRecording(c: PoolClient, company: CompanyRow, bindings: Record<string, string>, input: RecordingInput): Promise<Record<string, unknown>> {
  const r = await recordRecording(c, company.id, input);
  if (r.outcome === "duplicate") return { ok: true, duplicate: true, recording: r.recording.id };
  if (r.outcome === "unlinked") {
    await dispatchEvent(c, r.event, {});   // D88: the Unmatched recording workflow tells the team
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
  return !!secret && !!given && same(given, secret);
};
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * D202: the key in a GHL workflow's Webhook URL (`?key=`; GHL's action cannot set a header). It can only make the engine read the
 * offer's documents from GHL again, so it is shown whole on the Setup page, unlike the inbound secret. Derived, not stored.
 */
export const nudgeKey = (companyId: string, serverKey = process.env.BINDINGS_KEY ?? "") => serverKey ? createHmac("sha256", serverKey).update(`ghl-nudge:${companyId}`).digest("base64url").slice(0, 32) : "";
export const nudgeAuthorized = (req: Request, companyId: string) => { const k = nudgeKey(companyId), given = new URL(req.url).searchParams.get("key") ?? ""; return !!k && !!given && same(given, k); };
