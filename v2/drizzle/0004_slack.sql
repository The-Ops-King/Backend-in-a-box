CREATE TABLE "person_identities" (
	"offer_id" uuid NOT NULL,
	"person_id" text NOT NULL,
	"kind" text NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "person_identities_offer_id_kind_team_id_user_id_pk" PRIMARY KEY("offer_id","kind","team_id","user_id"),
	CONSTRAINT "person_identities_kind" CHECK ("person_identities"."kind" in ('slack'))
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_alert_state" (
	"alert_id" bigint PRIMARY KEY NOT NULL,
	"team_id" text,
	"channel" text,
	"ts" text,
	"said_count" integer DEFAULT 0 NOT NULL,
	"last_said_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"paused_by" text,
	"resolved_said_at" timestamp with time zone,
	"quiet" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"offer_id" uuid,
	"team_id" text,
	"user_id" text,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_bot_usage" (
	"offer_id" uuid NOT NULL,
	"day" text NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "slack_bot_usage_offer_id_day_pk" PRIMARY KEY("offer_id","day")
);
--> statement-breakpoint
CREATE TABLE "slack_channels" (
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"offer_id" uuid NOT NULL,
	"slots" text[] DEFAULT '{}'::text[] NOT NULL,
	"name" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"bot_member" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "slack_channels_team_id_channel_id_pk" PRIMARY KEY("team_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "slack_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"offer_id" uuid,
	"team_id" text NOT NULL,
	"channel" text NOT NULL,
	"ts" text NOT NULL,
	"thread_ts" text,
	"kind" text NOT NULL,
	"workflow_id" uuid,
	"run_id" uuid,
	"node" text,
	"tag" text,
	"outbox_id" bigint,
	"alert_id" bigint,
	"app" text DEFAULT 'platform' NOT NULL,
	"sandbox" boolean DEFAULT false NOT NULL,
	"settled" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "slack_messages_kind" CHECK ("slack_messages"."kind" in ('workflow', 'alert', 'bot', 'command', 'support'))
);
--> statement-breakpoint
CREATE TABLE "slack_offer_links" (
	"offer_id" uuid PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"linked_by" text,
	"linked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"offer_id" uuid,
	"team_id" text,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"alert_id" bigint,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "slack_outbox_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "slack_outbox_kind" CHECK ("slack_outbox"."kind" in ('post', 'update', 'react', 'respond', 'ephemeral')),
	CONSTRAINT "slack_outbox_status" CHECK ("slack_outbox"."status" in ('queued', 'sending', 'sent', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "slack_workspaces" (
	"team_id" text PRIMARY KEY NOT NULL,
	"team_name" text,
	"app_id" text,
	"bot_user_id" text NOT NULL,
	"bot_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"token_expires_at" timestamp with time zone,
	"scopes" text NOT NULL,
	"installed_by" text,
	"installed_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person_identities" ADD CONSTRAINT "person_identities_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_alert_state" ADD CONSTRAINT "slack_alert_state_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_bot_usage" ADD CONSTRAINT "slack_bot_usage_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_channels" ADD CONSTRAINT "slack_channels_team_id_slack_workspaces_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."slack_workspaces"("team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_channels" ADD CONSTRAINT "slack_channels_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_messages" ADD CONSTRAINT "slack_messages_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_offer_links" ADD CONSTRAINT "slack_offer_links_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_offer_links" ADD CONSTRAINT "slack_offer_links_team_id_slack_workspaces_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."slack_workspaces"("team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "person_identities_person" ON "person_identities" USING btree ("offer_id","person_id","kind","team_id");--> statement-breakpoint
CREATE INDEX "person_identities_user" ON "person_identities" USING btree ("kind","team_id","user_id");--> statement-breakpoint
CREATE INDEX "slack_audit_offer" ON "slack_audit" USING btree ("offer_id","at");--> statement-breakpoint
CREATE INDEX "slack_channels_offer" ON "slack_channels" USING btree ("offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_messages_ts" ON "slack_messages" USING btree ("team_id","channel","ts");--> statement-breakpoint
CREATE INDEX "slack_messages_run" ON "slack_messages" USING btree ("run_id","node");--> statement-breakpoint
CREATE INDEX "slack_messages_tag" ON "slack_messages" USING btree ("offer_id","tag");--> statement-breakpoint
CREATE INDEX "slack_offer_links_team" ON "slack_offer_links" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "slack_outbox_due" ON "slack_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
-- The platform's own settings, the same for every offer. An open alert is said again every repeat_minutes, only within
-- repeat_hours on repeat_zone's clock (v1's values: Tyler's working day, Arizona). The bot's daily token budget per offer
-- applies where an offer sets none (bot.daily_token_budget); a platform default for Tyler to confirm.
INSERT INTO "platform_settings" ("key", "value", "updated_by") VALUES
  ('alerts.repeat_minutes', '60'::jsonb, 'migration 0004'),
  ('alerts.repeat_hours', '"07:00-17:00"'::jsonb, 'migration 0004'),
  ('alerts.repeat_zone', '"America/Phoenix"'::jsonb, 'migration 0004'),
  ('bot.daily_token_budget', '200000'::jsonb, 'migration 0004')
ON CONFLICT ("key") DO NOTHING;
