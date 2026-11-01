import { z } from "zod";

// Closed vocabulary (§13). Unknown concepts fail parsing and go to review.
export const MetricName = z.enum([
  "revenue",
  "eps_gaap",
  "eps_adj",
  "gross_margin",
  "op_income",
  "net_income",
  "fcf",
  "capex",
]);
export type MetricName = z.infer<typeof MetricName>;

export const MetricUnit = z.enum(["usd", "usd_per_share", "percent"]);
export type MetricUnit = z.infer<typeof MetricUnit>;

export const PeriodType = z.enum(["quarter", "ytd", "full_year"]);
export type PeriodType = z.infer<typeof PeriodType>;

export const Verdict = z.enum(["beat", "miss", "inline", "no_consensus"]);
export type Verdict = z.infer<typeof Verdict>;

export const ReviewStatus = z.enum(["auto_approved", "pending", "approved", "corrected"]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

// Per-metric config used by Compare (§19). Bands are config, not code paths.
export interface MetricDef {
  unit: MetricUnit;
  /** "higher" = a bigger actual is a beat; "lower" flips the verdict. */
  direction: "higher" | "lower";
  /** Materiality band: relative fraction for usd/per-share, absolute points for percent. */
  band: { kind: "relative"; value: number } | { kind: "points"; value: number };
}

export const METRIC_DEFS: Record<MetricName, MetricDef> = {
  revenue: { unit: "usd", direction: "higher", band: { kind: "relative", value: 0.01 } },
  eps_gaap: { unit: "usd_per_share", direction: "higher", band: { kind: "relative", value: 0.02 } },
  eps_adj: { unit: "usd_per_share", direction: "higher", band: { kind: "relative", value: 0.02 } },
  gross_margin: { unit: "percent", direction: "higher", band: { kind: "points", value: 0.5 } },
  op_income: { unit: "usd", direction: "higher", band: { kind: "relative", value: 0.02 } },
  net_income: { unit: "usd", direction: "higher", band: { kind: "relative", value: 0.02 } },
  fcf: { unit: "usd", direction: "higher", band: { kind: "relative", value: 0.02 } },
  capex: { unit: "usd", direction: "higher", band: { kind: "relative", value: 0.02 } },
};

// What the LLM is allowed to return - nothing else parses.
// OpenAI strict mode requires every key present, so optional fields are nullable.
export const ExtractedMetric = z.object({
  name: MetricName,
  /** Company's own segment label (free text in the MVP); null for consolidated figures. */
  segment: z.string().nullable(),
  value: z.number(),
  unit: MetricUnit,
  periodType: PeriodType,
  quote: z.string().min(10), // verbatim, from the document
  confidence: z.number().min(0).max(1),
});
export type ExtractedMetric = z.infer<typeof ExtractedMetric>;
