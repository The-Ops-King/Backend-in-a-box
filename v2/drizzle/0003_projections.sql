CREATE TABLE "appointments" (
	"offer_id" uuid NOT NULL,
	"id" text NOT NULL,
	"contact_id" text,
	"status" text,
	"kind" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"booked_at" timestamp with time zone,
	"booking_source" text,
	"set_by" text,
	"closer_key" text,
	"reschedules" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"call_outcome" text,
	"outcome_source" text,
	"outcome_at" timestamp with time zone,
	"pending_read" jsonb,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "appointments_offer_id_id_pk" PRIMARY KEY("offer_id","id")
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"offer_id" uuid NOT NULL,
	"id" text NOT NULL,
	"contact_id" text,
	"appointment_id" text,
	"source" text NOT NULL,
	"kind" text,
	"booked" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone,
	"held" boolean,
	"outcome" text,
	"rep_key" text,
	"recording_id" text,
	"recording" jsonb,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_sec" integer,
	"direction" text,
	"connected" boolean,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "calls_offer_id_id_pk" PRIMARY KEY("offer_id","id")
);
--> statement-breakpoint
CREATE TABLE "contacts_index" (
	"offer_id" uuid NOT NULL,
	"id" text NOT NULL,
	"crm_id" text,
	"phones" text[] DEFAULT '{}'::text[] NOT NULL,
	"emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"merged_into" text,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"records" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agreement" jsonb,
	"lead_at" timestamp with time zone,
	"first_dial_at" timestamp with time zone,
	"speed_to_lead_min" integer,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contacts_index_offer_id_id_pk" PRIMARY KEY("offer_id","id")
);
--> statement-breakpoint
CREATE TABLE "daily_facts" (
	"offer_id" uuid NOT NULL,
	"id" text NOT NULL,
	"day" text NOT NULL,
	"metric" text NOT NULL,
	"closer" text NOT NULL,
	"setter" text NOT NULL,
	"source" text NOT NULL,
	"n" integer NOT NULL,
	"amount" numeric NOT NULL,
	CONSTRAINT "daily_facts_offer_id_id_pk" PRIMARY KEY("offer_id","id")
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"offer_id" uuid NOT NULL,
	"id" text NOT NULL,
	"contact_id" text,
	"kind" text NOT NULL,
	"pipeline" text,
	"crm_id" text,
	"stage" text,
	"status" text,
	"owner_key" text,
	"name" text,
	"value" numeric,
	"opened_at" timestamp with time zone,
	"won_at" timestamp with time zone,
	"lost_at" timestamp with time zone,
	"seq" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deals_offer_id_id_pk" PRIMARY KEY("offer_id","id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"offer_id" uuid NOT NULL,
	"id" text NOT NULL,
	"contact_id" text,
	"deal_id" text,
	"provider_payment_id" text,
	"status" text NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text,
	"paid_at" timestamp with time zone NOT NULL,
	"product" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"refund_of" text,
	"customer" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"linked_by" text,
	"seq" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payments_offer_id_id_pk" PRIMARY KEY("offer_id","id")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"offer_id" uuid NOT NULL,
	"id" text NOT NULL,
	"name" text,
	"email" text,
	"slack_user_id" text,
	"crm_user_id" text,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"eod_days" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "people_offer_id_id_pk" PRIMARY KEY("offer_id","id")
);
--> statement-breakpoint
CREATE TABLE "report_definitions" (
	"offer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"definition" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_definitions_offer_id_kind_key_pk" PRIMARY KEY("offer_id","kind","key"),
	CONSTRAINT "report_definitions_kind" CHECK ("report_definitions"."kind" in ('report', 'metric'))
);
--> statement-breakpoint
CREATE TABLE "schedule_timers" (
	"workflow_id" uuid NOT NULL,
	"node" text NOT NULL,
	"offer_id" uuid NOT NULL,
	"next_at" timestamp with time zone NOT NULL,
	"last_period" text,
	CONSTRAINT "schedule_timers_workflow_id_node_pk" PRIMARY KEY("workflow_id","node")
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts_index" ADD CONSTRAINT "contacts_index_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_facts" ADD CONSTRAINT "daily_facts_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_timers" ADD CONSTRAINT "schedule_timers_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_timers" ADD CONSTRAINT "schedule_timers_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_contact" ON "appointments" USING btree ("offer_id","contact_id");--> statement-breakpoint
CREATE INDEX "appointments_starts" ON "appointments" USING btree ("offer_id","starts_at");--> statement-breakpoint
CREATE INDEX "calls_contact" ON "calls" USING btree ("offer_id","contact_id");--> statement-breakpoint
CREATE INDEX "calls_recording" ON "calls" USING btree ("offer_id","recording_id");--> statement-breakpoint
CREATE INDEX "contacts_index_crm" ON "contacts_index" USING btree ("offer_id","crm_id");--> statement-breakpoint
CREATE INDEX "daily_facts_day" ON "daily_facts" USING btree ("offer_id","metric","day");--> statement-breakpoint
CREATE INDEX "deals_contact" ON "deals" USING btree ("offer_id","contact_id");--> statement-breakpoint
CREATE INDEX "payments_contact" ON "payments" USING btree ("offer_id","contact_id");--> statement-breakpoint
CREATE INDEX "payments_paid" ON "payments" USING btree ("offer_id","paid_at");--> statement-breakpoint
CREATE INDEX "people_crm" ON "people" USING btree ("offer_id","crm_user_id");--> statement-breakpoint
CREATE INDEX "schedule_timers_due" ON "schedule_timers" USING btree ("next_at");