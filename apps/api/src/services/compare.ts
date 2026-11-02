// Change detection (§19): pure code - no I/O, no LLM. Every label it returns comes with the inputs
// that produced it, so any verdict or guidance change can be re-derived and audited.
// Decimal arithmetic throughout: a float error at a band edge would flip a verdict (tech-stack note).
import { METRIC_DEFS, type GuidanceChange, type GuidanceKind, type MetricName, type Verdict } from "@eia/shared";
import Decimal from "decimal.js";

export interface VerdictResult {
  verdict: Verdict;
  /** (actual - consensus) / |consensus| as a fraction; null without consensus or for percent metrics. */
  surprisePct: string | null;
  /** actual - consensus in percentage points, for percent metrics (margins). */
  surprisePoints: string | null;
}

/**
 * Beat / miss / inline against the metric's materiality band (§19): ±1% revenue, ±2% EPS,
 * ±0.5 pt margins. Exactly on the band edge is inline - "beyond" the band means strictly outside.
 */
export function verdictFor(metric: MetricName, actual: string | number, consensus: string | number | null): VerdictResult {
  if (consensus === null || consensus === undefined) {
    return { verdict: "no_consensus", surprisePct: null, surprisePoints: null };
  }
  const def = METRIC_DEFS[metric];
  const a = new Decimal(actual);
  const c = new Decimal(consensus);
  const sign = def.direction === "higher" ? 1 : -1;

  if (def.band.kind === "points") {
    const diff = a.minus(c);
    const edge = new Decimal(def.band.value);
    const verdict: Verdict = diff.abs().lte(edge) ? "inline" : diff.mul(sign).gt(0) ? "beat" : "miss";
    return { verdict, surprisePct: null, surprisePoints: diff.toString() };
  }

  if (c.isZero()) {
    // A zero consensus has no relative surprise; only the direction is meaningful.
    const verdict: Verdict = a.isZero() ? "inline" : a.mul(sign).gt(0) ? "beat" : "miss";
    return { verdict, surprisePct: null, surprisePoints: null };
  }
  const surprise = a.minus(c).div(c.abs());
  const edge = new Decimal(def.band.value);
  const verdict: Verdict = surprise.abs().lte(edge) ? "inline" : surprise.mul(sign).gt(0) ? "beat" : "miss";
  return { verdict, surprisePct: surprise.toDecimalPlaces(6).toString(), surprisePoints: null };
}

export interface GuideValues {
  id: string;
  kind: GuidanceKind;
  low: string | number | null;
  high: string | number | null;
}

export interface GuidanceComparison {
  change: GuidanceChange | null;
  inputs: {
    newId: string;
    prevId: string | null;
    newLow: string | null;
    newHigh: string | null;
    prevLow: string | null;
    prevHigh: string | null;
    midpointDelta: string | null;
    widthDelta: string | null;
    tolerance: string | null;
    rule: string;
  };
}

/** Relative tolerance on the previous midpoint, below which a move is "maintained" (§19). */
export const GUIDANCE_TOLERANCE = 0.005;

const dec = (v: string | number | null) => (v === null ? null : new Decimal(v));
const str = (v: Decimal | null) => (v === null ? null : v.toString());

/**
 * compareGuidance(new, prev) - decision order matters (§19). Qualitative guidance gets no label:
 * code never infers direction from prose. That is the false-guidance-change guardrail.
 */
export function compareGuidance(next: GuideValues, prev: GuideValues | null): GuidanceComparison {
  const inputs = (rule: string, extra: Partial<GuidanceComparison["inputs"]> = {}): GuidanceComparison["inputs"] => ({
    newId: next.id,
    prevId: prev?.id ?? null,
    newLow: str(dec(next.low)),
    newHigh: str(dec(next.high)),
    prevLow: str(dec(prev?.low ?? null)),
    prevHigh: str(dec(prev?.high ?? null)),
    midpointDelta: null,
    widthDelta: null,
    tolerance: null,
    rule,
    ...extra,
  });

  if (next.kind === "qualitative") return { change: null, inputs: inputs("qualitative guidance has no direction") };
  if (!prev) return { change: "new", inputs: inputs("no previous guide for this metric and target period") };
  if (next.kind === "withdrawn") return { change: "withdrawn", inputs: inputs("guidance withdrawn") };
  // A previous guide without figures can't anchor a numeric comparison.
  if (prev.kind === "qualitative" || prev.kind === "withdrawn" || prev.low === null || prev.high === null) {
    return { change: "new", inputs: inputs(`previous guide was ${prev.kind}; first numeric guide`) };
  }

  const nLow = new Decimal(next.low!);
  const nHigh = new Decimal(next.high!);
  const pLow = new Decimal(prev.low);
  const pHigh = new Decimal(prev.high);
  const nMid = nLow.plus(nHigh).div(2);
  const pMid = pLow.plus(pHigh).div(2);
  const tolerance = pMid.abs().mul(GUIDANCE_TOLERANCE);
  const midDelta = nMid.minus(pMid);
  const widthDelta = nHigh.minus(nLow).minus(pHigh.minus(pLow));
  const extra = { midpointDelta: midDelta.toString(), widthDelta: widthDelta.toString(), tolerance: tolerance.toString() };

  if (midDelta.abs().gt(tolerance)) {
    return { change: midDelta.gt(0) ? "raised" : "lowered", inputs: inputs("midpoint moved beyond tolerance", extra) };
  }
  if (widthDelta.lt(tolerance.neg())) return { change: "narrowed", inputs: inputs("range narrowed beyond tolerance", extra) };
  if (widthDelta.gt(tolerance)) return { change: "widened", inputs: inputs("range widened beyond tolerance", extra) };
  return { change: "maintained", inputs: inputs("midpoint and width within tolerance", extra) };
}

/** Year-over-year change as a fraction, or null when there's no usable prior value. */
export function yoyChange(actual: string | number, prior: string | number | null): string | null {
  if (prior === null) return null;
  const p = new Decimal(prior);
  if (p.isZero()) return null;
  return new Decimal(actual).minus(p).div(p.abs()).toDecimalPlaces(6).toString();
}

/**
 * Fix 6: a Q4 that is only reported as a full year is derived as full year minus the nine-month
 * year to date. Returns null unless both inputs exist.
 */
export function deriveQ4(fullYear: string | number | null, nineMonthYtd: string | number | null): string | null {
  if (fullYear === null || nineMonthYtd === null) return null;
  return new Decimal(fullYear).minus(nineMonthYtd).toString();
}

/** "2026-Q2" -> "2025-Q2": the same quarter a year earlier, for prior-year comparison. */
export function priorYearPeriod(fiscalPeriod: string): string {
  const [y, q] = fiscalPeriod.split("-");
  return `${Number(y) - 1}-${q}`;
}
