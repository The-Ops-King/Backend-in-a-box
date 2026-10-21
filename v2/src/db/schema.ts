import { sql } from "drizzle-orm";
import {
  type AnyPgColumn, bigint, bigserial, boolean, check, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid,
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
  /** The connection whose door it came through (a per-connection door), and the offer it belongs to once known. */
  connectionId: uuid("connection_id"),
  offerId: uuid("offer_id"),
  /** Set when the normalizer has read it: what came of it (facts recorded, ignored, an unknown location, ...). */
  processedAt: timestamp("processed_at", { withTimezone: true }),
  outcome: text("outcome"),
}, (t) => [uniqueIndex("inbox_source_delivery").on(t.source, t.deliveryId), index("inbox_unprocessed").on(t.source, t.processedAt)]);

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

/**
 * An offer's report and metric definitions, as data (src/reports/): a metric is a small query over the projections, a
 * report the sections of metrics and the words a report@1 step renders. Never SQL.
 */
export const reportDefinitions = pgTable("report_definitions", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  kind: text("kind").notNull(),
  key: text("key").notNull(),
  definition: jsonb("definition").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.offerId, t.kind, t.key] }), check("report_definitions_kind", sql`${t.kind} in ('report', 'metric')`)]);

/**
 * An offer's connection on a port: which provider serves it (GHL, Whop, Fathom, ...), how (`mode`: oauth or pit for GHL,
 * webhook or polling for Calendly), whether it may be used now, and its credentials, sealed. One provider per port per
 * offer; a port may also be named by one verb ("ai.classify") when two providers share a port. A row with no provider is
 * only the engine's pause of a port (the platform's own Slack app). An auth failure pauses it until a person fixes it;
 * a needs_reinstall or uninstalled connection holds everything through it the same way.
 * `id` names it in its inbound door, /in/{id}. `external_id` is the vendor's account it is (a GHL location, a Calendly
 * organization). `config` holds what is not secret (a generic door's field map, Calendly's free-plan flag, polling).
 */
export const connections = pgTable("connections", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  port: text("port").notNull(),
  status: text("status").notNull().default("connected"),
  reason: text("reason"),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  id: uuid("id").notNull().defaultRandom().unique(),
  provider: text("provider"),
  mode: text("mode"),
  externalId: text("external_id"),
  credentialsEnc: text("credentials_enc"),
  config: jsonb("config").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.offerId, t.port] }),
  index("connections_provider_external").on(t.provider, t.externalId),
  check("connections_status", sql`${t.status} in ('connected', 'paused', 'needs_reinstall', 'uninstalled')`),
]);

/**
 * An offer's field map: each canonical field a workflow names ("lead_source") and the provider's own field it is
 * (a GHL custom field id), per object (contact, opportunity, a custom object's key; "calendar" maps a call type to a
 * calendar id). `value_type` says how a value is written (a GHL DATE field takes YYYY-MM-DD). Workflows never name a
 * provider field id.
 */
export const fieldMaps = pgTable("field_maps", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  provider: text("provider").notNull(),
  object: text("object").notNull().default("contact"),
  canonicalField: text("canonical_field").notNull(),
  providerFieldId: text("provider_field_id").notNull(),
  valueType: text("value_type").notNull().default("text"),
  options: jsonb("options").notNull().default({}),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.offerId, t.provider, t.object, t.canonicalField] }),
  uniqueIndex("field_maps_provider_field").on(t.offerId, t.provider, t.object, t.providerFieldId),
  check("field_maps_value_type", sql`${t.valueType} in ('text', 'date', 'datetime', 'number', 'money', 'options', 'checkbox', 'id')`),
]);

/**
 * What a write of ours is expected to change at the vendor, recorded before the write is made: the webhook that echoes
 * it back inside the window is tagged `by: platform`, so a change the platform made is never mistaken for a person's.
 */
export const connectorEchoes = pgTable("connector_echoes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  provider: text("provider").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  change: jsonb("change").notNull(),
  outboxKey: text("outbox_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  matchedAt: timestamp("matched_at", { withTimezone: true }),
}, (t) => [index("connector_echoes_entity").on(t.offerId, t.provider, t.entity, t.entityId)]);

/**
 * The last state a connector saw of a vendor's entity (a contact's tags and DND, an appointment's start and status, a
 * card's stage), and the vendor's time for it: a later delivery is compared with it (an update older than it is stale
 * and dropped), and a poll or the reconcile diffs against it. Also each poll's cursor (kind "cursor").
 */
export const entityVersions = pgTable("entity_versions", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  provider: text("provider").notNull(),
  kind: text("kind").notNull(),
  entityId: text("entity_id").notNull(),
  versionAt: timestamp("version_at", { withTimezone: true }),
  state: jsonb("state").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.offerId, t.provider, t.kind, t.entityId] })]);

/**
 * An agreement the platform sent and is waiting on (GHL has no "signed" webhook). Its location is checked every 10 s
 * for the first hour after sending, then every 5 minutes, up to 30 days; checking stops when it is signed or voided.
 */
export const agreementChecks = pgTable("agreement_checks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  connectionId: uuid("connection_id").notNull(),
  locationId: text("location_id").notNull(),
  agreementId: text("agreement_id").notNull(),
  contactId: text("contact_id"),
  name: text("name"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastStatus: text("last_status"),
  checks: integer("checks").notNull().default(0),
  status: text("status").notNull().default("waiting"),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("agreement_checks_agreement").on(t.offerId, t.agreementId),
  index("agreement_checks_due").on(t.locationId, t.status, t.nextCheckAt),
  check("agreement_checks_status", sql`${t.status} in ('waiting', 'signed', 'voided', 'expired')`),
]);

/** A call recording whose transcript is not ready yet: fetched again 1, 3 and 10 minutes after, then given up on and flagged. */
export const transcriptWaits = pgTable("transcript_waits", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  connectionId: uuid("connection_id").notNull(),
  provider: text("provider").notNull(),
  recordingId: text("recording_id").notNull(),
  tries: integer("tries").notNull().default(0),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("waiting"),
  fact: jsonb("fact").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("transcript_waits_recording").on(t.offerId, t.provider, t.recordingId),
  check("transcript_waits_status", sql`${t.status} in ('waiting', 'ready', 'gave_up')`),
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

/*
 * Projections: rebuildable tables, written only by the projectors from the fact log (src/projections/). Drop them and
 * rebuild from `events` and they come out the same. Each row belongs to an offer and is keyed (offer_id, id).
 */

/** Who a contact is, for matching and routing: CRM id, normalized phones and emails, merged-into, and the CRM's last-said attributes. */
export const contactsIndex = pgTable("contacts_index", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  id: text("id").notNull(),
  crmId: text("crm_id"),
  phones: text("phones").array().notNull().default(sql`'{}'::text[]`),
  emails: text("emails").array().notNull().default(sql`'{}'::text[]`),
  mergedInto: text("merged_into"),
  /** What the CRM last said about them with a fact (name, timezone, tags, fields, source, owner): a short cache, never a derived fact. */
  attrs: jsonb("attrs").notNull().default({}),
  /** The CRM records we wrote for them, by object: { key, id }. */
  records: jsonb("records").notNull().default({}),
  /** Their latest agreement: { id, name, status, sent_at, signed_at }. */
  agreement: jsonb("agreement"),
  leadAt: timestamp("lead_at", { withTimezone: true }),
  firstDialAt: timestamp("first_dial_at", { withTimezone: true }),
  speedToLeadMin: integer("speed_to_lead_min"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.offerId, t.id] }), index("contacts_index_crm").on(t.offerId, t.crmId)]);

/** Every booking: its time, status, how it was booked and by whom, and how it went. */
export const appointments = pgTable("appointments", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  id: text("id").notNull(),
  contactId: text("contact_id"),
  status: text("status"),
  kind: text("kind"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  bookedAt: timestamp("booked_at", { withTimezone: true }),
  bookingSource: text("booking_source"),
  setBy: text("set_by"),
  closerKey: text("closer_key"),
  reschedules: integer("reschedules").notNull().default(0),
  outcome: text("outcome"),
  callOutcome: text("call_outcome"),
  outcomeSource: text("outcome_source"),
  outcomeAt: timestamp("outcome_at", { withTimezone: true }),
  pendingRead: jsonb("pending_read"),
  /** What the booking source said about it (term, closer, links, tracking, answers). */
  attrs: jsonb("attrs").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.offerId, t.id] }), index("appointments_contact").on(t.offerId, t.contactId), index("appointments_starts").on(t.offerId, t.startsAt)]);

/** The single call fact: a booked call, a dialer call or a meeting recording; held, outcome, rep, recording, kind. */
export const calls = pgTable("calls", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  id: text("id").notNull(),
  contactId: text("contact_id"),
  appointmentId: text("appointment_id"),
  source: text("source").notNull(),
  kind: text("kind"),
  booked: boolean("booked").notNull().default(false),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  held: boolean("held"),
  outcome: text("outcome"),
  repKey: text("rep_key"),
  recordingId: text("recording_id"),
  recording: jsonb("recording"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSec: integer("duration_sec"),
  direction: text("direction"),
  connected: boolean("connected"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.offerId, t.id] }), index("calls_contact").on(t.offerId, t.contactId), index("calls_recording").on(t.offerId, t.recordingId)]);

/** Deals: the ledger's own (opened, won, lost) and the CRM cards we moved or saw moved. */
export const deals = pgTable("deals", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  id: text("id").notNull(),
  contactId: text("contact_id"),
  kind: text("kind").notNull(),
  pipeline: text("pipeline"),
  crmId: text("crm_id"),
  stage: text("stage"),
  status: text("status"),
  ownerKey: text("owner_key"),
  name: text("name"),
  value: numeric("value", { mode: "number" }),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  wonAt: timestamp("won_at", { withTimezone: true }),
  lostAt: timestamp("lost_at", { withTimezone: true }),
  seq: bigint("seq", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.offerId, t.id] }), index("deals_contact").on(t.offerId, t.contactId)]);

/** Every payment the provider reported, linked to a person or not. Its kind is worked out when read, from the offer's settings. */
export const payments = pgTable("payments", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  id: text("id").notNull(),
  contactId: text("contact_id"),
  dealId: text("deal_id"),
  providerPaymentId: text("provider_payment_id"),
  status: text("status").notNull(),
  amount: numeric("amount", { mode: "number" }).notNull(),
  currency: text("currency"),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
  product: jsonb("product").notNull().default({}),
  refundOf: text("refund_of"),
  customer: jsonb("customer").notNull().default({}),
  linkedBy: text("linked_by"),
  seq: bigint("seq", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.offerId, t.id] }), index("payments_contact").on(t.offerId, t.contactId), index("payments_paid").on(t.offerId, t.paidAt)]);

/** The team, minimal: who they are, their identities, their roles, the days they filed. */
export const people = pgTable("people", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  id: text("id").notNull(),
  name: text("name"),
  email: text("email"),
  slackUserId: text("slack_user_id"),
  crmUserId: text("crm_user_id"),
  roles: text("roles").array().notNull().default(sql`'{}'::text[]`),
  active: boolean("active").notNull().default(true),
  eodDays: text("eod_days").array().notNull().default(sql`'{}'::text[]`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.offerId, t.id] }), index("people_crm").on(t.offerId, t.crmUserId)]);

/** Counts and sums of what happened on each day of the offer's clock, by closer, setter and source. */
export const dailyFacts = pgTable("daily_facts", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  id: text("id").notNull(),
  day: text("day").notNull(),
  metric: text("metric").notNull(),
  closer: text("closer").notNull(),
  setter: text("setter").notNull(),
  source: text("source").notNull(),
  n: integer("n").notNull(),
  amount: numeric("amount", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.offerId, t.id] }), index("daily_facts_day").on(t.offerId, t.metric, t.day)]);

/** A schedule trigger's next time: the job runner fires it then (once per period per subject) and sets the next. */
export const scheduleTimers = pgTable("schedule_timers", {
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
  node: text("node").notNull(),
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
  lastPeriod: text("last_period"),
}, (t) => [primaryKey({ columns: [t.workflowId, t.node] }), index("schedule_timers_due").on(t.nextAt)]);

/*
 * The platform Slack app (src/slack/). One app, installed per workspace by OAuth; each channel belongs to one offer.
 * How Slack behaves is the platform's; where an offer posts and what it says stays in the offer's settings and content.
 */

/** A Slack workspace the app is installed in, with its bot token sealed. One row per workspace, however many offers use it. */
export const slackWorkspaces = pgTable("slack_workspaces", {
  teamId: text("team_id").primaryKey(),
  teamName: text("team_name"),
  appId: text("app_id"),
  botUserId: text("bot_user_id").notNull(),
  botTokenEnc: text("bot_token_enc").notNull(),
  /** Token rotation: the sealed refresh token and when the bot token expires (null: it does not expire). */
  refreshTokenEnc: text("refresh_token_enc"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  scopes: text("scopes").notNull(),
  installedBy: text("installed_by"),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull(),
  /** Set by app_uninstalled or tokens_revoked: every Slack post for its offers is held until it is installed again. */
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/** Which workspace an offer's Slack is: an install links the offer; installing the same workspace for another offer only adds a link. */
export const slackOfferLinks = pgTable("slack_offer_links", {
  offerId: uuid("offer_id").primaryKey().references(() => offers.id),
  teamId: text("team_id").notNull().references(() => slackWorkspaces.teamId),
  linkedBy: text("linked_by"),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull(),
}, (t) => [index("slack_offer_links_team").on(t.teamId)]);

/** A channel and the one offer it belongs to (the primary key keeps it to one), with the slots it fills for that offer. */
export const slackChannels = pgTable("slack_channels", {
  teamId: text("team_id").notNull().references(() => slackWorkspaces.teamId),
  channelId: text("channel_id").notNull(),
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  slots: text("slots").array().notNull().default(sql`'{}'::text[]`),
  name: text("name"),
  isPrivate: boolean("is_private").notNull().default(false),
  botMember: boolean("bot_member").notNull().default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.teamId, t.channelId] }), index("slack_channels_offer").on(t.offerId)]);

/** A person's account elsewhere, confirmed by a person (never guessed): their Slack user in a workspace. */
export const personIdentities = pgTable("person_identities", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  personId: text("person_id").notNull(),
  kind: text("kind").notNull(),
  teamId: text("team_id").notNull(),
  userId: text("user_id").notNull(),
  confirmedBy: text("confirmed_by"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.offerId, t.kind, t.teamId, t.userId] }),
  uniqueIndex("person_identities_person").on(t.offerId, t.personId, t.kind, t.teamId),
  index("person_identities_user").on(t.kind, t.teamId, t.userId),
  check("person_identities_kind", sql`${t.kind} in ('slack')`),
]);

/**
 * Every message the platform's Slack app posted: a workflow's (with its run and step), an alert's, the bot's. Later
 * steps and presses find a post here; `app` is the app that posted it, which answers for it until it closes; `settled`
 * is the press that answered it (who, what, when), after which its buttons are gone.
 */
export const slackMessages = pgTable("slack_messages", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  offerId: uuid("offer_id").references(() => offers.id),
  teamId: text("team_id").notNull(),
  channel: text("channel").notNull(),
  ts: text("ts").notNull(),
  threadTs: text("thread_ts"),
  kind: text("kind").notNull(),
  workflowId: uuid("workflow_id"),
  runId: uuid("run_id"),
  node: text("node"),
  tag: text("tag"),
  outboxId: bigint("outbox_id", { mode: "number" }),
  alertId: bigint("alert_id", { mode: "number" }),
  app: text("app").notNull().default("platform"),
  sandbox: boolean("sandbox").notNull().default(false),
  settled: jsonb("settled"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("slack_messages_ts").on(t.teamId, t.channel, t.ts),
  index("slack_messages_run").on(t.runId, t.node),
  index("slack_messages_tag").on(t.offerId, t.tag),
  check("slack_messages_kind", sql`${t.kind} in ('workflow', 'alert', 'bot', 'command', 'support')`),
]);

/**
 * What the platform's Slack app says that no run asked for (an alert's post, its thread replies and ✅, the bot's
 * answers, a press's edit of the message it answered): written first, delivered after, tried three times, then an
 * alert; held while the workspace is revoked. A run's posts go through the engine's outbox instead.
 */
export const slackOutbox = pgTable("slack_outbox", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  offerId: uuid("offer_id").references(() => offers.id),
  teamId: text("team_id"),
  kind: text("kind").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  alertId: bigint("alert_id", { mode: "number" }),
  lastError: text("last_error"),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (t) => [
  index("slack_outbox_due").on(t.status, t.nextAttemptAt),
  check("slack_outbox_kind", sql`${t.kind} in ('post', 'update', 'react', 'respond', 'ephemeral')`),
  check("slack_outbox_status", sql`${t.status} in ('queued', 'sending', 'sent', 'failed', 'unknown')`),
]);

/** How each alert has been said in Slack: where its post is, when it was last said, paused, and whether its resolve was said. */
export const slackAlertState = pgTable("slack_alert_state", {
  alertId: bigint("alert_id", { mode: "number" }).primaryKey().references(() => alerts.id),
  teamId: text("team_id"),
  channel: text("channel"),
  ts: text("ts"),
  saidCount: integer("said_count").notNull().default(0),
  lastSaidAt: timestamp("last_said_at", { withTimezone: true }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  pausedBy: text("paused_by"),
  resolvedSaidAt: timestamp("resolved_said_at", { withTimezone: true }),
  /** Checked again and found to be something only a person can tell: kept open, never repeated. */
  quiet: boolean("quiet").notNull().default(false),
});

/** Settings that are the platform's, the same for every offer (alert repeats, the operator's channel, the bot's model). */
export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The bot's tokens spent per offer per day (the offer's clock), for its daily budget. */
export const slackBotUsage = pgTable("slack_bot_usage", {
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  day: text("day").notNull(),
  tokens: integer("tokens").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.offerId, t.day] })]);

/** What people did in Slack and what was refused them: presses, refusals, the bot's read-only queries. Never message text. */
export const slackAudit = pgTable("slack_audit", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  offerId: uuid("offer_id"),
  teamId: text("team_id"),
  userId: text("user_id"),
  action: text("action").notNull(),
  detail: jsonb("detail").notNull().default({}),
  at: timestamp("at", { withTimezone: true }).notNull(),
}, (t) => [index("slack_audit_offer").on(t.offerId, t.at)]);
