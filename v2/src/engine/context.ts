import type { RenderEnv } from "@/workflow/filters";
import type { Context } from "@/workflow/template";
import type { Tx } from "./store";
import { contactZoneOf } from "./time";
import type { EventRow, OfferRow, RunRow } from "./types";

/**
 * What a step reads. The contact, appointment and deal are the facts about them folded in order, read fresh each time
 * a run looks (so a cancellation or a moved call is seen); the rest of the starting event's subjects (a payment, a
 * recording) are the snapshot it carried. Until the projections exist, "fresh" means the event log, merged.
 */

/** Context roots that are a subject with an id of its own, re-read from the facts. */
export const FOLDED = ["contact", "appointment", "deal"] as const;
/** Roots an event may carry as a snapshot only. */
export const SNAPSHOT = ["payment", "recording", "agreement", "person"] as const;

export type Subjects = { contactId: string | null; appointmentId: string | null; dealId: string | null };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The current state of each subject: every fact about it, oldest first, each one's snapshot of it merged over the last. */
export async function freshSubjects(tx: Tx, offerId: string, s: Subjects): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  const fold = async (root: (typeof FOLDED)[number], q: { contactId?: string; appointmentId?: string; dealId?: string }) => {
    const rows = await tx.events({ offerId, ...q });
    const merged: Record<string, unknown> = {};
    for (const e of rows) if (isObj(e.payload[root])) Object.assign(merged, e.payload[root]);
    out[root] = merged;
  };
  if (s.contactId) await fold("contact", { contactId: s.contactId });
  if (s.appointmentId) await fold("appointment", { appointmentId: s.appointmentId });
  if (s.dealId) await fold("deal", { dealId: s.dealId });
  if (s.contactId) out.contact = { id: s.contactId, ...out.contact };
  if (s.appointmentId) out.appointment = { id: s.appointmentId, ...out.appointment };
  if (s.dealId) out.deal = { id: s.dealId, ...out.deal };
  return out;
}

/** The snapshot roots an event carries, for a run it starts. */
export const snapshotOf = (payload: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(SNAPSHOT.filter((r) => isObj(payload[r])).map((r) => [r, payload[r]]));

/** The event as a step reads it: its payload, with its type and when it happened. */
export const eventView = (e: Pick<EventRow, "type" | "occurredAt" | "payload" | "source">): Record<string, unknown> =>
  ({ ...e.payload, type: e.type, occurred_at: e.occurredAt.toISOString(), source: e.source });

export type Built = { ctx: Context; env: RenderEnv };

/** Builds what a run's step reads, and the clock and zones it renders with. */
export function buildContext(x: {
  run: Pick<RunRow, "id" | "startedAt" | "context">; workflowKey: string; offer: OfferRow; settings: Record<string, unknown>;
  subjects: Record<string, Record<string, unknown>>; now: Date; secrets?: string[];
}): Built {
  const c = x.run.context;
  const ctx: Context = {
    ...c.subjects,
    ...x.subjects,
    event: c.event,
    vars: c.vars,
    ...(c.reply ? { reply: c.reply } : {}),
    setting: nestSettings(x.settings),
    offer: { id: x.offer.id, slug: x.offer.slug, name: x.offer.name, zone: x.offer.zone },
    run: { id: x.run.id, started_at: x.run.startedAt.toISOString(), workflow: x.workflowKey },
    // a secret is never rendered into a row: it stays a marker the dispatcher fills in at the moment of the call
    secret: Object.fromEntries((x.secrets ?? []).map((k) => [k, secretMarker(k)])),
  };
  const contactZone = contactZoneOf(ctx.contact, x.offer.zone);
  return { ctx, env: { now: x.now, offerZone: x.offer.zone, ...(contactZone !== x.offer.zone || (ctx.contact as { timezone?: string } | undefined)?.timezone ? { contactZone } : {}) } };
}

/**
 * Settings are stored by dotted key ("slack.channel.payments") and read in templates as a path
 * ({{setting.slack.channel.payments}}), so the context holds them nested by the dots.
 */
export function nestSettings(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(flat).sort()) {
    const parts = key.split(".");
    let at = out;
    for (const p of parts.slice(0, -1)) {
      if (typeof at[p] !== "object" || at[p] === null || Array.isArray(at[p])) at[p] = {};
      at = at[p] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1]!;
    if (!(typeof at[last] === "object" && at[last] !== null)) at[last] = flat[key];
  }
  return out;
}

/** A secret stands in a row as this marker (never its value); the dispatcher fills it in at the call. */
export const secretMarker = (key: string) => `⟦secret:${key}⟧`;
export const SECRET_MARKER = /⟦secret:([a-z0-9_.]+)⟧/g;
