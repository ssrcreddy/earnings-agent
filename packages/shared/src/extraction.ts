import { z } from "zod";
import { ExtractedGuidance, GuidanceKind } from "./guidance";
import { ExtractedMetric, MetricName, MetricUnit, PeriodType } from "./metrics";

/** The validated result: every item passes the strict §13 schemas. */
export const ExtractionResult = z.object({
  metrics: z.array(ExtractedMetric),
  guidance: z.array(ExtractedGuidance),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

// What the model is asked to return. Same shape as the strict schemas, minus constraints that
// structured outputs don't enforce (string lengths, number ranges, patterns): every item is
// re-checked against ExtractedMetric / ExtractedGuidance in code, so a model that ignores a rule
// produces a validation error and a retry, never a silently accepted value.
export const LlmMetric = z.object({
  name: MetricName,
  segment: z.string().nullable(),
  value: z.number(),
  unit: MetricUnit,
  periodType: PeriodType,
  quote: z.string(),
  confidence: z.number(),
});
export type LlmMetric = z.infer<typeof LlmMetric>;

export const LlmGuidance = z.object({
  metric: MetricName,
  kind: GuidanceKind,
  low: z.number().nullable(),
  high: z.number().nullable(),
  targetPeriod: z.string(),
  quote: z.string(),
  confidence: z.number(),
});
export type LlmGuidance = z.infer<typeof LlmGuidance>;

export const LlmExtractionResult = z.object({
  metrics: z.array(LlmMetric),
  guidance: z.array(LlmGuidance),
});
export type LlmExtractionResult = z.infer<typeof LlmExtractionResult>;
