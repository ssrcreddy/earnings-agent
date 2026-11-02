CREATE TYPE "public"."review_item_kind" AS ENUM('metric', 'guidance');--> statement-breakpoint
CREATE TYPE "public"."review_item_status" AS ENUM('open', 'corrected', 'rejected');--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "review_item_kind" NOT NULL,
	"event_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"candidate" jsonb NOT NULL,
	"errors" jsonb NOT NULL,
	"regex_value" numeric,
	"status" "review_item_status" DEFAULT 'open' NOT NULL,
	"resolved_row_id" uuid,
	"resolved_at" timestamp with time zone,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_event_id_earnings_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."earnings_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_items_open_idx" ON "review_items" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "review_items_document_idx" ON "review_items" USING btree ("document_id");