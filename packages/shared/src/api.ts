import { z } from "zod";
import { EventStatus } from "./events";

export const Ticker = z
  .string()
  .trim()
  .min(1)
  .max(10)
  .regex(/^[A-Za-z.-]+$/)
  .transform((s) => s.toUpperCase());

export const CreateCompanyBody = z.object({ ticker: Ticker });
export type CreateCompanyBody = z.infer<typeof CreateCompanyBody>;

export const CompanyResponse = z.object({
  id: z.uuid(),
  ticker: z.string(),
  cik: z.string(),
  name: z.string(),
  exchange: z.string().nullable(),
  fiscalYearEnd: z.string().nullable(),
  watched: z.boolean(),
});
export type CompanyResponse = z.infer<typeof CompanyResponse>;

export const EventSummary = z.object({
  id: z.uuid(),
  ticker: z.string(),
  fiscalPeriod: z.string(),
  reportDate: z.string(), // ISO-8601 UTC
  status: EventStatus,
  documents: z.array(
    z.object({
      id: z.uuid(),
      type: z.string(),
      status: z.string(),
      sourceUrl: z.string(),
      fetchedAt: z.string(),
    }),
  ),
});
export type EventSummary = z.infer<typeof EventSummary>;

export const BriefResponse = z.object({
  eventId: z.uuid(),
  ticker: z.string(),
  fiscalPeriod: z.string(),
  version: z.number().int(),
  bodyMd: z.string(),
  citations: z.array(
    z.object({
      metricId: z.uuid(),
      quote: z.string(),
      documentType: z.string(),
      sourceUrl: z.url(),
      charStart: z.number().int(),
      charEnd: z.number().int(),
    }),
  ),
});
export type BriefResponse = z.infer<typeof BriefResponse>;

/** PATCH /review/:kind/:id (§21). `value` is in base units, like metrics.value. */
export const ReviewAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("reject"), reason: z.string().trim().min(3).max(500) }),
  z.object({
    action: z.literal("correct"),
    value: z.number().optional(),
    low: z.number().nullable().optional(),
    high: z.number().nullable().optional(),
    quote: z.string().trim().min(10),
  }),
]);
export type ReviewAction = z.infer<typeof ReviewAction>;

export const ReviewKind = z.enum(["metric", "guidance", "candidate"]);
export type ReviewKind = z.infer<typeof ReviewKind>;

/** One entry of GET /review (§21, §22). */
export interface ReviewEntry {
  kind: ReviewKind;
  id: string;
  ticker: string;
  fiscalPeriod: string;
  documentId: string;
  documentType: string;
  sourceUrl: string;
  /** The extracted metric or guidance item; candidates add `itemKind`. */
  item: Record<string, unknown>;
  confidence: number;
  /** Why it's here: below the confidence threshold, or the validation errors. */
  reasons: string[];
  /** Headline-table value when it disagreed (§18 step 2). */
  regexValue: number | null;
  /** Company-facts values for the same metric and period (§22), empty when none. */
  factValues: number[];
  /** The quote in its surrounding text; quoteStart/End are offsets within `text`, null if not found. */
  context: { text: string; quoteStart: number | null; quoteEnd: number | null };
}

export interface ReviewListResponse {
  items: ReviewEntry[];
  total: number;
}

/** PATCH /review/:kind/:id result. */
export interface ReviewResult {
  kind: ReviewKind;
  id: string;
  status: string;
  /** The metrics/guidance row the action produced or changed. */
  rowId: string | null;
  goldenFile: string | null;
  documentStatus: string;
}

export const ErrorCode = z.enum([
  "UNKNOWN_TICKER",
  "EVENT_NOT_FOUND",
  "COMPANY_NOT_FOUND",
  "REVIEW_ITEM_NOT_FOUND",
  "REVIEW_CONFLICT",
  "QUOTE_NOT_FOUND",
  "VALIDATION_FAILED",
  "UPSTREAM_ERROR",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({ error: z.object({ code: ErrorCode, message: z.string() }) });
export type ErrorBody = z.infer<typeof ErrorBody>;
