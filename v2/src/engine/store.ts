import type {
  AlertRow, ConnectionRow, ContentRow, EventRow, Job, NewEvent, NewOutbox, NewRun, OfferRow, OutboxRow, OutboxStatus, PostRow,
  RunRow, RunStatus, StepRow, VersionRow, WorkflowRow,
} from "./types";

/**
 * Everything the engine reads and writes, inside one transaction. Two stores implement it: Postgres (the real one) and
 * memory (the simulator's). The store holds no behavior: every decision is the engine's, so both stores run the
 * same interpreter and the same gate.
 */

export type EventQuery = {
  offerId: string;
  types?: string[];
  contactId?: string;
  appointmentId?: string;
  dealId?: string;
  /** occurred_at at or after. */
  since?: Date;
  /** occurred_at at or before. */
  until?: Date;
  /** payload.tag, payload.run_id, payload.node: an answer's tag, or the run and node that asked. */
  tag?: string;
  runId?: string;
  node?: string;
  order?: "asc" | "desc";
  limit?: number;
};

export type RunQuery = {
  offerId?: string;
  workflowId?: string;
  statuses?: RunStatus[];
  /** Runs about any of these subjects. */
  about?: { contactId?: string | null; appointmentId?: string | null; dealId?: string | null };
  reentryBase?: string;
  startedSince?: Date;
  /** next_wake_at at or before. */
  dueBy?: Date;
  /** Waiting on the answer to a post remembered under this tag. */
  waitingOnTag?: string;
  limit?: number;
};

export type OutboxQuery = { offerId?: string; runId?: string; contactId?: string; kinds?: string[]; statuses?: OutboxStatus[]; dueBy?: Date; limit?: number };

/** Messages to contacts (and their attempts) that count toward the cap and the breaker. */
export type SendCount = { offerId: string; contactId?: string; since: Date; until?: Date; kinds: string[] };

export type PostQuery = { offerId: string; runId?: string; node?: string; tag?: string; outboxId?: number; channel?: string; ts?: string };

export interface Tx {
  offer(id: string): Promise<OfferRow | undefined>;
  insertOffer(o: Omit<OfferRow, "id" | "sendsPausedAt" | "sendsPausedReason"> & { id?: string }): Promise<OfferRow>;
  updateOffer(id: string, patch: Partial<Pick<OfferRow, "sendsPausedAt" | "sendsPausedReason" | "zone" | "name">>): Promise<void>;
  settings(offerId: string): Promise<Record<string, unknown>>;
  setSetting(offerId: string, key: string, value: unknown, by: string): Promise<void>;
  content(offerId: string, key: string): Promise<ContentRow | undefined>;
  contentKeys(offerId: string): Promise<string[]>;
  setContent(row: ContentRow): Promise<void>;
  workflow(id: string): Promise<WorkflowRow | undefined>;
  workflowByKey(offerId: string, key: string): Promise<WorkflowRow | undefined>;
  workflows(offerId: string): Promise<WorkflowRow[]>;
  insertWorkflow(w: Pick<WorkflowRow, "offerId" | "key" | "name">): Promise<WorkflowRow>;
  updateWorkflow(id: string, patch: Partial<Omit<WorkflowRow, "id" | "offerId" | "key">>): Promise<void>;
  version(id: string): Promise<VersionRow | undefined>;
  latestVersion(workflowId: string): Promise<VersionRow | undefined>;
  insertVersion(v: Omit<VersionRow, "id">): Promise<VersionRow>;
  operatorAddresses(): Promise<{ emails: string[]; phones: string[] }>;
  addOperatorAddress(kind: "email" | "phone", value: string): Promise<void>;
  connection(offerId: string, port: string): Promise<ConnectionRow | undefined>;
  setConnection(row: ConnectionRow): Promise<void>;

  /** Appends a fact; one already recorded under the same dedupe key is returned as it is, `inserted: false`. */
  appendEvent(e: NewEvent): Promise<{ event: EventRow; inserted: boolean }>;
  event(id: number): Promise<EventRow | undefined>;
  events(q: EventQuery): Promise<EventRow[]>;

  /** Starts a run; undefined when the workflow already has a run with that reentry key. */
  insertRun(r: NewRun): Promise<RunRow | undefined>;
  /** `lock`: hold the row for this transaction (for update), or skip it (undefined) if another transaction holds it. */
  run(id: string, lock?: "wait" | "skip"): Promise<RunRow | undefined>;
  updateRun(id: string, patch: Partial<Omit<RunRow, "id" | "offerId" | "workflowId" | "versionId">>): Promise<void>;
  runs(q: RunQuery): Promise<RunRow[]>;

  insertStep(s: Omit<StepRow, "id">): Promise<StepRow>;
  step(id: number): Promise<StepRow | undefined>;
  updateStep(id: number, patch: Partial<Pick<StepRow, "status" | "finishedAt" | "result" | "error">>): Promise<void>;
  steps(runId: string): Promise<StepRow[]>;

  /** Writes an effect; a row with the same idempotency key already there is returned instead, unchanged. */
  insertOutbox(o: NewOutbox): Promise<OutboxRow>;
  outboxRow(id: number, lock?: "wait" | "skip"): Promise<OutboxRow | undefined>;
  updateOutbox(id: number, patch: Partial<Omit<OutboxRow, "id" | "offerId" | "runId" | "stepId" | "idempotencyKey">>): Promise<void>;
  outboxRows(q: OutboxQuery): Promise<OutboxRow[]>;
  /** Contact messages being sent, sent, or of unknown fate, attempted in [since, until). */
  countSends(q: SendCount): Promise<number>;

  insertPost(p: Omit<PostRow, "id">): Promise<PostRow>;
  /** A post said again in place (edited): it now belongs to the row, run and step that said it last, under its tag. */
  updatePost(id: number, patch: Partial<Pick<PostRow, "outboxId" | "runId" | "node" | "tag">>): Promise<void>;
  posts(q: PostQuery): Promise<PostRow[]>;

  /** Opens an alert unless one with the same key is already open. */
  raiseAlert(a: Omit<AlertRow, "id" | "resolvedAt">): Promise<AlertRow>;
  resolveAlert(key: string, at: Date): Promise<void>;
  alerts(q: { offerId?: string; open?: boolean }): Promise<AlertRow[]>;

  /** Runs `fn` so that, if it throws, only what it wrote is undone and the transaction goes on (a savepoint). */
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
  /** Holds a lock named by `key` until the transaction ends (one contact's cap count at a time). */
  lockKey(key: string): Promise<void>;
  /** A job, due at its time, written in this transaction: a run to wake, an outbox row to deliver. */
  schedule(job: Job): Promise<void>;
}

export interface Store {
  /** Runs `fn` in one transaction: all of it lands, or none of it. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
