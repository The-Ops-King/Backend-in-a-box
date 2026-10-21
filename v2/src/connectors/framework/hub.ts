import type { Store } from "@/engine/store";
import { normEmail, normPhone } from "@/engine/gate";
import type { ContactRow, PaymentRow } from "@/projections/tables";
import type { HttpDeps } from "./http";
import type { ConnectorState } from "./state";
import { FieldMap } from "./field-map";
import type { CanonicalFact, Connection, Enqueue, J, Provider } from "./types";
import { RateLimiter } from "./rate-limit";

/**
 * What every connector works with, given, never global: its own state, the engine's store (the projections to match a
 * person by, alerts), the HTTP layer, the job queue, the platform's app credentials (GHL's client id and secret), and
 * the engine's front door for facts. Built once per process; tests build one on fakes.
 */
export type HubEnv = { ghlClientId?: string; ghlClientSecret?: string; ghlWebhookPublicKey?: string };

export type HubDeps = {
  state: ConnectorState;
  store: Store;
  http: HttpDeps;
  enqueue: Enqueue;
  env?: HubEnv;
  /** The engine's ingest. Set once the engine exists (the engine's ports come from this hub). */
  ingest?: (f: CanonicalFact) => Promise<{ duplicate: boolean }>;
};

/** How many facts the nightly reconcile may find missed before it says webhooks are failing. */
export const RECONCILE_ALERT_OVER = 5;

export class Hub {
  readonly state: ConnectorState;
  readonly store: Store;
  readonly http: HttpDeps;
  readonly enqueue: Enqueue;
  readonly env: HubEnv;
  /** GHL's budget, per location: 100 requests per 10 seconds. */
  readonly ghlLimiter: RateLimiter;
  /** Contacts and cards this process made in the last minutes, by what finds them: GHL's search lags its writes. */
  readonly recent = new Map<string, { id: string; at: number }>();
  private ingestFn?: HubDeps["ingest"];

  constructor(d: HubDeps) {
    this.state = d.state; this.store = d.store; this.http = d.http; this.enqueue = d.enqueue; this.env = d.env ?? {}; this.ingestFn = d.ingest;
    this.ghlLimiter = new RateLimiter({ max: 100, windowMs: 10_000, now: d.http.now, sleep: d.http.sleep });
  }

  now(): Date { return this.http.now(); }
  setIngest(fn: NonNullable<HubDeps["ingest"]>) { this.ingestFn = fn; }

  async ingest(f: CanonicalFact): Promise<{ duplicate: boolean }> {
    if (!this.ingestFn) throw new Error("the connectors have no engine to give facts to");
    return this.ingestFn(f);
  }

  async fieldMap(offerId: string, provider: Provider): Promise<FieldMap> { return new FieldMap(await this.state.fieldMap(offerId, provider)); }

  /** An alert on an offer (or the operator's, with no offer), once per key while open. */
  async alert(a: { offerId: string | null; key: string; kind: string; message: string; detail?: J }): Promise<void> {
    const key = a.offerId ? `${a.offerId}:${a.key}` : `platform:${a.key}`;
    await this.store.tx((tx) => tx.raiseAlert({ offerId: a.offerId, key, kind: a.kind, message: a.message, detail: (a.detail ?? {}) as never, runId: null, outboxId: null, openedAt: this.now() }));
  }
  async resolve(offerId: string | null, key: string): Promise<void> {
    await this.store.tx((tx) => tx.resolveAlert(offerId ? `${offerId}:${key}` : `platform:${key}`, this.now()));
  }

  /** Pauses a provider's connections (one offer's, or everyone's on that vendor account) and says so on each offer. */
  async pause(q: { provider: Provider; offerId?: string; externalId?: string }, status: "paused" | "needs_reinstall" | "uninstalled", reason: string): Promise<string[]> {
    const offers = await this.state.setStatus(q, status, reason, this.now());
    for (const o of offers) {
      await this.alert({ offerId: o, key: `connection:${q.provider}`, kind: "connection_auth", message: `The ${q.provider} connection is ${status.replace("_", " ")}: ${reason}. Everything through it waits until it is fixed.`, detail: { provider: q.provider, status } });
    }
    return offers;
  }

  // ---- matching a person ------------------------------------------------------------------------------------------

  /**
   * The one contact a vendor's person is, from the projections: by email, then phone (last ten digits), one hit or
   * nothing. Guessing would put a payment or a recording on the wrong person; a miss is linked by a person.
   */
  async matchContact(offerId: string, who: { email?: string | null; phone?: string | null; crmId?: string | null }): Promise<{ id: string; by: string } | undefined> {
    return this.store.tx(async (tx) => {
      if (who.crmId) {
        const byId = await tx.projGet("contacts_index", offerId, who.crmId);
        if (byId) return { id: byId.id, by: "crm_id" };
        const rows = await tx.projFind("contacts_index", offerId, { where: { crmId: who.crmId } });
        if (rows.length === 1) return { id: rows[0]!.id, by: "crm_id" };
      }
      const one = (rows: ContactRow[]) => { const live = rows.filter((r) => !r.mergedInto); return live.length === 1 ? live[0]! : undefined; };
      const email = normEmail(who.email);
      if (email) { const hit = one(await tx.projFind("contacts_index", offerId, { has: { emails: email } })); if (hit) return { id: hit.id, by: "email" }; }
      const phone = normPhone(who.phone);
      if (phone) { const hit = one(await tx.projFind("contacts_index", offerId, { has: { phones: phone } })); if (hit) return { id: hit.id, by: "phone" }; }
      return undefined;
    });
  }

  /** The contact a provider's customer id was linked to before (a Whop member on an earlier linked payment): one, or none. */
  async contactOfCustomer(offerId: string, memberId: string): Promise<string | undefined> {
    const rows = await this.store.tx((tx) => tx.projFind("payments", offerId));
    const ids = new Set(rows.filter((p: PaymentRow) => p.contactId && (p.customer as J).member_id === memberId).map((p) => p.contactId!));
    return ids.size === 1 ? [...ids][0] : undefined;
  }

  /** The team's own emails, so a call's prospects are the people on it who are not staff. */
  async staffEmails(offerId: string): Promise<Set<string>> {
    const people = await this.store.tx((tx) => tx.projFind("people", offerId));
    return new Set(people.map((p) => normEmail(p.email)).filter(Boolean));
  }

  /** The connection an offer uses for a port (or one verb of it). */
  async connectionFor(offerId: string, port: string): Promise<Connection | undefined> {
    const verb = await this.state.connection(offerId, port);
    if (verb) return verb;
    const dot = port.indexOf(".");
    return dot > 0 ? this.state.connection(offerId, port.slice(0, dot)) : undefined;
  }
}
