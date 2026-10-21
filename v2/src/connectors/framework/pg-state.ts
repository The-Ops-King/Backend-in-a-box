import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import { open, seal } from "@/lib/secrets";
import type { ConnectionStatus } from "@/engine/types";
import { type AgreementCheck, type ConnectorState, type Echo, type GhlToken, type NewConnection, type NewDelivery, type TranscriptWait, type Version, changeIncludes } from "./state";
import type { Connection, Delivery, FieldMapRow, J, Provider } from "./types";

const { connections, fieldMaps, connectorEchoes, entityVersions, ghlConnections, agreementChecks, transcriptWaits, inbox } = schema;
type Db = NodePgDatabase<typeof schema>;

const openCreds = (enc: string | null): Record<string, string> => (enc ? (JSON.parse(open(enc)) as Record<string, string>) : {});

function toConnection(r: typeof connections.$inferSelect): Connection | undefined {
  if (!r.provider) return undefined;   // a bare engine pause row (the platform's own Slack): no connector
  return {
    id: r.id, offerId: r.offerId, port: r.port, provider: r.provider as Provider, mode: r.mode, status: r.status as ConnectionStatus,
    externalId: r.externalId, config: (r.config ?? {}) as J, credentials: openCreds(r.credentialsEnc),
  };
}

const toDelivery = (r: typeof inbox.$inferSelect): Delivery => ({
  id: r.id, source: r.source, deliveryId: r.deliveryId, eventType: r.eventType, locationId: r.locationId, connectionId: r.connectionId, offerId: r.offerId,
  headers: (r.headers ?? {}) as Record<string, string>, body: r.body, receivedAt: r.receivedAt, processedAt: r.processedAt,
});

const toToken = (r: typeof ghlConnections.$inferSelect): GhlToken => ({
  locationId: r.locationId, companyId: r.companyId, accessToken: open(r.accessTokenEnc), refreshToken: open(r.refreshTokenEnc), expiresAt: r.expiresAt,
  scopes: r.scopes, status: r.status as GhlToken["status"],
});

/** The connectors' state in Postgres. Credentials and tokens are sealed at rest (TOKEN_KEY) and opened only when used. */
export class PgConnectorState implements ConnectorState {
  constructor(private db: Db) {}

  async connection(offerId: string, port: string) {
    const [r] = await this.db.select().from(connections).where(and(eq(connections.offerId, offerId), eq(connections.port, port)));
    return r ? toConnection(r) : undefined;
  }
  async connectionById(id: string) {
    const [r] = await this.db.select().from(connections).where(eq(connections.id, id));
    return r ? toConnection(r) : undefined;
  }
  async connectionsOf(provider: Provider, externalId?: string) {
    const rows = await this.db.select().from(connections).where(and(eq(connections.provider, provider), externalId === undefined ? sql`true` : eq(connections.externalId, externalId)));
    return rows.map(toConnection).filter((c): c is Connection => !!c);
  }
  async upsertConnection(c: NewConnection) {
    // credentials left out are kept as they are; given, they replace what was there
    const creds = c.credentials && Object.keys(c.credentials).length ? { credentialsEnc: seal(JSON.stringify(c.credentials)) } : {};
    const row = { offerId: c.offerId, port: c.port, provider: c.provider, mode: c.mode ?? null, externalId: c.externalId ?? null, config: c.config ?? {}, ...creds, status: c.status ?? "connected", updatedAt: new Date() };
    const [r] = await this.db.insert(connections).values(row).onConflictDoUpdate({ target: [connections.offerId, connections.port], set: { ...row, reason: null, pausedAt: null } }).returning();
    return toConnection(r!)!;
  }
  async setStatus(q: { provider: Provider; offerId?: string; externalId?: string }, status: ConnectionStatus, reason: string | null, at: Date) {
    const rows = await this.db.update(connections).set({ status, reason, pausedAt: status === "connected" ? null : at, updatedAt: at })
      .where(and(eq(connections.provider, q.provider), q.offerId ? eq(connections.offerId, q.offerId) : sql`true`, q.externalId ? eq(connections.externalId, q.externalId) : sql`true`))
      .returning({ offerId: connections.offerId });
    return [...new Set(rows.map((r) => r.offerId))];
  }

  async fieldMap(offerId: string, provider: Provider) {
    const rows = await this.db.select().from(fieldMaps).where(and(eq(fieldMaps.offerId, offerId), eq(fieldMaps.provider, provider)));
    return rows.map((r) => ({ offerId: r.offerId, provider: r.provider as Provider, object: r.object, canonicalField: r.canonicalField, providerFieldId: r.providerFieldId, valueType: r.valueType as FieldMapRow["valueType"], options: (r.options ?? {}) as J }));
  }
  async setFieldMap(rows: FieldMapRow[]) {
    for (const r of rows) {
      await this.db.insert(fieldMaps).values({ ...r, updatedAt: new Date() }).onConflictDoUpdate({
        target: [fieldMaps.offerId, fieldMaps.provider, fieldMaps.object, fieldMaps.canonicalField],
        set: { providerFieldId: r.providerFieldId, valueType: r.valueType, options: r.options, updatedAt: new Date() },
      });
    }
  }

  async addEcho(e: Echo) { await this.db.insert(connectorEchoes).values(e); }
  async findEcho(q: { offerId: string; provider: Provider; entity: string; entityId: string; change: J; at: Date }) {
    const rows = await this.db.select().from(connectorEchoes).where(and(
      eq(connectorEchoes.offerId, q.offerId), eq(connectorEchoes.provider, q.provider), eq(connectorEchoes.entity, q.entity), eq(connectorEchoes.entityId, q.entityId),
      isNull(connectorEchoes.matchedAt), sql`${connectorEchoes.expiresAt} > ${q.at.toISOString()}`, lte(connectorEchoes.createdAt, q.at),
    )).orderBy(asc(connectorEchoes.id));
    return rows.find((r) => changeIncludes(q.change, r.change as J))?.id;
  }
  async markEcho(id: number, at: Date) { await this.db.update(connectorEchoes).set({ matchedAt: at }).where(and(eq(connectorEchoes.id, id), isNull(connectorEchoes.matchedAt))); }

  async version(offerId: string, provider: Provider, kind: string, entityId: string) {
    const [r] = await this.db.select().from(entityVersions).where(and(eq(entityVersions.offerId, offerId), eq(entityVersions.provider, provider), eq(entityVersions.kind, kind), eq(entityVersions.entityId, entityId)));
    return r ? { offerId: r.offerId, provider: r.provider as Provider, kind: r.kind, entityId: r.entityId, versionAt: r.versionAt, state: (r.state ?? {}) as J, updatedAt: r.updatedAt } : undefined;
  }
  async putVersion(v: Version) {
    await this.db.insert(entityVersions).values(v).onConflictDoUpdate({
      target: [entityVersions.offerId, entityVersions.provider, entityVersions.kind, entityVersions.entityId], set: { versionAt: v.versionAt, state: v.state, updatedAt: v.updatedAt },
    });
  }

  async ghlToken(locationId: string) {
    const [r] = await this.db.select().from(ghlConnections).where(eq(ghlConnections.locationId, locationId));
    return r ? toToken(r) : undefined;
  }
  async ghlTokensExpiringBefore(at: Date) {
    const rows = await this.db.select().from(ghlConnections).where(and(eq(ghlConnections.status, "connected"), sql`${ghlConnections.expiresAt} < ${at.toISOString()}`));
    return rows.map(toToken);
  }
  async lockGhlToken<T>(locationId: string, fn: (row: GhlToken | undefined) => Promise<{ set?: Partial<GhlToken>; result: T }>): Promise<T> {
    return this.db.transaction(async (t) => {
      const [r] = await t.select().from(ghlConnections).where(eq(ghlConnections.locationId, locationId)).for("update");
      const out = await fn(r ? toToken(r) : undefined);
      if (out.set && r) {
        const s = out.set;
        await t.update(ghlConnections).set({
          ...(s.accessToken !== undefined ? { accessTokenEnc: seal(s.accessToken) } : {}),
          ...(s.refreshToken !== undefined ? { refreshTokenEnc: seal(s.refreshToken) } : {}),
          ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}),
          ...(s.scopes !== undefined ? { scopes: s.scopes } : {}),
          ...(s.status !== undefined ? { status: s.status } : {}),
        }).where(eq(ghlConnections.locationId, locationId));
      }
      return out.result;
    });
  }

  async addAgreementCheck(a: Omit<AgreementCheck, "id" | "lastCheckedAt" | "lastStatus" | "checks" | "status" | "settledAt">) {
    await this.db.insert(agreementChecks).values(a).onConflictDoNothing();
    const [r] = await this.db.select().from(agreementChecks).where(and(eq(agreementChecks.offerId, a.offerId), eq(agreementChecks.agreementId, a.agreementId)));
    return r as AgreementCheck;
  }
  async agreementChecks(q: { locationId?: string; offerId?: string; status?: AgreementCheck["status"]; dueBy?: Date }) {
    return (await this.db.select().from(agreementChecks).where(and(
      q.locationId ? eq(agreementChecks.locationId, q.locationId) : sql`true`, q.offerId ? eq(agreementChecks.offerId, q.offerId) : sql`true`,
      q.status ? eq(agreementChecks.status, q.status) : sql`true`, q.dueBy ? lte(agreementChecks.nextCheckAt, q.dueBy) : sql`true`,
    )).orderBy(asc(agreementChecks.nextCheckAt), asc(agreementChecks.id))) as AgreementCheck[];
  }
  async updateAgreementCheck(id: number, patch: Partial<AgreementCheck>) {
    const { id: _id, ...rest } = patch;
    await this.db.update(agreementChecks).set(rest).where(eq(agreementChecks.id, id));
  }

  async addTranscriptWait(w: Omit<TranscriptWait, "id">) {
    const [r] = await this.db.insert(transcriptWaits).values(w).onConflictDoNothing().returning();
    return r as TranscriptWait | undefined;
  }
  async transcriptWait(id: number) { const [r] = await this.db.select().from(transcriptWaits).where(eq(transcriptWaits.id, id)); return r as TranscriptWait | undefined; }
  async updateTranscriptWait(id: number, patch: Partial<TranscriptWait>) {
    const { id: _id, ...rest } = patch;
    await this.db.update(transcriptWaits).set(rest).where(eq(transcriptWaits.id, id));
  }

  async recordDelivery(d: NewDelivery) {
    const rows = await this.db.insert(inbox).values({ ...d, ...(d.receivedAt ? {} : { receivedAt: new Date() }) }).onConflictDoNothing().returning({ id: inbox.id });
    if (rows[0]) return { id: rows[0].id, stored: true };
    const [r] = await this.db.select({ id: inbox.id }).from(inbox).where(and(eq(inbox.source, d.source), eq(inbox.deliveryId, d.deliveryId)));
    return { id: r!.id, stored: false };
  }
  async delivery(id: number) { const [r] = await this.db.select().from(inbox).where(eq(inbox.id, id)); return r ? toDelivery(r) : undefined; }
  async markDelivery(id: number, x: { outcome: string; offerId?: string | null; at: Date }) {
    await this.db.update(inbox).set({ outcome: x.outcome, processedAt: x.at, ...(x.offerId !== undefined ? { offerId: x.offerId } : {}) }).where(eq(inbox.id, id));
  }
  async unprocessed(source?: string, limit = 100) {
    const rows = await this.db.select().from(inbox).where(and(isNull(inbox.processedAt), source ? eq(inbox.source, source) : sql`true`)).orderBy(asc(inbox.id)).limit(limit);
    return rows.map(toDelivery);
  }
}
