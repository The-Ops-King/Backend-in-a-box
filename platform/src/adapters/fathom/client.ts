import { VendorError } from "@/engine/failures";
/**
 * Fathom external API (fathom/01-api-facts.md): base https://api.fathom.ai/external/v1, header X-Api-Key.
 * Webhooks are created per API key and deliver the Meeting object (Standard Webhooks, whsec_ secret returned once).
 */
const BASE = "https://api.fathom.ai/external/v1";
const headers = (apiKey: string) => ({ "X-Api-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" });

export type FathomWebhook = { id: string; url: string; secret: string; created_at: string; triggered_for: string[] };

/** Every recording the key can see (own, shared with the team, shared externally), with transcript + summary. */
export async function fathomCreateWebhook(apiKey: string, destinationUrl: string): Promise<FathomWebhook> {
  const res = await fetch(`${BASE}/webhooks`, { method: "POST", headers: headers(apiKey), body: JSON.stringify({
    destination_url: destinationUrl, include_transcript: true, include_summary: true, include_action_items: true, include_crm_matches: false,
    triggered_for: ["my_recordings", "my_shared_with_team_recordings", "shared_team_recordings", "shared_external_recordings"] }) });
  if (!res.ok) throw new Error(`fathom: create webhook ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as FathomWebhook;
}
export async function fathomDeleteWebhook(apiKey: string, id: string): Promise<void> {
  const res = await fetch(`${BASE}/webhooks/${encodeURIComponent(id)}`, { method: "DELETE", headers: headers(apiKey) });
  if (!res.ok && res.status !== 404) throw new Error(`fathom: delete webhook ${res.status}`);
}
/** The webhooks registered on this key (D33 sweep). `null` when the API has no listing (then the sweep falls back to delivery age). */
export async function fathomListWebhooks(apiKey: string): Promise<{ id: string; url?: string; destination_url?: string }[] | null> {
  const res = await fetch(`${BASE}/webhooks`, { headers: headers(apiKey) });
  if (res.status === 404 || res.status === 405) return null;
  if (!res.ok) throw new Error(`fathom: list webhooks ${res.status} ${(await res.text()).slice(0, 160)}`);
  const data = (await res.json()) as { items?: unknown[]; webhooks?: unknown[] } | unknown[];
  const list = Array.isArray(data) ? data : data.items ?? data.webhooks ?? [];
  return list as { id: string; url?: string; destination_url?: string }[];
}
/** Cheap key check: one page of meetings. */
/** true when the key lists meetings; otherwise the status and Fathom's own words, so a rejected key is told apart from Fathom being slow or down. */
export async function fathomPing(apiKey: string): Promise<boolean | { ok: false; status: number | null; detail: string }> {
  let res: Response;
  try { res = await fetch(`${BASE}/meetings?include_transcript=false`, { headers: headers(apiKey) }); }
  catch (e) { return { ok: false, status: null, detail: String((e as Error).message).slice(0, 160) }; }
  if (res.ok) return true;
  return { ok: false, status: res.status, detail: (await res.text().catch(() => "")).slice(0, 160) };
}

/**
 * D87: one recording's transcript, read again from Fathom when a step needs it (the engine never keeps it). `GET
 * /recordings/{recording_id}/transcript` answers `{ transcript: [{ speaker { display_name, matched_calendar_invitee_email }, text,
 * timestamp }] }` (fathom/01-api-facts.md, to verify live). Null when Fathom has none for it; a refusal or an outage throws with the
 * status, so the step's retry policy takes it.
 */
export async function fathomTranscript(apiKey: string, recordingId: string): Promise<{ speaker: string; email?: string; text: string; timestamp?: string }[] | null> {
  const res = await fetch(`${BASE}/recordings/${encodeURIComponent(recordingId)}/transcript`, { headers: headers(apiKey) });
  if (res.status === 404) return null;
  if (!res.ok) throw new VendorError("fathom", res.status, `/recordings/${recordingId}/transcript`, (await res.text().catch(() => "")).slice(0, 300));
  const body = (await res.json()) as { transcript?: unknown } | unknown[];
  const lines = Array.isArray(body) ? body : Array.isArray((body as { transcript?: unknown }).transcript) ? ((body as { transcript: unknown[] }).transcript) : [];
  const out = lines.map((l) => { const r = (l ?? {}) as Record<string, unknown>; const sp = (r.speaker ?? {}) as Record<string, unknown>;
    return { speaker: typeof sp === "string" ? sp : String(sp.display_name ?? "Speaker"), email: typeof sp.matched_calendar_invitee_email === "string" ? sp.matched_calendar_invitee_email.toLowerCase() : undefined, text: String(r.text ?? ""), timestamp: typeof r.timestamp === "string" ? r.timestamp : undefined }; })
    .filter((l) => l.text.trim());
  return out.length ? out : null;
}
export const fathomRecorder = { transcript: fathomTranscript };
