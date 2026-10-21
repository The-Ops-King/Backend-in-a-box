import crypto from "node:crypto";
import { db } from "@/db/client";
import { inbox } from "@/db/schema";

export type Recorded = { stored: boolean; deliveryId: string };

/**
 * Keeps one GHL delivery as it arrived. GHL retries a delivery up to 12 times; the same delivery (its webhookId, else the body's
 * hash) is stored once and every repeat answers the same.
 */
export async function recordGhlDelivery(rawBody: string, headers: Record<string, string>): Promise<Recorded> {
  let parsed: { webhookId?: unknown; type?: unknown; locationId?: unknown } = {};
  try { parsed = JSON.parse(rawBody); } catch { /* kept raw all the same */ }
  const deliveryId = typeof parsed.webhookId === "string" && parsed.webhookId ? parsed.webhookId : `sha256:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;
  const rows = await db().insert(inbox).values({
    source: "ghl", deliveryId, headers, body: rawBody,
    eventType: typeof parsed.type === "string" ? parsed.type : null,
    locationId: typeof parsed.locationId === "string" ? parsed.locationId : null,
  }).onConflictDoNothing().returning({ id: inbox.id });
  return { stored: rows.length > 0, deliveryId };
}
