-- Connectors: what each offer is connected to (provider per port, mode, sealed credentials), its field map, the echoes of
-- its own writes, the last state seen of each vendor entity, agreements and transcripts being waited on, and the inbox's
-- per-connection doors.
CREATE TABLE "agreement_checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"offer_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"location_id" text NOT NULL,
	"agreement_id" text NOT NULL,
	"contact_id" text,
	"name" text,
	"sent_at" timestamp with time zone NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_status" text,
	"checks" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "agreement_checks_status" CHECK ("agreement_checks"."status" in ('waiting', 'signed', 'voided', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "connector_echoes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"offer_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"change" jsonb NOT NULL,
	"outbox_key" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"matched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "entity_versions" (
	"offer_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"version_at" timestamp with time zone,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "entity_versions_offer_id_provider_kind_entity_id_pk" PRIMARY KEY("offer_id","provider","kind","entity_id")
);
--> statement-breakpoint
CREATE TABLE "field_maps" (
	"offer_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"object" text DEFAULT 'contact' NOT NULL,
	"canonical_field" text NOT NULL,
	"provider_field_id" text NOT NULL,
	"value_type" text DEFAULT 'text' NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_maps_offer_id_provider_object_canonical_field_pk" PRIMARY KEY("offer_id","provider","object","canonical_field"),
	CONSTRAINT "field_maps_value_type" CHECK ("field_maps"."value_type" in ('text', 'date', 'datetime', 'number', 'money', 'options', 'checkbox', 'id'))
);
--> statement-breakpoint
CREATE TABLE "transcript_waits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"offer_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"recording_id" text NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"fact" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "transcript_waits_status" CHECK ("transcript_waits"."status" in ('waiting', 'ready', 'gave_up'))
);
--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "connections_status";--> statement-breakpoint
ALTER TABLE "connections" ALTER COLUMN "status" SET DEFAULT 'connected';--> statement-breakpoint
-- the engine's two states become the connection's: ok is connected, an auth pause is paused
UPDATE "connections" SET "status" = CASE "status" WHEN 'ok' THEN 'connected' WHEN 'paused_auth' THEN 'paused' ELSE "status" END;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "mode" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "credentials_enc" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "offer_id" uuid;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "agreement_checks" ADD CONSTRAINT "agreement_checks_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_echoes" ADD CONSTRAINT "connector_echoes_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_maps" ADD CONSTRAINT "field_maps_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_waits" ADD CONSTRAINT "transcript_waits_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agreement_checks_agreement" ON "agreement_checks" USING btree ("offer_id","agreement_id");--> statement-breakpoint
CREATE INDEX "agreement_checks_due" ON "agreement_checks" USING btree ("location_id","status","next_check_at");--> statement-breakpoint
CREATE INDEX "connector_echoes_entity" ON "connector_echoes" USING btree ("offer_id","provider","entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "field_maps_provider_field" ON "field_maps" USING btree ("offer_id","provider","object","provider_field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_waits_recording" ON "transcript_waits" USING btree ("offer_id","provider","recording_id");--> statement-breakpoint
CREATE INDEX "connections_provider_external" ON "connections" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "inbox_unprocessed" ON "inbox" USING btree ("source","processed_at");--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_status" CHECK ("connections"."status" in ('connected', 'paused', 'needs_reinstall', 'uninstalled'));