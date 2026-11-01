import { z } from "zod";
import { MetricName } from "./metrics";

// Fix 1: the kind makes "withdrawn" and "qualitative" explicit instead of inferring them from nulls.
export const GuidanceKind = z.enum(["range", "point", "qualitative", "withdrawn"]);
export type GuidanceKind = z.infer<typeof GuidanceKind>;

export const GuidanceChange = z.enum([
  "raised",
  "lowered",
  "maintained",
  "narrowed",
  "widened",
  "new",
  "withdrawn",
]);
export type GuidanceChange = z.infer<typeof GuidanceChange>;

/** "2026-FY" or "2026-Q4" - the period a guide applies to. */
export const TargetPeriod = z.string().regex(/^\d{4}-(FY|Q[1-4])$/);

export const ExtractedGuidance = z.object({
  metric: MetricName,
  kind: GuidanceKind,
  low: z.number().nullable(),
  high: z.number().nullable(),
  targetPeriod: TargetPeriod,
  quote: z.string().min(10),
  confidence: z.number().min(0).max(1),
});
export type ExtractedGuidance = z.infer<typeof ExtractedGuidance>;
