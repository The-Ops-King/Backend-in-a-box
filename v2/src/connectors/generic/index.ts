import type { Hub } from "../framework/hub";
import type { Connection, J, Normalized } from "../framework/types";

/**
 * The generic signed door, POST /in/{connection_id}: for Zapier, Make and any tool with no connector of its own. It
 * replaces v1's shared-secret Zapier doors and their alias guessing: each connection has its own secret (Standard
 * Webhooks: webhook-id, webhook-timestamp, webhook-signature over "{id}.{timestamp}.{body}") and its own field map,
 * as config:
 *
 *   { emits: "payment" | "recording" | "form" | "fact", type?: "<canonical type, for fact>",
 *     map: { <canonical key>: "<dot.path in the body>" }, dedupe?: "<dot.path>" }
 *
 * Nothing is guessed: a key the map does not name is not read. The fact's dedupe key is the body's own id at `dedupe`
 * (a transaction id makes a replayed Zap harmless), else the delivery's webhook-id.
 *
 * | emits | Canonical fact |
 * | --- | --- |
 * | payment | payment.received / payment.failed / payment.refunded by `status`, or payment.unlinked |
 * | recording | recording.received, or recording.unlinked |
 * | form | form.submitted |
 * | fact | the configured type, its payload as mapped |
 */

const at = (body: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as J)[k] : undefined), body);
const str = (v: unknown) => (v === undefined || v === null || String(v).trim() === "" ? undefined : String(v).trim());

export type GenericConfig = { emits?: "payment" | "recording" | "form" | "fact"; type?: string; map?: Record<string, string>; dedupe?: string };

export async function normalizeGeneric(hub: Hub, conn: Connection, body: J, deliveryId: string): Promise<Normalized> {
  const cfg = conn.config as GenericConfig;
  if (!cfg.emits || !cfg.map) return { facts: [], outcome: "the door has no field map" };
  const v: J = {};
  for (const [k, path] of Object.entries(cfg.map)) { const x = at(body, path); if (x !== undefined && x !== null && x !== "") v[k] = x; }
  const id = (cfg.dedupe ? str(at(body, cfg.dedupe)) : undefined) ?? deliveryId;
  const key = `generic:${conn.id}:${id}`;
  const whenOf = (x: unknown) => { const s = str(x); if (!s) return hub.now(); if (/^\d{10,13}$/.test(s)) return new Date(Number(s) * (s.length === 10 ? 1000 : 1)); const t = Date.parse(s); return Number.isNaN(t) ? hub.now() : new Date(t); };
  const hit = await hub.matchContact(conn.offerId, { email: str(v.email) ?? str(v.customer_email) ?? null, phone: str(v.phone) ?? str(v.customer_phone) ?? null, crmId: str(v.crm_id) ?? null });
  const base = { offerId: conn.offerId, source: "generic", dedupeKey: key, contactId: hit?.id ?? null };
  switch (cfg.emits) {
    case "payment": {
      const raw = str(v.amount)?.replace(/[^0-9.-]/g, "");
      const amount = raw ? Number(raw) : NaN;
      if (!Number.isFinite(amount)) return { facts: [], outcome: `amount is not a number: ${String(v.amount ?? "(missing)")}` };
      const s = (str(v.status) ?? "succeeded").toLowerCase();
      const status = /fail|declin/.test(s) ? "failed" : /refund|charge ?back|dispute/.test(s) ? "refunded" : "succeeded";
      const type = !hit ? "payment.unlinked" : status === "succeeded" ? "payment.received" : status === "failed" ? "payment.failed" : "payment.refunded";
      const paid = whenOf(v.paid_at);
      return { outcome: "facts", facts: [{ ...base, type, occurredAt: paid, payload: { ...v, payment_id: `generic:${conn.id}:${id}`, provider_payment_id: id, status, amount: status === "refunded" ? -Math.abs(amount) : amount, paid_at: paid.toISOString(), customer_email: str(v.email) ?? str(v.customer_email) ?? null, customer_phone: str(v.phone) ?? str(v.customer_phone) ?? null } }] };
    }
    case "recording": {
      const started = whenOf(v.started_at);
      const recording = { ...v, id: `generic:${conn.id}:${id}`, external_id: id, started_at: started.toISOString(), kind: str(v.kind) ?? "meeting" };
      return { outcome: "facts", facts: [{ ...base, type: hit ? "recording.received" : "recording.unlinked", occurredAt: started, payload: { recording_id: recording.id, recording, ...(hit ? {} : { reason: "no attendee matched a contact" }) } }] };
    }
    case "form":
      return { outcome: "facts", facts: [{ ...base, type: "form.submitted", occurredAt: whenOf(v.submitted_at), payload: { form_id: str(v.form_id) ?? conn.id, response_id: id, contact: Object.fromEntries(["first_name", "last_name", "name", "email", "phone"].filter((k) => v[k] !== undefined).map((k) => [k, v[k]])), fields: v } }] };
    case "fact":
      if (!cfg.type || !/^[a-z_]+\.[a-z_.]+$/.test(cfg.type)) return { facts: [], outcome: "the door's fact type is not set" };
      return { outcome: "facts", facts: [{ ...base, type: cfg.type, occurredAt: whenOf(v.occurred_at), payload: v }] };
  }
}
