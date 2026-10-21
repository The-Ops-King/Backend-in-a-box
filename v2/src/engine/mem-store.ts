import { randomUUID } from "node:crypto";
import type { EventQuery, OutboxQuery, PostQuery, RunQuery, SendCount, Store, Tx } from "./store";
import type {
  AlertRow, ConnectionRow, ContentRow, EventRow, Job, NewEvent, NewOutbox, NewRun, OfferRow, OutboxRow, PostRow, RunRow, StepRow,
  VersionRow, WorkflowRow,
} from "./types";

/**
 * The store in memory, for the simulator: the same rows and the same rules the Postgres store keeps (a reentry key
 * once per workflow, an idempotency key once, a dedupe key once per offer, an outbox row only for a step of its own
 * run, facts and versions never changed). A transaction that throws leaves nothing behind.
 */

type State = {
  offers: OfferRow[]; workflows: WorkflowRow[]; versions: VersionRow[]; settings: { offerId: string; key: string; value: unknown }[];
  content: ContentRow[]; connections: ConnectionRow[]; operators: { kind: "email" | "phone"; value: string }[];
  events: EventRow[]; runs: RunRow[]; steps: StepRow[]; outbox: OutboxRow[]; posts: PostRow[]; alerts: AlertRow[]; jobs: Job[];
  seq: { event: number; step: number; outbox: number; post: number; alert: number };
};

const empty = (): State => ({
  offers: [], workflows: [], versions: [], settings: [], content: [], connections: [], operators: [], events: [], runs: [], steps: [],
  outbox: [], posts: [], alerts: [], jobs: [], seq: { event: 0, step: 0, outbox: 0, post: 0, alert: 0 },
});

/** What a jsonb column gives back: a copy, through JSON, so a caller never shares an object with the store. */
const J = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const copy = <T>(row: T): T => structuredClone(row);

export class ConstraintError extends Error {
  constructor(public constraint: string, message: string) { super(message); this.name = "ConstraintError"; }
}

export class MemStore implements Store {
  state: State = empty();
  private chain: Promise<unknown> = Promise.resolve();

  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const go = async () => {
      const before = structuredClone(this.state);
      try { return await fn(new MemTx(this.state)); } catch (e) { this.state = before; throw e; }
    };
    const p = this.chain.then(go, go);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Every row, for the simulator's timeline. */
  snapshot(): State { return structuredClone(this.state); }
}

const matchesAbout = (r: { contactId: string | null; appointmentId: string | null; dealId: string | null }, a: NonNullable<RunQuery["about"]>) =>
  (!!a.contactId && r.contactId === a.contactId) || (!!a.appointmentId && r.appointmentId === a.appointmentId) || (!!a.dealId && r.dealId === a.dealId);

class MemTx implements Tx {
  constructor(private s: State) {}

  async offer(id: string) { const o = this.s.offers.find((x) => x.id === id); return o && copy(o); }
  async insertOffer(o: Omit<OfferRow, "id" | "sendsPausedAt" | "sendsPausedReason"> & { id?: string }) {
    if (this.s.offers.some((x) => x.slug === o.slug)) throw new ConstraintError("offers_slug_unique", `offer ${o.slug} exists`);
    const row: OfferRow = { id: o.id ?? randomUUID(), slug: o.slug, name: o.name, zone: o.zone, sendsPausedAt: null, sendsPausedReason: null };
    this.s.offers.push(row);
    return copy(row);
  }
  async updateOffer(id: string, patch: Partial<OfferRow>) { Object.assign(this.s.offers.find((x) => x.id === id)!, copy(patch)); }
  async settings(offerId: string) { return Object.fromEntries(this.s.settings.filter((x) => x.offerId === offerId).map((x) => [x.key, J(x.value)])); }
  async setSetting(offerId: string, key: string, value: unknown) {
    const at = this.s.settings.find((x) => x.offerId === offerId && x.key === key);
    if (at) at.value = J(value); else this.s.settings.push({ offerId, key, value: J(value) });
  }
  async content(offerId: string, key: string) { const c = this.s.content.find((x) => x.offerId === offerId && x.key === key); return c && copy(c); }
  async contentKeys(offerId: string) { return this.s.content.filter((x) => x.offerId === offerId).map((x) => x.key).sort(); }
  async setContent(row: ContentRow) {
    const i = this.s.content.findIndex((x) => x.offerId === row.offerId && x.key === row.key);
    if (i >= 0) this.s.content[i] = copy(row); else this.s.content.push(copy(row));
  }
  async workflow(id: string) { const w = this.s.workflows.find((x) => x.id === id); return w && copy(w); }
  async workflowByKey(offerId: string, key: string) { const w = this.s.workflows.find((x) => x.offerId === offerId && x.key === key); return w && copy(w); }
  async workflows(offerId: string) { return this.s.workflows.filter((x) => x.offerId === offerId).map(copy); }
  async insertWorkflow(w: Pick<WorkflowRow, "offerId" | "key" | "name">) {
    if (this.s.workflows.some((x) => x.offerId === w.offerId && x.key === w.key)) throw new ConstraintError("workflows_offer_key", `workflow ${w.key} exists`);
    const row: WorkflowRow = { id: randomUUID(), ...w, enabled: false, currentVersionId: null, delivery: "sandbox", deliverySetBy: null, deliverySetAt: null, deliveryNote: null, crmWrites: "dry", crmWritesSetBy: null, crmWritesSetAt: null };
    this.s.workflows.push(row);
    return copy(row);
  }
  async updateWorkflow(id: string, patch: Partial<WorkflowRow>) { Object.assign(this.s.workflows.find((x) => x.id === id)!, copy(patch)); }
  async version(id: string) { const v = this.s.versions.find((x) => x.id === id); return v && { ...copy(v), definition: J(v.definition) }; }
  async latestVersion(workflowId: string) {
    const v = this.s.versions.filter((x) => x.workflowId === workflowId).sort((a, b) => b.version - a.version)[0];
    return v && { ...copy(v), definition: J(v.definition) };
  }
  async insertVersion(v: Omit<VersionRow, "id">) {
    if (this.s.versions.some((x) => x.workflowId === v.workflowId && x.version === v.version)) throw new ConstraintError("workflow_versions_workflow_version", "version exists");
    const row = { ...copy(v), definition: J(v.definition), id: randomUUID() };
    this.s.versions.push(row);
    return copy(row);
  }
  async operatorAddresses() {
    return { emails: this.s.operators.filter((x) => x.kind === "email").map((x) => x.value), phones: this.s.operators.filter((x) => x.kind === "phone").map((x) => x.value) };
  }
  async addOperatorAddress(kind: "email" | "phone", value: string) { if (!this.s.operators.some((x) => x.kind === kind && x.value === value)) this.s.operators.push({ kind, value }); }
  async connection(offerId: string, port: string) { const c = this.s.connections.find((x) => x.offerId === offerId && x.port === port); return c && copy(c); }
  async setConnection(row: ConnectionRow) {
    const i = this.s.connections.findIndex((x) => x.offerId === row.offerId && x.port === row.port);
    if (i >= 0) this.s.connections[i] = copy(row); else this.s.connections.push(copy(row));
  }

  async appendEvent(e: NewEvent) {
    const same = this.s.events.find((x) => x.offerId === e.offerId && x.dedupeKey === e.dedupeKey);
    if (same) return { event: { ...copy(same), payload: J(same.payload) }, inserted: false };
    const row: EventRow = { ...copy(e), payload: J(e.payload), id: ++this.s.seq.event };
    this.s.events.push(row);
    return { event: { ...copy(row), payload: J(row.payload) }, inserted: true };
  }
  async event(id: number) { const e = this.s.events.find((x) => x.id === id); return e && { ...copy(e), payload: J(e.payload) }; }
  async events(q: EventQuery) {
    let rows = this.s.events.filter((e) => e.offerId === q.offerId
      && (!q.types || q.types.includes(e.type))
      && (q.contactId === undefined || e.contactId === q.contactId)
      && (q.appointmentId === undefined || e.appointmentId === q.appointmentId)
      && (q.dealId === undefined || e.dealId === q.dealId)
      && (!q.since || e.occurredAt.getTime() >= q.since.getTime())
      && (!q.until || e.occurredAt.getTime() <= q.until.getTime())
      && (q.tag === undefined || e.payload.tag === q.tag)
      && (q.runId === undefined || e.payload.run_id === q.runId)
      && (q.node === undefined || e.payload.node === q.node));
    rows = rows.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id - b.id);
    if (q.order === "desc") rows.reverse();
    if (q.limit) rows = rows.slice(0, q.limit);
    return rows.map((e) => ({ ...copy(e), payload: J(e.payload) }));
  }

  async insertRun(r: NewRun) {
    if (!this.s.workflows.some((w) => w.id === r.workflowId)) throw new ConstraintError("runs_workflow_id_fk", "no such workflow");
    if (!this.s.versions.some((v) => v.id === r.versionId)) throw new ConstraintError("runs_version_id_fk", "no such version");
    if (this.s.runs.some((x) => x.workflowId === r.workflowId && x.reentryKey === r.reentryKey)) return undefined;
    const row: RunRow = { ...copy(r), context: J(r.context), wake: J(r.wake), listeners: J(r.listeners), resume: J(r.resume), pendingTriggers: J(r.pendingTriggers), id: randomUUID(), leaseOwner: null, leaseUntil: null, finishedAt: null, endReason: null };
    this.s.runs.push(row);
    return this.out(row);
  }
  private out(r: RunRow): RunRow { return { ...copy(r), context: J(r.context), wake: J(r.wake), listeners: J(r.listeners), resume: J(r.resume), pendingTriggers: J(r.pendingTriggers) }; }
  async run(id: string) { const r = this.s.runs.find((x) => x.id === id); return r && this.out(r); }
  async updateRun(id: string, patch: Partial<RunRow>) {
    const r = this.s.runs.find((x) => x.id === id);
    if (!r) return;
    if (patch.reentryKey !== undefined && this.s.runs.some((x) => x.id !== id && x.workflowId === r.workflowId && x.reentryKey === patch.reentryKey)) throw new ConstraintError("runs_workflow_reentry", "reentry key taken");
    const j = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, ["context", "wake", "listeners", "resume", "pendingTriggers"].includes(k) ? J(v) : copy(v)]));
    Object.assign(r, j);
  }
  async runs(q: RunQuery) {
    let rows = this.s.runs.filter((r) => (!q.offerId || r.offerId === q.offerId)
      && (!q.workflowId || r.workflowId === q.workflowId)
      && (!q.statuses || q.statuses.includes(r.status))
      && (!q.about || matchesAbout(r, q.about))
      && (q.reentryBase === undefined || r.reentryBase === q.reentryBase)
      && (!q.startedSince || r.startedAt.getTime() >= q.startedSince.getTime())
      && (!q.dueBy || (r.nextWakeAt !== null && r.nextWakeAt.getTime() <= q.dueBy.getTime()))
      && (q.waitingOnTag === undefined || (r.wake?.kind === "answer" && r.wake.tag === q.waitingOnTag)));
    // as Postgres orders them: by next wake (none last), then by start
    rows = rows.sort((a, b) => (a.nextWakeAt?.getTime() ?? Infinity) - (b.nextWakeAt?.getTime() ?? Infinity) || a.startedAt.getTime() - b.startedAt.getTime());
    if (q.limit) rows = rows.slice(0, q.limit);
    return rows.map((r) => this.out(r));
  }

  async insertStep(s: Omit<StepRow, "id">) {
    if (!this.s.runs.some((r) => r.id === s.runId)) throw new ConstraintError("run_steps_run_id_fk", "no such run");
    const row: StepRow = { ...copy(s), result: J(s.result), id: ++this.s.seq.step };
    this.s.steps.push(row);
    return copy(row);
  }
  async step(id: number) { const s = this.s.steps.find((x) => x.id === id); return s && copy(s); }
  async updateStep(id: number, patch: Partial<StepRow>) {
    const s = this.s.steps.find((x) => x.id === id);
    if (s) Object.assign(s, copy(patch), patch.result ? { result: J(patch.result) } : {});
  }
  async steps(runId: string) { return this.s.steps.filter((x) => x.runId === runId).sort((a, b) => a.id - b.id).map(copy); }

  async insertOutbox(o: NewOutbox) {
    // the same rule the database's constraints keep: an effect belongs to a step of its own run
    if (!o.runId || o.stepId === undefined || o.stepId === null) throw new ConstraintError("outbox_run_and_step", "an outbox row needs its run and step");
    if (!this.s.steps.some((st) => st.id === o.stepId && st.runId === o.runId)) throw new ConstraintError("outbox_step_of_run", "the step is not one of that run's");
    const same = this.s.outbox.find((x) => x.idempotencyKey === o.idempotencyKey);
    if (same) return this.outRow(same);
    const row: OutboxRow = {
      ...copy(o), payload: J(o.payload), id: ++this.s.seq.outbox, status: "queued", gates: [], attempts: 0, leaseOwner: null, leaseUntil: null,
      errorClass: null, lastError: null, result: null, sentAt: null, settledAt: null,
    };
    this.s.outbox.push(row);
    return this.outRow(row);
  }
  private outRow(r: OutboxRow): OutboxRow { return { ...copy(r), payload: J(r.payload), gates: J(r.gates), result: J(r.result) }; }
  async outboxRow(id: number) { const r = this.s.outbox.find((x) => x.id === id); return r && this.outRow(r); }
  async updateOutbox(id: number, patch: Partial<OutboxRow>) {
    const r = this.s.outbox.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, ["payload", "gates", "result"].includes(k) ? J(v) : copy(v)])));
  }
  async outboxRows(q: OutboxQuery) {
    let rows = this.s.outbox.filter((r) => (!q.offerId || r.offerId === q.offerId) && (!q.runId || r.runId === q.runId)
      && (!q.contactId || r.contactId === q.contactId) && (!q.kinds || q.kinds.includes(r.kind))
      && (!q.statuses || q.statuses.includes(r.status))
      && (!q.dueBy || (r.nextAttemptAt !== null && r.nextAttemptAt.getTime() <= q.dueBy.getTime())));
    rows = rows.sort((a, b) => (a.nextAttemptAt?.getTime() ?? Infinity) - (b.nextAttemptAt?.getTime() ?? Infinity) || a.id - b.id);
    if (q.limit) rows = rows.slice(0, q.limit);
    return rows.map((r) => this.outRow(r));
  }
  async countSends(q: SendCount) {
    return this.s.outbox.filter((r) => r.offerId === q.offerId && (q.contactId === undefined || r.contactId === q.contactId) && q.kinds.includes(r.kind)
      && ["sending", "sent", "unknown"].includes(r.status) && r.sentAt !== null && r.sentAt.getTime() >= q.since.getTime()
      && (!q.until || r.sentAt.getTime() < q.until.getTime())).length;
  }

  async insertPost(p: Omit<PostRow, "id">) {
    const row: PostRow = { ...copy(p), id: ++this.s.seq.post };
    this.s.posts.push(row);
    return copy(row);
  }
  async updatePost(id: number, patch: Partial<Pick<PostRow, "outboxId" | "runId" | "node" | "tag">>) {
    const row = this.s.posts.find((p) => p.id === id);
    if (row) Object.assign(row, copy(patch));
  }
  async posts(q: PostQuery) {
    return this.s.posts.filter((p) => p.offerId === q.offerId && (q.runId === undefined || p.runId === q.runId) && (q.node === undefined || p.node === q.node)
      && (q.tag === undefined || p.tag === q.tag) && (q.outboxId === undefined || p.outboxId === q.outboxId) && (q.channel === undefined || p.channel === q.channel)
      && (q.ts === undefined || p.ts === q.ts)).sort((a, b) => b.id - a.id).map(copy);
  }

  async raiseAlert(a: Omit<AlertRow, "id" | "resolvedAt">) {
    const open = this.s.alerts.find((x) => x.key === a.key && x.resolvedAt === null);
    if (open) return copy(open);
    const row: AlertRow = { ...copy(a), detail: J(a.detail), id: ++this.s.seq.alert, resolvedAt: null };
    this.s.alerts.push(row);
    return copy(row);
  }
  async resolveAlert(key: string, at: Date) { for (const a of this.s.alerts) if (a.key === key && a.resolvedAt === null) a.resolvedAt = at; }
  async alerts(q: { offerId?: string; open?: boolean }) {
    return this.s.alerts.filter((a) => (!q.offerId || a.offerId === q.offerId) && (q.open === undefined || (a.resolvedAt === null) === q.open)).map(copy);
  }
  async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    const before = structuredClone(this.s);
    try { return await fn(); } catch (e) { Object.assign(this.s, before); throw e; }
  }
  async lockKey() { /* one transaction at a time already */ }
  async schedule(job: Job) { this.s.jobs.push(copy(job)); }
}
