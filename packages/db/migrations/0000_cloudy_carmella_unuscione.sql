CREATE TYPE "public"."chunk_section" AS ENUM('headline_table', 'release_body', 'mda', 'risk', 'prepared_remarks', 'qa', 'other');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('ingested', 'parsed', 'extracted', 'unavailable', 'needs_review', 'failed');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('press_release', 'filing_10q', 'filing_10k', 'transcript');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('discovered', 'ingested', 'parsed', 'extracted', 'compared', 'briefed', 'needs_review', 'failed');--> statement-breakpoint
CREATE TYPE "public"."guidance_change" AS ENUM('raised', 'lowered', 'maintained', 'narrowed', 'widened', 'new', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."guidance_kind" AS ENUM('range', 'point', 'qualitative', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."metric_name" AS ENUM('revenue', 'eps_gaap', 'eps_adj', 'gross_margin', 'op_income', 'net_income', 'fcf', 'capex');--> statement-breakpoint
CREATE TYPE "public"."metric_unit" AS ENUM('usd', 'usd_per_share', 'percent');--> statement-breakpoint
CREATE TYPE "public"."parse_quality" AS ENUM('normal', 'low');--> statement-breakpoint
CREATE TYPE "public"."period_type" AS ENUM('quarter', 'ytd', 'full_year');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('auto_approved', 'pending', 'approved', 'corrected');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('beat', 'miss', 'inline', 'no_consensus');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body_md" text NOT NULL,
	"metric_ids" uuid[] NOT NULL,
	"guidance_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"section" "chunk_section" NOT NULL,
	"speaker" text,
	"text" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"token_count" integer NOT NULL,
	"event_id" uuid NOT NULL,
	"ticker" text NOT NULL,
	"fiscal_period" text NOT NULL,
	"embedding" vector(1536),
	"embed_model" text,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticker" text NOT NULL,
	"cik" text NOT NULL,
	"name" text NOT NULL,
	"exchange" text,
	"fiscal_year_end" text,
	"watched" boolean DEFAULT true NOT NULL,
	"last_edgar_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_ticker_unique" UNIQUE("ticker"),
	CONSTRAINT "companies_cik_unique" UNIQUE("cik"),
	CONSTRAINT "companies_ticker_upper" CHECK ("companies"."ticker" = upper("companies"."ticker")),
	CONSTRAINT "companies_cik_format" CHECK ("companies"."cik" ~ '^[0-9]{10}$')
);
--> statement-breakpoint
CREATE TABLE "consensus_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"metric" "metric_name" NOT NULL,
	"value" numeric NOT NULL,
	"provider" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"type" "document_type" NOT NULL,
	"status" "document_status" DEFAULT 'ingested' NOT NULL,
	"source_url" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"sha256" text NOT NULL,
	"raw_path" text NOT NULL,
	"content_type" text,
	"parse_quality" "parse_quality",
	"clean_text" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "earnings_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fiscal_period" text NOT NULL,
	"report_date" timestamp with time zone NOT NULL,
	"status" "event_status" DEFAULT 'discovered' NOT NULL,
	"source_urls" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guidance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"metric" "metric_name" NOT NULL,
	"kind" "guidance_kind" NOT NULL,
	"low" numeric,
	"high" numeric,
	"target_period" text NOT NULL,
	"prev_guidance_id" uuid,
	"change" "guidance_change",
	"compare_inputs" jsonb,
	"from_qa" boolean DEFAULT false NOT NULL,
	"quote" text NOT NULL,
	"document_id" uuid NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"confidence" numeric NOT NULL,
	"review_status" "review_status" NOT NULL,
	"original_low" numeric,
	"original_high" numeric,
	"original_quote" text,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guidance_quote_required" CHECK (length(trim("guidance"."quote")) >= 10),
	CONSTRAINT "guidance_kind_values" CHECK (("guidance"."kind" in ('range','point') and "guidance"."low" is not null and "guidance"."high" is not null and "guidance"."low" <= "guidance"."high")
          or ("guidance"."kind" in ('qualitative','withdrawn') and "guidance"."low" is null and "guidance"."high" is null))
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text,
	"input_tokens" integer NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" numeric NOT NULL,
	"latency_ms" integer NOT NULL,
	"event_id" uuid,
	"document_id" uuid,
	"ok" boolean NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" "metric_name" NOT NULL,
	"segment" text,
	"value" numeric NOT NULL,
	"unit" "metric_unit" NOT NULL,
	"period_type" "period_type" NOT NULL,
	"derived" boolean DEFAULT false NOT NULL,
	"consensus_value" numeric,
	"consensus_provider" text,
	"consensus_as_of" timestamp with time zone,
	"surprise_pct" numeric,
	"verdict" "verdict",
	"quote" text NOT NULL,
	"document_id" uuid NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"confidence" numeric NOT NULL,
	"review_status" "review_status" NOT NULL,
	"original_value" numeric,
	"original_quote" text,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metrics_quote_required" CHECK (length(trim("metrics"."quote")) >= 10),
	CONSTRAINT "metrics_confidence_range" CHECK ("metrics"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_event_id_earnings_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."earnings_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_event_id_earnings_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."earnings_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_event_id_earnings_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."earnings_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consensus_snapshots" ADD CONSTRAINT "consensus_snapshots_event_id_earnings_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."earnings_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_event_id_earnings_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."earnings_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings_events" ADD CONSTRAINT "earnings_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance" ADD CONSTRAINT "guidance_event_id_earnings_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."earnings_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance" ADD CONSTRAINT "guidance_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance" ADD CONSTRAINT "guidance_prev_guidance_id_guidance_id_fk" FOREIGN KEY ("prev_guidance_id") REFERENCES "public"."guidance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance" ADD CONSTRAINT "guidance_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_event_id_earnings_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."earnings_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_event_id_earnings_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."earnings_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_created_idx" ON "alerts" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "briefs_current_uq" ON "briefs" USING btree ("event_id") WHERE "briefs"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "briefs_event_version_uq" ON "briefs" USING btree ("event_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_document_seq_uq" ON "chunks" USING btree ("document_id","seq");--> statement-breakpoint
CREATE INDEX "chunks_tsv_gin" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "chunks_ticker_period_idx" ON "chunks" USING btree ("ticker","fiscal_period");--> statement-breakpoint
CREATE UNIQUE INDEX "consensus_event_metric_provider_uq" ON "consensus_snapshots" USING btree ("event_id","metric","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_event_sha_uq" ON "documents" USING btree ("event_id","sha256");--> statement-breakpoint
CREATE INDEX "documents_event_idx" ON "documents" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "documents_external_idx" ON "documents" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "earnings_events_company_period_uq" ON "earnings_events" USING btree ("company_id","fiscal_period");--> statement-breakpoint
CREATE INDEX "earnings_events_status_date_idx" ON "earnings_events" USING btree ("status","report_date");--> statement-breakpoint
CREATE UNIQUE INDEX "guidance_event_metric_target_uq" ON "guidance" USING btree ("event_id","metric","target_period");--> statement-breakpoint
CREATE INDEX "guidance_prev_lookup_idx" ON "guidance" USING btree ("company_id","metric","target_period","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "llm_calls_event_idx" ON "llm_calls" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "metrics_event_name_period_segment_uq" ON "metrics" USING btree ("event_id","name","period_type",coalesce("segment", ''));