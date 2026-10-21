import type { RenderEnv } from "@/workflow/filters";
import type { Context } from "@/workflow/template";
import type { Tx } from "./store";
import { contactZoneOf } from "./time";
import type { EventRow, OfferRow, RunRow } from "./types";
import { eventRefs, readSubjects } from "@/projections/derived";
import { DERIVED_KEYS } from "@/projections/projector";

/**
 * What a step reads. The contact, appointment, deal, payment, recording and agreement come from the projections, read
 * fresh each time a run looks (so a cancellation, a moved call or a payment is seen), with the facts the platform works
 * out from them (src/projections/derived.ts). The starting event's own snapshot of a root is kept only where no
 * projection has it (a person on a schedule run, a recording nobody could be matched to).
 */

/** Roots an event may carry as a snapshot; the projections' copy, when there is one, is what a step reads. */
export const SNAPSHOT = ["payment", "recording", "agreement", "person"] as const;

export type Subjects = { contactId: string | null; appointmentId: string | null; dealId: string | null };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The current state of each subject, from the projections. `event` is the run's starting event (it names a payment or a recording). */
export async function freshSubjects(tx: Tx, x: { offer: OfferRow; settings: Record<string, unknown>; subjects: Subjects; now: Date; event?: Record<string, unknown> }): Promise<Record<string, Record<string, unknown>>> {
  const refs = { ...x.subjects, ...eventRefs(x.event) };
  const read = await readSubjects(tx, { offer: x.offer, settings: x.settings, now: x.now, refs });
  return Object.fromEntries(Object.entries(read).filter(([, v]) => v !== undefined)) as Record<string, Record<string, unknown>>;
}

/**
 * A snapshot root the starting event carried, kept under the projection's copy of it (what the projection has wins), its
 * worked-out facts taken out: those are the projection's to say, or not there.
 */
export function mergeSubjects(snapshot: Record<string, unknown>, projected: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...snapshot };
  for (const [root, v] of Object.entries(projected)) out[root] = isObj(out[root]) && (SNAPSHOT as readonly string[]).includes(root) ? { ...stripDerived(out[root] as Record<string, unknown>, derivedOf(root)), ...v } : v;
  return out;
}

/** The snapshot roots an event carries, for a run it starts. */
export const snapshotOf = (payload: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(SNAPSHOT.filter((r) => isObj(payload[r])).map((r) => [r, stripDerived(payload[r] as Record<string, unknown>, derivedOf(r))]));
const stripDerived = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const derivedOf = (root: string): readonly string[] => (DERIVED_KEYS as Record<string, readonly string[]>)[root] ?? [];

/** The event as a step reads it: its payload, with its type and when it happened. */
/** The event as a step reads it: its payload, with its type, when it happened, and the fact's own id in the log (`fact_id`). */
export const eventView = (e: Pick<EventRow, "type" | "occurredAt" | "payload" | "source"> & { id?: number }): Record<string, unknown> =>
  ({ ...e.payload, type: e.type, occurred_at: e.occurredAt.toISOString(), source: e.source, ...(e.id !== undefined ? { fact_id: e.id } : {}) });

export type Built = { ctx: Context; env: RenderEnv };

/** Builds what a run's step reads, and the clock and zones it renders with. */
export function buildContext(x: {
  run: Pick<RunRow, "id" | "startedAt" | "context">; workflowKey: string; offer: OfferRow; settings: Record<string, unknown>;
  subjects: Record<string, Record<string, unknown>>; now: Date; secrets?: string[];
}): Built {
  const c = x.run.context;
  const ctx: Context = {
    ...mergeSubjects(c.subjects, x.subjects),
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
