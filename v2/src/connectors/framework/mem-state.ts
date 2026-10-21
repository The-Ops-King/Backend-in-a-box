import crypto from "node:crypto";
import type { ConnectionStatus } from "@/engine/types";
import { type AgreementCheck, type ConnectorState, type Echo, type GhlToken, type NewConnection, type NewDelivery, type TranscriptWait, type Version, changeIncludes } from "./state";
import type { Connection, Delivery, FieldMapRow, J, Provider } from "./types";

const copy = <T>(x: T): T => structuredClone(x);

/** The connectors' state in memory: for the contract suites, the simulator and tests without a database. */
export class MemConnectorState implements ConnectorState {
  connections: Connection[] = [];
  fieldMaps: FieldMapRow[] = [];
  echoes: (Echo & { id: number; matchedAt: Date | null })[] = [];
  versions = new Map<string, Version>();
  tokens = new Map<string, GhlToken>();
  agreements: AgreementCheck[] = [];
  waits: TranscriptWait[] = [];
  inbox: (Delivery & { processedAt: Date | null; outcome: string | null })[] = [];
  private locks = new Map<string, Promise<void>>();
  private n = 0;

  async connection(offerId: string, port: string) { const c = this.connections.find((x) => x.offerId === offerId && x.port === port); return c && copy(c); }
  async connectionById(id: string) { const c = this.connections.find((x) => x.id === id); return c && copy(c); }
  async connectionsOf(provider: Provider, externalId?: string) { return copy(this.connections.filter((c) => c.provider === provider && (externalId === undefined || c.externalId === externalId))); }
  async upsertConnection(c: NewConnection): Promise<Connection> {
    const i = this.connections.findIndex((x) => x.offerId === c.offerId && x.port === c.port);
    const row: Connection = {
      id: i >= 0 ? this.connections[i]!.id : crypto.randomUUID(), offerId: c.offerId, port: c.port, provider: c.provider, mode: c.mode ?? null,
      status: c.status ?? "connected", externalId: c.externalId ?? null, config: c.config ?? {}, credentials: c.credentials && Object.keys(c.credentials).length ? c.credentials : i >= 0 ? this.connections[i]!.credentials : {},
    };
    if (i >= 0) this.connections[i] = row; else this.connections.push(row);
    return copy(row);
  }
  async setStatus(q: { provider: Provider; offerId?: string; externalId?: string }, status: ConnectionStatus) {
    const hit = this.connections.filter((c) => c.provider === q.provider && (!q.offerId || c.offerId === q.offerId) && (!q.externalId || c.externalId === q.externalId));
    for (const c of hit) c.status = status;
    return [...new Set(hit.map((c) => c.offerId))];
  }

  async fieldMap(offerId: string, provider: Provider) { return copy(this.fieldMaps.filter((f) => f.offerId === offerId && f.provider === provider)); }
  async setFieldMap(rows: FieldMapRow[]) {
    for (const r of rows) {
      const i = this.fieldMaps.findIndex((f) => f.offerId === r.offerId && f.provider === r.provider && f.object === r.object && f.canonicalField === r.canonicalField);
      if (i >= 0) this.fieldMaps[i] = copy(r); else this.fieldMaps.push(copy(r));
    }
  }

  async addEcho(e: Echo) { this.echoes.push({ ...copy(e), id: ++this.n, matchedAt: null }); }
  async findEcho(q: { offerId: string; provider: Provider; entity: string; entityId: string; change: J; at: Date }) {
    return this.echoes.find((x) => !x.matchedAt && x.offerId === q.offerId && x.provider === q.provider && x.entity === q.entity && x.entityId === q.entityId
      && x.expiresAt > q.at && x.createdAt <= q.at && changeIncludes(q.change, x.change))?.id;
  }
  async markEcho(id: number, at: Date) { const e = this.echoes.find((x) => x.id === id); if (e) e.matchedAt = at; }

  private vkey = (o: string, p: string, k: string, id: string) => [o, p, k, id].join("\u0000");
  async version(offerId: string, provider: Provider, kind: string, entityId: string) { const v = this.versions.get(this.vkey(offerId, provider, kind, entityId)); return v && copy(v); }
  async putVersion(v: Version) { this.versions.set(this.vkey(v.offerId, v.provider, v.kind, v.entityId), copy(v)); }

  async ghlToken(locationId: string) { const t = this.tokens.get(locationId); return t && copy(t); }
  async ghlTokensExpiringBefore(at: Date) { return copy([...this.tokens.values()].filter((t) => t.status === "connected" && t.expiresAt < at)); }
  async lockGhlToken<T>(locationId: string, fn: (row: GhlToken | undefined) => Promise<{ set?: Partial<GhlToken>; result: T }>): Promise<T> {
    const prior = this.locks.get(locationId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.locks.set(locationId, prior.then(() => mine));
    await prior;
    try {
      const out = await fn(await this.ghlToken(locationId));
      if (out.set) { const cur = this.tokens.get(locationId); if (cur) this.tokens.set(locationId, { ...cur, ...copy(out.set) }); }
      return out.result;
    } finally { release(); }
  }

  async addAgreementCheck(a: Omit<AgreementCheck, "id" | "lastCheckedAt" | "lastStatus" | "checks" | "status" | "settledAt">) {
    const existing = this.agreements.find((x) => x.offerId === a.offerId && x.agreementId === a.agreementId);
    if (existing) return copy(existing);
    const row: AgreementCheck = { ...copy(a), id: ++this.n, lastCheckedAt: null, lastStatus: null, checks: 0, status: "waiting", settledAt: null };
    this.agreements.push(row);
    return copy(row);
  }
  async agreementChecks(q: { locationId?: string; offerId?: string; status?: AgreementCheck["status"]; dueBy?: Date }) {
    return copy(this.agreements.filter((a) => (!q.locationId || a.locationId === q.locationId) && (!q.offerId || a.offerId === q.offerId) && (!q.status || a.status === q.status) && (!q.dueBy || a.nextCheckAt <= q.dueBy))
      .sort((a, b) => a.nextCheckAt.getTime() - b.nextCheckAt.getTime() || a.id - b.id));
  }
  async updateAgreementCheck(id: number, patch: Partial<AgreementCheck>) { const a = this.agreements.find((x) => x.id === id); if (a) Object.assign(a, copy(patch)); }

  async addTranscriptWait(w: Omit<TranscriptWait, "id">) {
    if (this.waits.some((x) => x.offerId === w.offerId && x.provider === w.provider && x.recordingId === w.recordingId)) return undefined;
    const row = { ...copy(w), id: ++this.n };
    this.waits.push(row);
    return copy(row);
  }
  async transcriptWait(id: number) { const w = this.waits.find((x) => x.id === id); return w && copy(w); }
  async updateTranscriptWait(id: number, patch: Partial<TranscriptWait>) { const w = this.waits.find((x) => x.id === id); if (w) Object.assign(w, copy(patch)); }

  async recordDelivery(d: NewDelivery) {
    const hit = this.inbox.find((x) => x.source === d.source && x.deliveryId === d.deliveryId);
    if (hit) return { id: hit.id, stored: false };
    const row = { ...copy(d), id: ++this.n, receivedAt: d.receivedAt ?? new Date(), processedAt: null, outcome: null };
    this.inbox.push(row);
    return { id: row.id, stored: true };
  }
  async delivery(id: number) { const d = this.inbox.find((x) => x.id === id); return d && copy(d); }
  async markDelivery(id: number, x: { outcome: string; offerId?: string | null; at: Date }) {
    const d = this.inbox.find((r) => r.id === id);
    if (d) { d.outcome = x.outcome; d.processedAt = x.at; if (x.offerId !== undefined) d.offerId = x.offerId; }
  }
  async unprocessed(source?: string, limit = 100) { return copy(this.inbox.filter((d) => !d.processedAt && (!source || d.source === source)).slice(0, limit)); }
}
