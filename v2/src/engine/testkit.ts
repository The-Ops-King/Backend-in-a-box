import { toMs } from "@/workflow/duration";
import { enableWorkflow, saveVersion, setCrmWrites, setDelivery } from "./config";
import type { Store } from "./store";
import type { CrmWrites, Delivery, WorkflowRow } from "./types";

/** Helpers to set up an offer and its workflows, for tests and the simulator. */

/** A clock that moves only when told. */
export class FakeClock {
  private t: number;
  constructor(start: Date | string) { this.t = new Date(start).getTime(); }
  now = (): Date => new Date(this.t);
  set(at: Date | string) { this.t = new Date(at).getTime(); }
  /** Moves on by a duration ("2h", "1d2h30m") or milliseconds. */
  advance(by: string | number) { this.t += typeof by === "number" ? by : spanMs(by); }
}

/** Milliseconds in a span written as one or more whole numbers with units: "90m", "1d2h30m". */
export function spanMs(span: string): number {
  const parts = [...span.matchAll(/(\d+)([wdhms])/g)];
  if (!parts.length || parts.map((m) => m[0]).join("") !== span) throw new Error(`not a span of time: ${span}`);
  return parts.reduce((ms, m) => ms + toMs(`${m[1]}${m[2]}`), 0);
}

export type ContentSeed = Record<string, { channel: "sms" | "email" | "slack" | "prompt" | "crm"; body: string; subject?: string; as?: string; icons?: string[]; labels?: Record<string, string> }>;

export async function setupOffer(store: Store, x: {
  slug: string; name?: string; zone: string; settings?: Record<string, unknown>; content?: ContentSeed; operator?: { emails?: string[]; phones?: string[] }; id?: string;
  /** Report definitions by key, and metric definitions under `metrics` (an offer's reports.json). */
  reports?: Record<string, unknown>;
}): Promise<string> {
  return store.tx(async (tx) => {
    const offer = await tx.insertOffer({ slug: x.slug, name: x.name ?? x.slug, zone: x.zone, ...(x.id ? { id: x.id } : {}) });
    for (const [k, v] of Object.entries(x.settings ?? {})) await tx.setSetting(offer.id, k, v, "setup");
    for (const [key, c] of Object.entries(x.content ?? {})) {
      await tx.setContent({ offerId: offer.id, key, channel: c.channel, body: c.body, subject: c.subject ?? null, extras: c.as || c.labels || c.icons?.length ? { ...(c.as ? { as: c.as } : {}), ...(c.icons?.length ? { icons: c.icons } : {}), ...(c.labels ? { labels: c.labels } : {}) } : null, approvedHash: null });
    }
    for (const e of x.operator?.emails ?? []) await tx.addOperatorAddress("email", e);
    for (const p of x.operator?.phones ?? []) await tx.addOperatorAddress("phone", p);
    for (const [key, def] of Object.entries(x.reports ?? {})) {
      if (key.startsWith("_")) continue;
      if (key === "metrics") for (const [name, m] of Object.entries(def as Record<string, unknown>)) { if (!name.startsWith("_")) await tx.setReportDefinition(offer.id, "metric", name, m, "setup"); }
      else await tx.setReportDefinition(offer.id, "report", key, def, "setup");
    }
    return offer.id;
  });
}

/** Saves a definition as a new version, enables it, and sets its delivery and CRM writes. Throws on a problem. */
export async function install(store: Store, offerId: string, definition: unknown, x: { now: Date; delivery?: Delivery; crmWrites?: CrmWrites; enable?: boolean; by?: string }): Promise<WorkflowRow> {
  return store.tx(async (tx) => {
    const saved = await saveVersion(tx, { offerId, definition, by: x.by ?? "test", why: "set up", now: x.now });
    if (!saved.ok) throw new Error(`the definition does not validate: ${saved.problems.map((p) => `${p.code} ${p.message}`).join("; ")}`);
    const offer = (await tx.offer(offerId))!;
    const confirm = `${offer.slug}/${saved.workflow.key}`;
    if (x.enable !== false) {
      const e = await enableWorkflow(tx, saved.workflow.id, x.now);
      if (!e.ok) throw new Error(`cannot enable ${saved.workflow.key}: ${JSON.stringify(e.missing)}`);
    }
    if (x.delivery) await setDelivery(tx, { workflowId: saved.workflow.id, delivery: x.delivery, by: "Tyler", confirm, now: x.now });
    if (x.crmWrites) await setCrmWrites(tx, { workflowId: saved.workflow.id, crmWrites: x.crmWrites, by: "Tyler", confirm, now: x.now });
    return (await tx.workflow(saved.workflow.id))!;
  });
}
