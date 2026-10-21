import type { ConnectionStatus } from "@/engine/types";
import type { Connection, Delivery, FieldMapRow, J, Provider } from "./types";

/**
 * What connectors keep, behind one interface with two stores: Postgres (pg-state.ts) and memory (mem-state.ts, for the
 * contract suites and the simulator). Connections and field maps are configuration; echoes, entity versions, agreement
 * checks and transcript waits are the connectors' own execution state; the inbox is every delivery as it arrived.
 */

export type GhlToken = {
  locationId: string; companyId: string | null; accessToken: string; refreshToken: string; expiresAt: Date; scopes: string;
  status: "connected" | "needs_reinstall" | "uninstalled";
};

export type Echo = { offerId: string; provider: Provider; entity: string; entityId: string; change: J; outboxKey: string | null; createdAt: Date; expiresAt: Date };
export type Version = { offerId: string; provider: Provider; kind: string; entityId: string; versionAt: Date | null; state: J; updatedAt: Date };

export type AgreementCheck = {
  id: number; offerId: string; connectionId: string; locationId: string; agreementId: string; contactId: string | null; name: string | null;
  sentAt: Date; nextCheckAt: Date; lastCheckedAt: Date | null; lastStatus: string | null; checks: number;
  status: "waiting" | "signed" | "voided" | "expired"; settledAt: Date | null;
};

export type TranscriptWait = {
  id: number; offerId: string; connectionId: string; provider: Provider; recordingId: string; tries: number; nextAt: Date;
  status: "waiting" | "ready" | "gave_up"; fact: J; updatedAt: Date;
};

export type NewConnection = { offerId: string; port: string; provider: Provider; mode?: string | null; externalId?: string | null; config?: J; credentials?: Record<string, string>; status?: ConnectionStatus };

export type NewDelivery = Omit<Delivery, "id" | "receivedAt"> & { receivedAt?: Date };

export interface ConnectorState {
  connection(offerId: string, port: string): Promise<Connection | undefined>;
  connectionById(id: string): Promise<Connection | undefined>;
  /** Every connection of a provider (to one vendor account, when given), across offers and ports. */
  connectionsOf(provider: Provider, externalId?: string): Promise<Connection[]>;
  upsertConnection(c: NewConnection): Promise<Connection>;
  /** Sets the status of the provider's connections (one offer's, or every offer's on that vendor account). Gives back the offers changed. */
  setStatus(q: { provider: Provider; offerId?: string; externalId?: string }, status: ConnectionStatus, reason: string | null, at: Date): Promise<string[]>;

  fieldMap(offerId: string, provider: Provider): Promise<FieldMapRow[]>;
  setFieldMap(rows: FieldMapRow[]): Promise<void>;

  addEcho(e: Echo): Promise<void>;
  /** The unexpired, unmatched echo of this entity whose change the observed change includes (its id). */
  findEcho(q: { offerId: string; provider: Provider; entity: string; entityId: string; change: J; at: Date }): Promise<number | undefined>;
  /** An echo matched by a delivery, once the delivery's facts are recorded: it matches nothing again. */
  markEcho(id: number, at: Date): Promise<void>;

  version(offerId: string, provider: Provider, kind: string, entityId: string): Promise<Version | undefined>;
  putVersion(v: Version): Promise<void>;

  ghlToken(locationId: string): Promise<GhlToken | undefined>;
  ghlTokensExpiringBefore(at: Date): Promise<GhlToken[]>;
  /**
   * Holds the location's token row (select ... for update) while `fn` runs, and writes what it gives back before the
   * lock is let go: two refreshes can never both spend the single-use refresh token.
   */
  lockGhlToken<T>(locationId: string, fn: (row: GhlToken | undefined) => Promise<{ set?: Partial<GhlToken>; result: T }>): Promise<T>;

  addAgreementCheck(a: Omit<AgreementCheck, "id" | "lastCheckedAt" | "lastStatus" | "checks" | "status" | "settledAt">): Promise<AgreementCheck>;
  agreementChecks(q: { locationId?: string; offerId?: string; status?: AgreementCheck["status"]; dueBy?: Date }): Promise<AgreementCheck[]>;
  updateAgreementCheck(id: number, patch: Partial<AgreementCheck>): Promise<void>;

  addTranscriptWait(w: Omit<TranscriptWait, "id">): Promise<TranscriptWait | undefined>;
  transcriptWait(id: number): Promise<TranscriptWait | undefined>;
  updateTranscriptWait(id: number, patch: Partial<TranscriptWait>): Promise<void>;

  /** Keeps a delivery once: the same source and delivery id is the same row. */
  recordDelivery(d: NewDelivery): Promise<{ id: number; stored: boolean }>;
  delivery(id: number): Promise<Delivery | undefined>;
  markDelivery(id: number, x: { outcome: string; offerId?: string | null; at: Date }): Promise<void>;
  /** Deliveries not yet read, oldest first. */
  unprocessed(source?: string, limit?: number): Promise<Delivery[]>;
}

/** Whether an observed change includes everything an echo expected: each expected key, the same value (objects compared key by key). */
export function changeIncludes(observed: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!observed || typeof observed !== "object" || Array.isArray(observed)) return false;
    return Object.entries(expected as J).every(([k, v]) => changeIncludes((observed as J)[k], v));
  }
  return JSON.stringify(observed) === JSON.stringify(expected);
}
