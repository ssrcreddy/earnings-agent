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

export const ErrorCode = z.enum([
  "UNKNOWN_TICKER",
  "EVENT_NOT_FOUND",
  "COMPANY_NOT_FOUND",
  "VALIDATION_FAILED",
  "UPSTREAM_ERROR",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({ error: z.object({ code: ErrorCode, message: z.string() }) });
export type ErrorBody = z.infer<typeof ErrorBody>;
