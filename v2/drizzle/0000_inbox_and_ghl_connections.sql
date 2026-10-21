CREATE TABLE "ghl_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" text NOT NULL,
	"company_id" text,
	"installed_by" text,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scopes" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"needs_review" boolean DEFAULT true NOT NULL,
	CONSTRAINT "ghl_connections_location_id_unique" UNIQUE("location_id")
);
--> statement-breakpoint
CREATE TABLE "inbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text,
	"location_id" text,
	"headers" jsonb NOT NULL,
	"body" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_source_delivery" ON "inbox" USING btree ("source","delivery_id");