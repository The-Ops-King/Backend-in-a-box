import crypto from "node:crypto";
import type { Hub } from "./framework/hub";
import { type Verdict, verifyCalendly, verifyStandardWebhook, verifyTypeform } from "./framework/signatures";
import type { Provider } from "./framework/types";

/**
 * The inbound doors, one per vendor and connection: POST /in/whop/{connection}, /in/fathom/{connection},
 * /in/typeform/{connection}, /in/calendly/{connection} and the generic signed door /in/{connection}. (GHL's is
 * /in/ghl, one URL for the whole Marketplace app, signed with GHL's key.) Each:
 * 1. finds the connection (an unknown one is 404, and nothing is kept);
 * 2. verifies the vendor's signature over the raw body with that connection's secret (a bad one is 401, kept nowhere);
 * 3. keeps the delivery once in the inbox (the vendor's delivery id, else the body's hash: a retry is the same row);
 * 4. answers 200 at once, and queues the normalizer as a job. If the queue cannot be reached the delivery is still
 *    kept, and the worker's sweep reads it.
 */

export type DoorVendor = "whop" | "fathom" | "typeform" | "calendly" | "generic";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sha = (raw: string) => `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
const KEPT_HEADERS = /^(x-|webhook-|typeform-|calendly-|content-type$|user-agent$)/;

export async function door(hub: Hub, vendor: DoorVendor, connectionId: string, req: Request): Promise<Response> {
  const raw = await req.text();
  const conn = /^[0-9a-f-]{36}$/i.test(connectionId) ? await hub.state.connectionById(connectionId) : undefined;
  if (!conn || conn.provider !== (vendor as Provider)) return json({ error: "no such door" }, 404);
  const secret = conn.credentials.webhook_secret;
  if (!secret) return json({ error: "the connection has no signing secret" }, 503);
  const now = hub.now();
  const h = (k: string) => req.headers.get(k);
  const verdict: Verdict = vendor === "typeform" ? verifyTypeform(secret, h("typeform-signature"), raw)
    : vendor === "calendly" ? verifyCalendly(secret, h("calendly-webhook-signature"), raw, now)
      : verifyStandardWebhook(secret, { id: h("webhook-id"), timestamp: h("webhook-timestamp"), signature: h("webhook-signature") }, raw, now);
  if (!verdict.ok) return json({ error: "bad signature", why: verdict.why }, 401);
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return json({ error: "the body is not JSON" }, 400); }
  const own = vendor === "typeform" ? (typeof body.event_id === "string" ? body.event_id : undefined) : h("webhook-id") ?? undefined;
  const deliveryId = `${conn.id}:${own ?? sha(raw)}`;
  const eventType = typeof body.type === "string" ? body.type : typeof body.event === "string" ? body.event : typeof body.event_type === "string" ? body.event_type : null;
  const headers = Object.fromEntries([...req.headers.entries()].filter(([k]) => KEPT_HEADERS.test(k)));
  const r = await hub.state.recordDelivery({ source: vendor, deliveryId, eventType, locationId: null, connectionId: conn.id, offerId: conn.offerId, headers, body: raw, receivedAt: now });
  if (r.stored) await queue(hub, r.id);
  return json({ ok: true, duplicate: !r.stored });
}

/** Queues the normalizer for a kept delivery; a queue that cannot be reached loses nothing (the sweep reads it). */
export async function queue(hub: Hub, inboxId: number): Promise<void> {
  try { await hub.enqueue("connector_inbox", { id: inboxId }, { jobKey: `inbox:${inboxId}` }); }
  catch (e) { console.error(`inbox ${inboxId}: not queued (${(e as Error).message}); the sweep will read it`); }
}

/** Reads every delivery not yet read (the worker's sweep, at start and on a timer). */
export async function sweepInbox(hub: Hub, process: (id: number) => Promise<unknown>, limit = 200): Promise<number> {
  let n = 0;
  // the Slack app reads its own deliveries
  for (const source of ["ghl", "whop", "fathom", "typeform", "calendly", "generic"]) {
    for (const d of await hub.state.unprocessed(source, limit)) {
      try { await process(d.id); n++; } catch (e) { console.error(`inbox ${d.id}: ${(e as Error).message}`); }
    }
  }
  return n;
}
