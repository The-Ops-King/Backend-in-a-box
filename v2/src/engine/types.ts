import type { Effect } from "@/workflow/primitives/spec";
import type { TimeRule } from "@/workflow/primitives/common";
import type { Predicate } from "@/workflow/predicate";

/** Rows as the engine reads and writes them, the same whichever store holds them (Postgres, or memory in the simulator). */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type OfferRow = { id: string; slug: string; name: string; zone: string; sendsPausedAt: Date | null; sendsPausedReason: string | null };

export type Delivery = "sandbox" | "live";
export type CrmWrites = "dry" | "real";

export type WorkflowRow = {
  id: string; offerId: string; key: string; name: string; enabled: boolean; currentVersionId: string | null;
  delivery: Delivery; deliverySetBy: string | null; deliverySetAt: Date | null; deliveryNote: string | null;
  crmWrites: CrmWrites; crmWritesSetBy: string | null; crmWritesSetAt: Date | null;
};

export type VersionRow = { id: string; offerId: string; workflowId: string; version: number; definition: unknown; createdBy: string; reason: string; createdAt: Date };

export type ContentRow = { offerId: string; key: string; channel: string; body: string; subject: string | null; extras: { as?: string; icons?: string[]; labels?: Record<string, string> } | null; approvedHash: string | null };

export type EventRow = {
  id: number; offerId: string; type: string; occurredAt: Date; contactId: string | null; appointmentId: string | null; dealId: string | null;
  source: string; dedupeKey: string; payload: Record<string, unknown>; runId: string | null;
};
export type NewEvent = Omit<EventRow, "id">;

export type RunStatus = "active" | "waiting" | "paused" | "completed" | "ended" | "failed";

/**
 * What a parked run is waiting on, stored as data. `node` is the node it is parked at. Deadlines are pinned when the
 * wait starts; a time wait's `rule` is recomputed each time it is looked at, so a moved call moves its reminders.
 */
/** `since` with `strict`: only what happened after the step began; without it, at or after `since` (a time the step named). */
export type Wake = { node: string; step: number } & (
  | { kind: "time"; at: string; reached: string; rule?: TimeRule }
  | { kind: "window"; at: string }
  | { kind: "event"; type: string; about: "contact" | "appointment"; subject: string | null; match?: Predicate; since: string; strict?: boolean; deadline?: string }
  | { kind: "reply"; channel: "sms" | "email" | "any"; since: string; strict?: boolean; settleMs?: number; deadline?: string }
  | { kind: "answer"; ask?: string; tag?: string; since: string; strict?: boolean; deadline?: string }
  | { kind: "check"; everyMs: number; deadline: string }
  | { kind: "person"; reason: string }
  | { kind: "effect"; outboxId: number; then?: "ask" }
  | { kind: "hold"; why: string }
  | { kind: "paused_by_run"; by: string; prior: Wake | null; priorAt: string | null; priorStatus: RunStatus }
);
export type WakeKind = Wake["kind"];

export type Listener = { node: string; deadline?: string };
export type PendingTrigger = { eventId: number; triggerNode: string };

/** What a run carries: the event that started it, what steps computed, and how often it reached each node. */
export type RunContext = {
  event: Record<string, unknown>;
  /** Subject snapshots from the starting event that have no id of their own to be re-read by (payment, recording, ...). */
  subjects: Record<string, unknown>;
  vars: Record<string, unknown>;
  reply?: Record<string, unknown>;
  visits: Record<string, number>;
  /**
   * Whether the run has done anything yet: written an effect, recorded a fact, started or paused a run. A run that
   * ends without having done anything (it only decided, or waited) releases its reentry key.
   */
  acted: boolean;
};

export type RunRow = {
  id: string; offerId: string; workflowId: string; versionId: string; triggerNode: string; status: RunStatus; currentNode: string;
  context: RunContext; contactId: string | null; appointmentId: string | null; dealId: string | null;
  reentryKey: string; reentryBase: string; nextWakeAt: Date | null; wake: Wake | null; listeners: Listener[];
  resume: { node: string; wake: Wake | null; at: string | null } | null; pendingTriggers: PendingTrigger[];
  endReason: string | null; leaseOwner: string | null; leaseUntil: Date | null; startedAt: Date; updatedAt: Date; finishedAt: Date | null;
};
export type NewRun = Omit<RunRow, "id" | "leaseOwner" | "leaseUntil" | "finishedAt" | "endReason">;

export type StepStatus = "waiting" | "ok" | "skipped" | "failed" | "held";
export type StepRow = {
  id: number; offerId: string; runId: string; node: string; primitive: string; visit: number; status: StepStatus;
  startedAt: Date; finishedAt: Date | null; result: Record<string, unknown>; error: string | null;
};

export type OutboxStatus = "queued" | "sending" | "held" | "sent" | "failed" | "unknown" | "suppressed";
export type GateCheck = "channel" | "delivery" | "crm_writes" | "dnd" | "window" | "cap" | "breaker" | "blank";
export type GateDecision = { check: GateCheck; result: "pass" | "reroute" | "suppress" | "hold" | "defer" | "not_applicable"; why: string; at: string };

export type OutboxRow = {
  id: number; offerId: string; runId: string; stepId: number; node: string; kind: string; effect: Exclude<Effect, "internal">;
  idempotencyKey: string; payload: Record<string, unknown>; status: OutboxStatus; gates: GateDecision[]; attempts: number;
  nextAttemptAt: Date | null; leaseOwner: string | null; leaseUntil: Date | null; contactId: string | null;
  errorClass: string | null; lastError: string | null; result: unknown; createdAt: Date; sentAt: Date | null; settledAt: Date | null;
};
export type NewOutbox = Pick<OutboxRow, "offerId" | "runId" | "stepId" | "node" | "kind" | "effect" | "idempotencyKey" | "payload" | "contactId" | "createdAt" | "nextAttemptAt">;

export type PostRow = { id: number; offerId: string; outboxId: number; runId: string; node: string; tag: string | null; channel: string; ts: string; sandbox: boolean; createdAt: Date };

export type AlertRow = { id: number; offerId: string | null; key: string; kind: string; message: string; detail: Record<string, unknown>; runId: string | null; outboxId: number | null; openedAt: Date; resolvedAt: Date | null };

export type ConnectionRow = { offerId: string; port: string; status: "ok" | "paused_auth"; reason: string | null; pausedAt: Date | null };

/** A schedule trigger's next time, and the last period it ran for. */
export type ScheduleTimer = { workflowId: string; node: string; offerId: string; nextAt: Date; lastPeriod: string | null };

/** A due job: wake a run, deliver an outbox row, fire a schedule trigger. Timers are jobs with an exact time. */
export type Job = { kind: "run"; id: string; at: Date } | { kind: "outbox"; id: number; at: Date } | { kind: "schedule"; workflowId: string; node: string; at: Date };
