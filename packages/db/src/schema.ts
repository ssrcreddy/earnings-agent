import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  ChunkSection,
  DocumentStatus,
  DocumentType,
  EventStatus,
  GuidanceChange,
  GuidanceKind,
  MetricName,
  MetricUnit,
  PeriodType,
  ReviewStatus,
  Verdict,
} from "@eia/shared";

/** Zod 4 types enum options as a plain array; pgEnum needs a non-empty tuple. */
function values<T extends string>(e: { options: readonly T[] }): [T, ...T[]] {
  return e.options as [T, ...T[]];
}

// Postgres enums mirror the shared Zod enums, so the DB, API and UI can't drift apart.
export const eventStatus = pgEnum("event_status", values(EventStatus));
export const documentType = pgEnum("document_type", values(DocumentType));
export const documentStatus = pgEnum("document_status", values(DocumentStatus));
export const chunkSection = pgEnum("chunk_section", values(ChunkSection));
export const metricName = pgEnum("metric_name", values(MetricName));
export const metricUnit = pgEnum("metric_unit", values(MetricUnit));
export const periodType = pgEnum("period_type", values(PeriodType));
export const verdict = pgEnum("verdict", values(Verdict));
export const reviewStatus = pgEnum("review_status", values(ReviewStatus));
export const guidanceKind = pgEnum("guidance_kind", values(GuidanceKind));
export const guidanceChange = pgEnum("guidance_change", values(GuidanceChange));
export const parseQuality = pgEnum("parse_quality", ["normal", "low"]);

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticker: text("ticker").notNull().unique(),
    /** Zero-padded to 10 digits - the join key to EDGAR, never the ticker. */
    cik: text("cik").notNull().unique(),
    name: text("name").notNull(),
    exchange: text("exchange"),
    /** EDGAR "MMDD"; drives fiscal period labels (fix 4). */
    fiscalYearEnd: text("fiscal_year_end"),
    watched: boolean("watched").notNull().default(true),
    /** Advances only after every filing in a discovery batch is persisted (§15). */
    lastEdgarSeenAt: timestamp("last_edgar_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check("companies_ticker_upper", sql`${t.ticker} = upper(${t.ticker})`),
    check("companies_cik_format", sql`${t.cik} ~ '^[0-9]{10}$'`),
  ],
);

export const earningsEvents = pgTable(
  "earnings_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    /** Company's fiscal label, e.g. "2026-Q3" - not the calendar quarter. */
    fiscalPeriod: text("fiscal_period").notNull(),
    reportDate: timestamp("report_date", { withTimezone: true }).notNull(),
    status: eventStatus("status").notNull().default("discovered"),
    /** Discovery provenance: filing index URL, calendar entry. */
    sourceUrls: jsonb("source_urls").$type<Record<string, string>>().notNull().default({}),
    /** Set when the event failed; shown in the UI next to the requeue action. */
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("earnings_events_company_period_uq").on(t.companyId, t.fiscalPeriod),
    index("earnings_events_status_date_idx").on(t.status, t.reportDate),
  ],
);

/** Consensus snapshot taken at discovery (§15) - never overwritten, so beat/miss history can't rewrite itself. */
export const consensusSnapshots = pgTable(
  "consensus_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => earningsEvents.id),
    metric: metricName("metric").notNull(),
    value: numeric("value").notNull(),
    provider: text("provider").notNull(),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("consensus_event_metric_provider_uq").on(t.eventId, t.metric, t.provider)],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => earningsEvents.id),
    type: documentType("type").notNull(),
    status: documentStatus("status").notNull().default("ingested"),
    sourceUrl: text("source_url").notNull(),
    provider: text("provider").notNull(),
    /** EDGAR accession number or provider document id - the ingest dedupe key. */
    externalId: text("external_id").notNull(),
    sha256: text("sha256").notNull(),
    rawPath: text("raw_path").notNull(),
    contentType: text("content_type"),
    parseQuality: parseQuality("parse_quality"),
    /** Cleaned text produced by the parser; chunk and quote offsets index into this. */
    cleanText: text("clean_text"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    /** Set when an amended version replaces this one. */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("documents_event_sha_uq").on(t.eventId, t.sha256),
    index("documents_event_idx").on(t.eventId),
    index("documents_external_idx").on(t.externalId),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    seq: integer("seq").notNull(),
    section: chunkSection("section").notNull(),
    speaker: text("speaker"),
    text: text("text").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    tokenCount: integer("token_count").notNull(),
    // Denormalised for filter speed (§16).
    eventId: uuid("event_id")
      .notNull()
      .references(() => earningsEvents.id),
    ticker: text("ticker").notNull(),
    fiscalPeriod: text("fiscal_period").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    /** Embedding model + version, so a model change is detectable (§17). */
    embedModel: text("embed_model"),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', "text")`),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("chunks_document_seq_uq").on(t.documentId, t.seq),
    index("chunks_tsv_gin").using("gin", t.tsv),
    index("chunks_ticker_period_idx").on(t.ticker, t.fiscalPeriod),
  ],
);

export const metrics = pgTable(
  "metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => earningsEvents.id),
    name: metricName("name").notNull(),
    /** Company's own segment label (free text in the MVP); null = consolidated (fix 2). */
    segment: text("segment"),
    /** Base units (dollars, not $M); `unit` records what the value means. */
    value: numeric("value").notNull(),
    unit: metricUnit("unit").notNull(),
    periodType: periodType("period_type").notNull(),
    /** Q4 computed as full year minus nine-month YTD (fix 6). */
    derived: boolean("derived").notNull().default(false),
    consensusValue: numeric("consensus_value"),
    consensusProvider: text("consensus_provider"),
    consensusAsOf: timestamp("consensus_as_of", { withTimezone: true }),
    surprisePct: numeric("surprise_pct"),
    /** Written by Compare, never by the LLM (§19). */
    verdict: verdict("verdict"),
    quote: text("quote").notNull(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    confidence: numeric("confidence").notNull(),
    reviewStatus: reviewStatus("review_status").notNull(),
    /** Audit columns: the values before a human correction. */
    originalValue: numeric("original_value"),
    originalQuote: text("original_quote"),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // Fix 2: a quarter and a YTD value (and segment values) can coexist for one event.
    uniqueIndex("metrics_event_name_period_segment_uq").on(
      t.eventId,
      t.name,
      t.periodType,
      sql`coalesce(${t.segment}, '')`,
    ),
    check("metrics_quote_required", sql`length(trim(${t.quote})) >= 10`),
    check("metrics_confidence_range", sql`${t.confidence} between 0 and 1`),
  ],
);

export const guidance = pgTable(
  "guidance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => earningsEvents.id),
    /** Denormalised so the "previous guide" lookup needs no join. */
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    metric: metricName("metric").notNull(),
    kind: guidanceKind("kind").notNull(),
    low: numeric("low"),
    high: numeric("high"),
    targetPeriod: text("target_period").notNull(),
    prevGuidanceId: uuid("prev_guidance_id").references((): AnyPgColumn => guidance.id),
    /** Computed by Compare; null for qualitative-only guidance (§19). */
    change: guidanceChange("change"),
    /** Inputs used for the label (both values, tolerance) so it can be re-derived. */
    compareInputs: jsonb("compare_inputs"),
    /** True when mined from transcript Q&A (§18). */
    fromQa: boolean("from_qa").notNull().default(false),
    quote: text("quote").notNull(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    confidence: numeric("confidence").notNull(),
    reviewStatus: reviewStatus("review_status").notNull(),
    originalLow: numeric("original_low"),
    originalHigh: numeric("original_high"),
    originalQuote: text("original_quote"),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("guidance_event_metric_target_uq").on(t.eventId, t.metric, t.targetPeriod),
    index("guidance_prev_lookup_idx").on(t.companyId, t.metric, t.targetPeriod, t.createdAt.desc()),
    check("guidance_quote_required", sql`length(trim(${t.quote})) >= 10`),
    check(
      "guidance_kind_values",
      sql`(${t.kind} in ('range','point') and ${t.low} is not null and ${t.high} is not null and ${t.low} <= ${t.high})
          or (${t.kind} in ('qualitative','withdrawn') and ${t.low} is null and ${t.high} is null)`,
    ),
  ],
);

export const briefs = pgTable(
  "briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => earningsEvents.id),
    version: integer("version").notNull(),
    bodyMd: text("body_md").notNull(),
    metricIds: uuid("metric_ids").array().notNull(),
    guidanceIds: uuid("guidance_ids").array().notNull().default(sql`'{}'::uuid[]`),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // Fix 3: one current brief per event; older versions are kept, marked superseded.
    uniqueIndex("briefs_current_uq").on(t.eventId).where(sql`${t.supersededAt} is null`),
    uniqueIndex("briefs_event_version_uq").on(t.eventId, t.version),
  ],
);

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => earningsEvents.id),
    kind: text("kind").notNull(), // brief_ready | guidance_change | amendment | failure
    message: text("message").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("alerts_created_idx").on(t.createdAt.desc())],
);

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: text("purpose").notNull(), // extract | brief | ask | embed | classify
    model: text("model").notNull(),
    promptVersion: text("prompt_version"),
    inputTokens: integer("input_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull(),
    costUsd: numeric("cost_usd").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    eventId: uuid("event_id").references(() => earningsEvents.id),
    documentId: uuid("document_id").references(() => documents.id),
    ok: boolean("ok").notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("llm_calls_event_idx").on(t.eventId), index("llm_calls_created_idx").on(t.createdAt)],
);

/** Worker heartbeat per cron cycle (§23) - lets the UI show "last run" age. */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  name: text("name").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  detail: jsonb("detail"),
});
