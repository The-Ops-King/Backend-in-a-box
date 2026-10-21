import { type SQL, and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import type { EventQuery, OutboxQuery, PostQuery, RunQuery, SendCount, Store, Tx } from "./store";
import type {
  AlertRow, ConnectionRow, ContentRow, EventRow, Job, NewEvent, NewOutbox, NewRun, OfferRow, OutboxRow, PostRow, RunRow, StepRow,
  VersionRow, WorkflowRow,
} from "./types";

const { offers, workflows, workflowVersions, settings, content, connections, operatorAddresses, events, runs, runSteps, outbox, slackPosts, alerts } = schema;

type Db = NodePgDatabase<typeof schema>;
type DTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * How jobs are written: into graphile-worker's queue in the same transaction (the worker), or nowhere (tests and
 * tools that run everything due themselves with `runDue`).
 */
export type JobMode = "graphile" | "none";

/** The Postgres store, through Drizzle. */
export class PgStore implements Store {
  constructor(private db: Db, private jobs: JobMode = "none") {}
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction((t) => fn(new PgTx(t, this.jobs)));
  }
}

const one = <T>(rows: T[]): T | undefined => rows[0];

class PgTx implements Tx {
  constructor(private t: DTx, private jobs: JobMode) {}

  async offer(id: string) { return one(await this.t.select().from(offers).where(eq(offers.id, id))) as OfferRow | undefined; }
  async insertOffer(o: Omit<OfferRow, "id" | "sendsPausedAt" | "sendsPausedReason"> & { id?: string }) {
    return (await this.t.insert(offers).values(o).returning())[0] as OfferRow;
  }
  async updateOffer(id: string, patch: Partial<OfferRow>) { await this.t.update(offers).set(patch).where(eq(offers.id, id)); }
  async settings(offerId: string) {
    return Object.fromEntries((await this.t.select().from(settings).where(eq(settings.offerId, offerId))).map((r) => [r.key, r.value]));
  }
  async setSetting(offerId: string, key: string, value: unknown, by: string) {
    await this.t.insert(settings).values({ offerId, key, value, updatedBy: by }).onConflictDoUpdate({ target: [settings.offerId, settings.key], set: { value, updatedBy: by, updatedAt: new Date() } });
  }
  async content(offerId: string, key: string) {
    return one(await this.t.select().from(content).where(and(eq(content.offerId, offerId), eq(content.key, key)))) as ContentRow | undefined;
  }
  async contentKeys(offerId: string) { return (await this.t.select({ key: content.key }).from(content).where(eq(content.offerId, offerId)).orderBy(asc(content.key))).map((r) => r.key); }
  async setContent(row: ContentRow) {
    const { offerId, key, ...rest } = row;
    await this.t.insert(content).values(row).onConflictDoUpdate({ target: [content.offerId, content.key], set: rest });
    void offerId; void key;
  }
  async workflow(id: string) { return one(await this.t.select().from(workflows).where(eq(workflows.id, id))) as WorkflowRow | undefined; }
  async workflowByKey(offerId: string, key: string) {
    return one(await this.t.select().from(workflows).where(and(eq(workflows.offerId, offerId), eq(workflows.key, key)))) as WorkflowRow | undefined;
  }
  async workflows(offerId: string) { return (await this.t.select().from(workflows).where(eq(workflows.offerId, offerId)).orderBy(asc(workflows.key))) as WorkflowRow[]; }
  async insertWorkflow(w: Pick<WorkflowRow, "offerId" | "key" | "name">) { return (await this.t.insert(workflows).values(w).returning())[0] as WorkflowRow; }
  async updateWorkflow(id: string, patch: Partial<WorkflowRow>) { await this.t.update(workflows).set(patch).where(eq(workflows.id, id)); }
  async version(id: string) { return one(await this.t.select().from(workflowVersions).where(eq(workflowVersions.id, id))) as VersionRow | undefined; }
  async latestVersion(workflowId: string) {
    return one(await this.t.select().from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId)).orderBy(desc(workflowVersions.version)).limit(1)) as VersionRow | undefined;
  }
  async insertVersion(v: Omit<VersionRow, "id">) { return (await this.t.insert(workflowVersions).values(v).returning())[0] as VersionRow; }
  async operatorAddresses() {
    const rows = await this.t.select().from(operatorAddresses);
    return { emails: rows.filter((r) => r.kind === "email").map((r) => r.value), phones: rows.filter((r) => r.kind === "phone").map((r) => r.value) };
  }
  async addOperatorAddress(kind: "email" | "phone", value: string) { await this.t.insert(operatorAddresses).values({ kind, value }).onConflictDoNothing(); }
  async connection(offerId: string, port: string) {
    return one(await this.t.select().from(connections).where(and(eq(connections.offerId, offerId), eq(connections.port, port)))) as ConnectionRow | undefined;
  }
  async setConnection(row: ConnectionRow) {
    await this.t.insert(connections).values(row).onConflictDoUpdate({ target: [connections.offerId, connections.port], set: { status: row.status, reason: row.reason, pausedAt: row.pausedAt } });
  }

  async appendEvent(e: NewEvent) {
    const inserted = await this.t.insert(events).values(e).onConflictDoNothing({ target: [events.offerId, events.dedupeKey] }).returning();
    if (inserted[0]) return { event: inserted[0] as EventRow, inserted: true };
    const same = await this.t.select().from(events).where(and(eq(events.offerId, e.offerId), eq(events.dedupeKey, e.dedupeKey)));
    return { event: same[0] as EventRow, inserted: false };
  }
  async event(id: number) { return one(await this.t.select().from(events).where(eq(events.id, id))) as EventRow | undefined; }
  async events(q: EventQuery) {
    const w: SQL[] = [eq(events.offerId, q.offerId)];
    if (q.types) w.push(inArray(events.type, q.types));
    if (q.contactId !== undefined) w.push(eq(events.contactId, q.contactId));
    if (q.appointmentId !== undefined) w.push(eq(events.appointmentId, q.appointmentId));
    if (q.dealId !== undefined) w.push(eq(events.dealId, q.dealId));
    if (q.since) w.push(gte(events.occurredAt, q.since));
    if (q.until) w.push(lte(events.occurredAt, q.until));
    if (q.tag !== undefined) w.push(sql`${events.payload}->>'tag' = ${q.tag}`);
    if (q.runId !== undefined) w.push(sql`${events.payload}->>'run_id' = ${q.runId}`);
    if (q.node !== undefined) w.push(sql`${events.payload}->>'node' = ${q.node}`);
    const order = q.order === "desc" ? [desc(events.occurredAt), desc(events.id)] : [asc(events.occurredAt), asc(events.id)];
    const base = this.t.select().from(events).where(and(...w)).orderBy(...order);
    return (q.limit ? await base.limit(q.limit) : await base) as EventRow[];
  }

  async insertRun(r: NewRun) {
    const rows = await this.t.insert(runs).values(r).onConflictDoNothing({ target: [runs.workflowId, runs.reentryKey] }).returning();
    return rows[0] as RunRow | undefined;
  }
  async run(id: string, lock?: "wait" | "skip") {
    const q = this.t.select().from(runs).where(eq(runs.id, id));
    const rows = lock === "wait" ? await q.for("update") : lock === "skip" ? await q.for("update", { skipLocked: true }) : await q;
    return rows[0] as RunRow | undefined;
  }
  async updateRun(id: string, patch: Partial<RunRow>) { await this.t.update(runs).set(patch).where(eq(runs.id, id)); }
  async runs(q: RunQuery) {
    const w: SQL[] = [];
    if (q.offerId) w.push(eq(runs.offerId, q.offerId));
    if (q.workflowId) w.push(eq(runs.workflowId, q.workflowId));
    if (q.statuses) w.push(inArray(runs.status, q.statuses));
    if (q.about) {
      const any: SQL[] = [];
      if (q.about.contactId) any.push(eq(runs.contactId, q.about.contactId));
      if (q.about.appointmentId) any.push(eq(runs.appointmentId, q.about.appointmentId));
      if (q.about.dealId) any.push(eq(runs.dealId, q.about.dealId));
      w.push(any.length ? or(...any)! : sql`false`);
    }
    if (q.reentryBase !== undefined) w.push(eq(runs.reentryBase, q.reentryBase));
    if (q.startedSince) w.push(gte(runs.startedAt, q.startedSince));
    if (q.dueBy) w.push(and(isNotNull(runs.nextWakeAt), lte(runs.nextWakeAt, q.dueBy))!);
    if (q.waitingOnTag !== undefined) w.push(sql`${runs.wake}->>'kind' = 'answer' and ${runs.wake}->>'tag' = ${q.waitingOnTag}`);
    const base = this.t.select().from(runs).where(w.length ? and(...w) : undefined).orderBy(asc(runs.nextWakeAt), asc(runs.startedAt));
    return (q.limit ? await base.limit(q.limit) : await base) as RunRow[];
  }

  async insertStep(s: Omit<StepRow, "id">) { return (await this.t.insert(runSteps).values(s).returning())[0] as StepRow; }
  async step(id: number) { return one(await this.t.select().from(runSteps).where(eq(runSteps.id, id))) as StepRow | undefined; }
  async updateStep(id: number, patch: Partial<StepRow>) { await this.t.update(runSteps).set(patch).where(eq(runSteps.id, id)); }
  async steps(runId: string) { return (await this.t.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.id))) as StepRow[]; }

  async insertOutbox(o: NewOutbox) {
    const rows = await this.t.insert(outbox).values(o).onConflictDoNothing({ target: outbox.idempotencyKey }).returning();
    if (rows[0]) return rows[0] as OutboxRow;
    return (await this.t.select().from(outbox).where(eq(outbox.idempotencyKey, o.idempotencyKey)))[0] as OutboxRow;
  }
  async outboxRow(id: number, lock?: "wait" | "skip") {
    const q = this.t.select().from(outbox).where(eq(outbox.id, id));
    const rows = lock === "wait" ? await q.for("update") : lock === "skip" ? await q.for("update", { skipLocked: true }) : await q;
    return rows[0] as OutboxRow | undefined;
  }
  async updateOutbox(id: number, patch: Partial<OutboxRow>) { await this.t.update(outbox).set(patch).where(eq(outbox.id, id)); }
  async outboxRows(q: OutboxQuery) {
    const w: SQL[] = [];
    if (q.offerId) w.push(eq(outbox.offerId, q.offerId));
    if (q.runId) w.push(eq(outbox.runId, q.runId));
    if (q.contactId) w.push(eq(outbox.contactId, q.contactId));
    if (q.kinds) w.push(inArray(outbox.kind, q.kinds));
    if (q.statuses) w.push(inArray(outbox.status, q.statuses));
    if (q.dueBy) w.push(and(isNotNull(outbox.nextAttemptAt), lte(outbox.nextAttemptAt, q.dueBy))!);
    const base = this.t.select().from(outbox).where(w.length ? and(...w) : undefined).orderBy(asc(outbox.nextAttemptAt), asc(outbox.id));
    return (q.limit ? await base.limit(q.limit) : await base) as OutboxRow[];
  }
  async countSends(q: SendCount) {
    const w: SQL[] = [eq(outbox.offerId, q.offerId), inArray(outbox.kind, q.kinds), inArray(outbox.status, ["sending", "sent", "unknown"]), isNotNull(outbox.sentAt), gte(outbox.sentAt, q.since)];
    if (q.contactId !== undefined) w.push(eq(outbox.contactId, q.contactId));
    if (q.until) w.push(lt(outbox.sentAt, q.until));
    const r = await this.t.select({ n: sql<number>`count(*)::int` }).from(outbox).where(and(...w));
    return r[0]?.n ?? 0;
  }

  async insertPost(p: Omit<PostRow, "id">) { return (await this.t.insert(slackPosts).values(p).returning())[0] as PostRow; }
  async updatePost(id: number, patch: Partial<Pick<PostRow, "outboxId" | "runId" | "node" | "tag">>) {
    await this.t.update(slackPosts).set(patch).where(eq(slackPosts.id, id));
  }
  async posts(q: PostQuery) {
    const w: SQL[] = [eq(slackPosts.offerId, q.offerId)];
    if (q.runId !== undefined) w.push(eq(slackPosts.runId, q.runId));
    if (q.node !== undefined) w.push(eq(slackPosts.node, q.node));
    if (q.tag !== undefined) w.push(eq(slackPosts.tag, q.tag));
    if (q.outboxId !== undefined) w.push(eq(slackPosts.outboxId, q.outboxId));
    if (q.channel !== undefined) w.push(eq(slackPosts.channel, q.channel));
    if (q.ts !== undefined) w.push(eq(slackPosts.ts, q.ts));
    return (await this.t.select().from(slackPosts).where(and(...w)).orderBy(desc(slackPosts.id))) as PostRow[];
  }

  async raiseAlert(a: Omit<AlertRow, "id" | "resolvedAt">) {
    const rows = await this.t.insert(alerts).values(a).onConflictDoNothing({ target: alerts.key, where: isNull(alerts.resolvedAt) }).returning();
    if (rows[0]) return rows[0] as AlertRow;
    return (await this.t.select().from(alerts).where(and(eq(alerts.key, a.key), isNull(alerts.resolvedAt))))[0] as AlertRow;
  }
  async resolveAlert(key: string, at: Date) { await this.t.update(alerts).set({ resolvedAt: at }).where(and(eq(alerts.key, key), isNull(alerts.resolvedAt))); }
  async alerts(q: { offerId?: string; open?: boolean }) {
    const w: SQL[] = [];
    if (q.offerId) w.push(eq(alerts.offerId, q.offerId));
    if (q.open !== undefined) w.push(q.open ? isNull(alerts.resolvedAt) : isNotNull(alerts.resolvedAt));
    return (await this.t.select().from(alerts).where(w.length ? and(...w) : undefined).orderBy(asc(alerts.id))) as AlertRow[];
  }
  private sp = 0;
  async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    const name = sql.raw(`sp_${++this.sp}`);
    await this.t.execute(sql`savepoint ${name}`);
    try {
      const out = await fn();
      await this.t.execute(sql`release savepoint ${name}`);
      return out;
    } catch (e) {
      await this.t.execute(sql`rollback to savepoint ${name}`);
      throw e;
    }
  }
  async lockKey(key: string) { await this.t.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`); }
  async schedule(job: Job) {
    if (this.jobs === "none") return;
    const [task, key] = job.kind === "run" ? ["wake_run", `run:${job.id}`] : ["dispatch", `outbox:${job.id}`];
    await this.t.execute(sql`select graphile_worker.add_job(${task}, json_build_object('id', ${String(job.id)}::text), run_at => ${job.at.toISOString()}::timestamptz, job_key => ${key}, job_key_mode => 'replace')`);
  }
}
