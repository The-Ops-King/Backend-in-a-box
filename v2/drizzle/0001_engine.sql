CREATE TABLE "alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"offer_id" uuid,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_id" uuid,
	"outbox_id" bigint,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"offer_id" uuid NOT NULL,
	"port" text NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"reason" text,
	"paused_at" timestamp with time zone,
	CONSTRAINT "connections_offer_id_port_pk" PRIMARY KEY("offer_id","port"),
	CONSTRAINT "connections_status" CHECK ("connections"."status" in ('ok', 'paused_auth'))
);
--> statement-breakpoint
CREATE TABLE "content" (
	"offer_id" uuid NOT NULL,
	"key" text NOT NULL,
	"channel" text NOT NULL,
	"body" text NOT NULL,
	"subject" text,
	"extras" jsonb,
	"approved_hash" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	CONSTRAINT "content_offer_id_key_pk" PRIMARY KEY("offer_id","key"),
	CONSTRAINT "content_channel" CHECK ("content"."channel" in ('sms', 'email', 'slack', 'prompt', 'crm'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"offer_id" uuid NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"contact_id" text,
	"appointment_id" text,
	"deal_id" text,
	"source" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"zone" text NOT NULL,
	"sends_paused_at" timestamp with time zone,
	"sends_paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "operator_addresses" (
	"kind" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "operator_addresses_kind_value_pk" PRIMARY KEY("kind","value"),
	CONSTRAINT "operator_addresses_kind" CHECK ("operator_addresses"."kind" in ('email', 'phone'))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"offer_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" bigint NOT NULL,
	"node" text NOT NULL,
	"kind" text NOT NULL,
	"effect" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"gates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"contact_id" text,
	"error_class" text,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "outbox_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "outbox_status" CHECK ("outbox"."status" in ('queued', 'sending', 'held', 'sent', 'failed', 'unknown', 'suppressed')),
	CONSTRAINT "outbox_effect" CHECK ("outbox"."effect" in ('contact', 'team', 'crm', 'external', 'read'))
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"offer_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"node" text NOT NULL,
	"primitive" text NOT NULL,
	"visit" integer NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "run_steps_id_run" UNIQUE("id","run_id"),
	CONSTRAINT "run_steps_status" CHECK ("run_steps"."status" in ('waiting', 'ok', 'skipped', 'failed', 'held'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"trigger_node" text NOT NULL,
	"status" text NOT NULL,
	"current_node" text NOT NULL,
	"context" jsonb NOT NULL,
	"contact_id" text,
	"appointment_id" text,
	"deal_id" text,
	"reentry_key" text NOT NULL,
	"reentry_base" text NOT NULL,
	"next_wake_at" timestamp with time zone,
	"wake" jsonb,
	"listeners" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resume" jsonb,
	"pending_triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"end_reason" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_status" CHECK ("runs"."status" in ('active', 'waiting', 'paused', 'completed', 'ended', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"offer_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_offer_id_key_pk" PRIMARY KEY("offer_id","key")
);
--> statement-breakpoint
CREATE TABLE "slack_posts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"offer_id" uuid NOT NULL,
	"outbox_id" bigint NOT NULL,
	"run_id" uuid NOT NULL,
	"node" text NOT NULL,
	"tag" text,
	"channel" text NOT NULL,
	"ts" text NOT NULL,
	"sandbox" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"current_version_id" uuid,
	"delivery" text DEFAULT 'sandbox' NOT NULL,
	"delivery_set_by" text,
	"delivery_set_at" timestamp with time zone,
	"delivery_note" text,
	"crm_writes" text DEFAULT 'dry' NOT NULL,
	"crm_writes_set_by" text,
	"crm_writes_set_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_delivery" CHECK ("workflows"."delivery" in ('sandbox', 'live')),
	CONSTRAINT "workflows_crm_writes" CHECK ("workflows"."crm_writes" in ('dry', 'real'))
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content" ADD CONSTRAINT "content_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_step_of_run" FOREIGN KEY ("step_id","run_id") REFERENCES "public"."run_steps"("id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_version_id_workflow_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_posts" ADD CONSTRAINT "slack_posts_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_posts" ADD CONSTRAINT "slack_posts_outbox_id_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_posts" ADD CONSTRAINT "slack_posts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_current_version_id_workflow_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_key" ON "alerts" USING btree ("key") WHERE "alerts"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "events_offer_dedupe" ON "events" USING btree ("offer_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "events_offer_type" ON "events" USING btree ("offer_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "events_offer_contact" ON "events" USING btree ("offer_id","contact_id");--> statement-breakpoint
CREATE INDEX "events_offer_appointment" ON "events" USING btree ("offer_id","appointment_id");--> statement-breakpoint
CREATE INDEX "events_offer_deal" ON "events" USING btree ("offer_id","deal_id");--> statement-breakpoint
CREATE INDEX "outbox_due" ON "outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbox_offer_contact" ON "outbox" USING btree ("offer_id","contact_id","sent_at");--> statement-breakpoint
CREATE INDEX "run_steps_run" ON "run_steps" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_workflow_reentry" ON "runs" USING btree ("workflow_id","reentry_key");--> statement-breakpoint
CREATE INDEX "runs_due" ON "runs" USING btree ("status","next_wake_at");--> statement-breakpoint
CREATE INDEX "runs_offer_contact" ON "runs" USING btree ("offer_id","contact_id");--> statement-breakpoint
CREATE INDEX "runs_offer_appointment" ON "runs" USING btree ("offer_id","appointment_id");--> statement-breakpoint
CREATE INDEX "runs_workflow_base" ON "runs" USING btree ("workflow_id","reentry_base");--> statement-breakpoint
CREATE INDEX "slack_posts_tag" ON "slack_posts" USING btree ("offer_id","tag");--> statement-breakpoint
CREATE INDEX "slack_posts_run_node" ON "slack_posts" USING btree ("run_id","node");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_posts_ts" ON "slack_posts" USING btree ("offer_id","channel","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_workflow_version" ON "workflow_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_offer_key" ON "workflows" USING btree ("offer_id","key");