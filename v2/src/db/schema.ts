import { sql } from "drizzle-orm";
import {
  type AnyPgColumn, bigint, bigserial, boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

/**
 * Every inbound delivery, exactly as it arrived, before anything reads it. A vendor's retry of the same delivery is the same
 * row (source + delivery_id), so nothing downstream ever sees it twice.
 */
export const inbox = pgTable("inbox", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  source: text("source").notNull(),                       // the door it came through: "ghl", later "whop", "slack", ...
  deliveryId: text("delivery_id").notNull(),              // the vendor's own id for the delivery, else a hash of the body
  eventType: text("event_type"),                          // the vendor's name for it, as sent ("ContactCreate")
  locationId: text("location_id"),                        // GHL: the sub-account it is about
  headers: jsonb("headers").notNull(),
  body: text("body").notNull(),                           // raw, byte for byte, so the signature can be checked again
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("inbox_source_delivery").on(t.source, t.deliveryId)]);

/** A GHL sub-account the app is installed on, with its tokens encrypted. One row per location. */
export const ghlConnections = pgTable("ghl_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  locationId: text("location_id").notNull().unique(),
  companyId: text("company_id"),
  installedBy: text("installed_by"),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scopes: text("scopes").notNull(),
  status: text("status").notNull().default("connected"),  // connected | needs_reinstall | uninstalled
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  needsReview: boolean("needs_review").notNull().default(true),   // no offer yet: Tyler links it; a location never becomes an offer by itself
});

/*
 * The engine's tables. Four kinds of data, never mixed: configuration (offers, workflows, workflow_versions, settings,
 * content, connections, operator_addresses), facts (events, append-only), and execution (runs, run_steps, outbox,
 * slack_posts, alerts). Every row that belongs to an offer carries offer_id.
 */

/** One offer: the tenant. A client with two offers is two offers. */
export const offers = pgTable("offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** The offer's own clock: team-facing dates, and contact dates when the contact has no zone. */
  zone: text("zone").notNull(),
  /** Set when the circuit breaker trips: every message to a contact is held until an operator clears it. */
  sendsPausedAt: timestamp("sends_paused_at", { withTimezone: true }),
  sendsPausedReason: text("sends_paused_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One of an offer's workflows. Its definition lives in workflow_versions; `current_version_id` is what new runs pin.
 * `delivery` and `crm_writes` sit beside the definition, never in it: every workflow starts sandbox and dry.
 */
export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  currentVersionId: uuid("current_version_id").references((): AnyPgColumn => workflowVersions.id),
  delivery: text("delivery").notNull().default("sandbox"),
  deliverySetBy: text("delivery_set_by"),
  deliverySetAt: timestamp("delivery_set_at", { withTimezone: true }),
  deliveryNote: text("delivery_note"),
  crmWrites: text("crm_writes").notNull().default("dry"),
  crmWritesSetBy: text("crm_writes_set_by"),
  crmWritesSetAt: timestamp("crm_writes_set_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("workflows_offer_key").on(t.offerId, t.key),
  check("workflows_delivery", sql`${t.delivery} in ('sandbox', 'live')`),
  check("workflows_crm_writes", sql`${t.crmWrites} in ('dry', 'real')`),
]);

/** Every saved definition, never changed once written (a trigger refuses updates and deletes). Runs pin one. */
export const workflowVersions = pgTable("workflow_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
  version: integer("version").notNull(),
  definition: jsonb("definition").notNull(),
  createdBy: text("created_by").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("workflow_versions_workflow_version").on(t.workflowId, t.version)]);

/** Typed values per offer, by key ("slack.channel.payments", "delivery.cap_per_day"). No value is ever filled from code. */
export const settings = pgTable("settings", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.offerId, t.key] })]);

/** The words, by key. A message names a key; the body is a template. `approved_hash` is the hash of the words approved. */
export const content = pgTable("content", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  key: text("key").notNull(),
  channel: text("channel").notNull(),
  body: text("body").notNull(),
  subject: text("subject"),
  /** Slack persona (`as`) and button labels by value or action: { as, labels: { keep: "Keep it" } }. */
  extras: jsonb("extras"),
  approvedHash: text("approved_hash"),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.offerId, t.key] }),
  check("content_channel", sql`${t.channel} in ('sms', 'email', 'slack', 'prompt', 'crm')`),
]);

/** Whether an offer's connection on a port may be used: an auth failure pauses it until a person fixes the token. */
export const connections = pgTable("connections", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  port: text("port").notNull(),
  status: text("status").notNull().default("ok"),
  reason: text("reason"),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.offerId, t.port] }),
  check("connections_status", sql`${t.status} in ('ok', 'paused_auth')`),
]);

/** The operator's own phones and emails: in sandbox, the only addresses a message to a contact may reach. Platform-wide. */
export const operatorAddresses = pgTable("operator_addresses", {
  kind: text("kind").notNull(),
  value: text("value").notNull(),
}, (t) => [primaryKey({ columns: [t.kind, t.value] }), check("operator_addresses_kind", sql`${t.kind} in ('email', 'phone')`)]);

/**
 * The fact log: what happened, append-only (a trigger refuses updates and deletes). `dedupe_key` makes a fact that
 * arrives twice one row. Subject refs say who it is about; `payload` holds the canonical event.
 */
export const events = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  type: text("type").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  contactId: text("contact_id"),
  appointmentId: text("appointment_id"),
  dealId: text("deal_id"),
  source: text("source").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  payload: jsonb("payload").notNull(),
  /** The run that recorded it, for facts a workflow step wrote. */
  runId: uuid("run_id"),
}, (t) => [
  uniqueIndex("events_offer_dedupe").on(t.offerId, t.dedupeKey),
  index("events_offer_type").on(t.offerId, t.type, t.occurredAt),
  index("events_offer_contact").on(t.offerId, t.contactId),
  index("events_offer_appointment").on(t.offerId, t.appointmentId),
  index("events_offer_deal").on(t.offerId, t.dealId),
]);

/**
 * One trip of one subject through one workflow version. `reentry_key` is unique per workflow: it is what stops a second
 * run for the same subject. A run that is waiting has its wake stored as data (`wake`, `next_wake_at`).
 */
export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
  versionId: uuid("version_id").notNull().references(() => workflowVersions.id),
  triggerNode: text("trigger_node").notNull(),
  status: text("status").notNull(),
  currentNode: text("current_node").notNull(),
  context: jsonb("context").notNull(),
  contactId: text("contact_id"),
  appointmentId: text("appointment_id"),
  dealId: text("deal_id"),
  reentryKey: text("reentry_key").notNull(),
  /** The key before any refinement: a run in flight for the same base holds a refined key's subject. */
  reentryBase: text("reentry_base").notNull(),
  nextWakeAt: timestamp("next_wake_at", { withTimezone: true }),
  wake: jsonb("wake"),
  /** Asks this run listens to while it goes on: [{ node, deadline }]. */
  listeners: jsonb("listeners").notNull().default([]),
  /** Where "$resume" returns the run: the node a listener took it from, and its wake then. */
  resume: jsonb("resume"),
  /** Triggers refused while this run held the key; replayed if it releases the key. */
  pendingTriggers: jsonb("pending_triggers").notNull().default([]),
  endReason: text("end_reason"),
  leaseOwner: text("lease_owner"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("runs_workflow_reentry").on(t.workflowId, t.reentryKey),
  index("runs_due").on(t.status, t.nextWakeAt),
  index("runs_offer_contact").on(t.offerId, t.contactId),
  index("runs_offer_appointment").on(t.offerId, t.appointmentId),
  index("runs_workflow_base").on(t.workflowId, t.reentryBase),
  check("runs_status", sql`${t.status} in ('active', 'waiting', 'paused', 'completed', 'ended', 'failed')`),
]);

/** Every step a run took, one row per time it reached a node, with the primitive and version that ran it. */
export const runSteps = pgTable("run_steps", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  runId: uuid("run_id").notNull().references(() => runs.id),
  node: text("node").notNull(),
  primitive: text("primitive").notNull(),
  visit: integer("visit").notNull(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  result: jsonb("result").notNull().default({}),
  error: text("error"),
}, (t) => [
  unique("run_steps_id_run").on(t.id, t.runId),
  index("run_steps_run").on(t.runId),
  check("run_steps_status", sql`${t.status} in ('waiting', 'ok', 'skipped', 'failed', 'held')`),
]);

/**
 * Every effect on the outside world, written in the run's transaction and delivered by the dispatcher through the
 * delivery gate. The database refuses a row without the run and the step that asked for it (the step must belong to
 * that run). `idempotency_key` is written before the vendor is called; a row whose result is unknown is never re-sent.
 */
export const outbox = pgTable("outbox", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  runId: uuid("run_id").notNull().references(() => runs.id),
  stepId: bigint("step_id", { mode: "number" }).notNull(),
  node: text("node").notNull(),
  kind: text("kind").notNull(),
  effect: text("effect").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("queued"),
  gates: jsonb("gates").notNull().default([]),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  leaseOwner: text("lease_owner"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  contactId: text("contact_id"),
  errorClass: text("error_class"),
  lastError: text("last_error"),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (t) => [
  foreignKey({ columns: [t.stepId, t.runId], foreignColumns: [runSteps.id, runSteps.runId], name: "outbox_step_of_run" }),
  index("outbox_due").on(t.status, t.nextAttemptAt),
  index("outbox_offer_contact").on(t.offerId, t.contactId, t.sentAt),
  check("outbox_status", sql`${t.status} in ('queued', 'sending', 'held', 'sent', 'failed', 'unknown', 'suppressed')`),
  check("outbox_effect", sql`${t.effect} in ('contact', 'team', 'crm', 'external', 'read')`),
]);

/** Slack posts the platform made for a run's step, findable by the node that made them or the tag they were remembered under. */
export const slackPosts = pgTable("slack_posts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  outboxId: bigint("outbox_id", { mode: "number" }).notNull().references(() => outbox.id),
  runId: uuid("run_id").notNull().references(() => runs.id),
  node: text("node").notNull(),
  tag: text("tag"),
  channel: text("channel").notNull(),
  ts: text("ts").notNull(),
  sandbox: boolean("sandbox").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [index("slack_posts_tag").on(t.offerId, t.tag), index("slack_posts_run_node").on(t.runId, t.node), uniqueIndex("slack_posts_ts").on(t.offerId, t.channel, t.ts)]);

/** Things a person must look at: a held message, a tripped breaker, a paused connection. One open alert per key. */
export const alerts = pgTable("alerts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  offerId: uuid("offer_id").references(() => offers.id),
  key: text("key").notNull(),
  kind: text("kind").notNull(),
  message: text("message").notNull(),
  detail: jsonb("detail").notNull().default({}),
  runId: uuid("run_id"),
  outboxId: bigint("outbox_id", { mode: "number" }),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [uniqueIndex("alerts_open_key").on(t.key).where(sql`${t.resolvedAt} is null`)]);
