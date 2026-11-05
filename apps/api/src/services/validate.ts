// Extraction validator (§18 step 4): plain code between the model and the database. Pure.
// "Quote or it didn't happen": an item whose quote isn't in the source, or whose value isn't in its
// quote (or confirmed by company-facts), is rejected - never saved, never published.
import {
  ExtractedGuidance,
  ExtractedMetric,
  METRIC_DEFS,
  type DocumentType,
  type LlmGuidance,
  type LlmMetric,
} from "@eia/shared";
import type { HeadlineFigure } from "../parsing/headline";
import { approxEqual, findNumbers, tableScaleIn, type NumberToken } from "../parsing/numbers";
import { factValues, type CompanyFacts } from "./companyFacts";

/** Relative tolerance for "same number" (§18: company-facts within 0.5%). */
export const VALUE_TOLERANCE = 0.005;
/** How far before a quote to look for a "(in millions)" table caption. */
const SCALE_LOOKBACK = 3000;

export interface ValidationContext {
  /** documents.clean_text - quotes must be found here. */
  text: string;
  docType: DocumentType;
  /** The event's fiscal label, e.g. "2026-Q2". */
  fiscalPeriod: string;
  /** Nominal end of that quarter, for matching company-facts periods. */
  periodEnd: Date;
  facts: CompanyFacts | null;
  headline: HeadlineFigure[];
}

export type FactsCheck = "match" | "mismatch" | "unavailable";

export type MetricVerdict =
  | { ok: true; item: ExtractedMetric; charStart: number; charEnd: number; facts: FactsCheck }
  | { ok: false; item: LlmMetric; errors: string[]; regexValue: number | null };

export type GuidanceVerdict =
  | { ok: true; item: ExtractedGuidance; charStart: number; charEnd: number }
  | { ok: false; item: LlmGuidance; errors: string[] };

const label = (m: { name: string; segment: string | null; periodType: string }) =>
  `${m.name}${m.segment ? ` (${m.segment})` : ""} [${m.periodType}]`;

/**
 * Spending metrics are stored as positive amounts. Cash-flow tables print outflows in parentheses,
 * so the sign in a quote says nothing about the figure: compare magnitudes and normalise.
 */
/** A guidance row may hold a label, a low and a high; anything wider is a reconciliation table. */
const MAX_GUIDANCE_ROW_CELLS = 3;

export const UNSIGNED_METRICS = new Set<string>(["capex"]);

export function validateMetric(raw: LlmMetric, vc: ValidationContext): MetricVerdict {
  const unsigned = UNSIGNED_METRICS.has(raw.name);
  const m = unsigned ? { ...raw, value: Math.abs(raw.value) } : raw;
  const errors: string[] = [];
  const parsed = ExtractedMetric.safeParse(m);
  if (!parsed.success) errors.push(...parsed.error.issues.map((i) => `${label(m)}: ${i.path.join(".")} ${i.message}`));

  if (METRIC_DEFS[m.name] && METRIC_DEFS[m.name].unit !== m.unit) {
    errors.push(`${label(m)}: unit must be ${METRIC_DEFS[m.name].unit}, got ${m.unit}`);
  }
  errors.push(...sanityErrors(m, vc));

  const found = locateQuote(vc.text, m.quote);
  if (!found) errors.push(`${label(m)}: quote not found verbatim in the document - re-extract with an exact quote`);

  const facts = factValues(vc.facts, m.name, m.periodType, vc.periodEnd, vc.fiscalPeriod);
  const factsCheck: FactsCheck =
    facts.length === 0 ? "unavailable" : facts.some((f) => approxEqual(f, m.value, VALUE_TOLERANCE)) ? "match" : "mismatch";
  if (found && !valueInQuote(m.value, m.unit, m.quote, vc.text, found.start, unsigned) && factsCheck !== "match") {
    errors.push(`${label(m)}: value ${m.value} does not appear in its quote and is not confirmed by company facts`);
  }

  // Headline-table cross-check (§18 step 2): consolidated quarterly figures must agree.
  let regexValue: number | null = null;
  const headline = vc.headline.find((h) => h.metric === m.name);
  if (headline && m.segment === null && m.periodType === "quarter" && !approxEqual(headline.value, m.value, VALUE_TOLERANCE)) {
    regexValue = headline.value;
    errors.push(`${label(m)}: value ${m.value} disagrees with the headline table (${headline.value}: "${headline.row}")`);
  }

  if (errors.length || !parsed.success || !found) return { ok: false, item: m, errors, regexValue };
  return { ok: true, item: parsed.data, charStart: found.start, charEnd: found.end, facts: factsCheck };
}

export function validateGuidance(raw: LlmGuidance, vc: ValidationContext): GuidanceVerdict {
  const unsigned = UNSIGNED_METRICS.has(raw.metric);
  let g = raw;
  if (unsigned && raw.low !== null && raw.high !== null) {
    const [a, b] = [Math.abs(raw.low), Math.abs(raw.high)];
    g = { ...raw, low: Math.min(a, b), high: Math.max(a, b) };
  }
  const errors: string[] = [];
  const name = `guidance ${g.metric} ${g.targetPeriod}`;
  const parsed = ExtractedGuidance.safeParse(g);
  if (!parsed.success) errors.push(...parsed.error.issues.map((i) => `${name}: ${i.path.join(".")} ${i.message}`));

  // Shape must match the kind; the DB enforces the same rule.
  if (g.kind === "range" && !(g.low !== null && g.high !== null && g.low < g.high)) {
    errors.push(`${name}: a range needs low < high`);
  }
  if (g.kind === "point" && !(g.low !== null && g.low === g.high)) errors.push(`${name}: a point guide needs low = high`);
  if ((g.kind === "qualitative" || g.kind === "withdrawn") && (g.low !== null || g.high !== null)) {
    errors.push(`${name}: ${g.kind} guidance has no low/high`);
  }

  const year = Number(g.targetPeriod.slice(0, 4));
  const eventYear = Number(vc.fiscalPeriod.slice(0, 4));
  if (Number.isFinite(year) && (year < eventYear || year > eventYear + 2)) {
    errors.push(`${name}: target period is outside ${eventYear}-${eventYear + 2}`);
  }

  // A row with several columns of figures is a reconciliation, not a statement of guidance: which
  // column is "the guide" is ambiguous, and picking wrongly produces a false raised/lowered.
  if (g.quote.split(" | ").length > MAX_GUIDANCE_ROW_CELLS) {
    errors.push(`${name}: quote is a multi-column table row - use the company's own statement of the guide, or leave it out`);
  }

  const found = locateQuote(vc.text, g.quote);
  if (!found) errors.push(`${name}: quote not found verbatim in the document - re-extract with an exact quote`);

  const unit = METRIC_DEFS[g.metric]?.unit ?? "usd";
  if (found && g.low !== null && g.high !== null && !guidanceValuesInQuote(g.low, g.high, unit, g.quote, vc.text, found.start, unsigned)) {
    errors.push(`${name}: low/high ${g.low}/${g.high} do not appear in the quote`);
  }

  if (errors.length || !parsed.success || !found) return { ok: false, item: g, errors };
  return { ok: true, item: parsed.data, charStart: found.start, charEnd: found.end };
}

function sanityErrors(m: LlmMetric, vc: ValidationContext): string[] {
  const errors: string[] = [];
  if (m.unit === "percent" && (m.value < -100 || m.value > 100)) errors.push(`${label(m)}: margin outside -100..100`);
  if (m.unit === "usd_per_share" && Math.abs(m.value) >= 1000) errors.push(`${label(m)}: EPS magnitude implausible`);
  if (m.unit === "usd" && Math.abs(m.value) >= 1e13) errors.push(`${label(m)}: dollar value implausible`);
  // The period type must fit the document's period (§18).
  const isQ4 = vc.fiscalPeriod.endsWith("Q4");
  if (m.periodType === "full_year" && !isQ4) errors.push(`${label(m)}: full-year figure in a ${vc.fiscalPeriod} document`);
  if (vc.docType === "filing_10k" && m.periodType === "ytd") errors.push(`${label(m)}: a 10-K has no year-to-date period`);
  return errors;
}

/** Whitespace, quote and dash variants a model may normalise when copying text. */
function normalizeChar(ch: string): string {
  if (/\s/.test(ch)) return " ";
  if ("‘’‛′".includes(ch)) return "'";
  if ("“”‟″".includes(ch)) return '"';
  if ("‐‑‒–—−".includes(ch)) return "-";
  return ch;
}

function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = normalizeChar(s[i]!);
    if (c === " " && norm.endsWith(" ")) continue;
    norm += c;
    map.push(i);
  }
  return { norm, map };
}

/** Offsets of `quote` in `text`, ignoring whitespace runs and typographic quote/dash variants. */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const q = normalizeWithMap(quote.trim()).norm;
  if (q.length < 10) return null;
  const { norm, map } = normalizeWithMap(text);
  const at = norm.indexOf(q);
  if (at < 0) return null;
  return { start: map[at]!, end: map[at + q.length - 1]! + 1 };
}

/** Values a written number can stand for, given scale words and the table caption in force. */
function candidates(t: NumberToken, unit: string, captionScale: number | null): { value: number; slack: number }[] {
  const rounding = 0.5 * 10 ** -t.decimals;
  if (unit === "percent") return [{ value: t.value, slack: rounding }];
  if (unit === "usd_per_share") return [{ value: t.value, slack: rounding }];
  const out = [{ value: t.value * t.scale, slack: rounding * t.scale }];
  if (t.scale === 1 && captionScale) out.push({ value: t.value * captionScale, slack: rounding * captionScale });
  return out;
}

function captionScaleAt(text: string, quoteStart: number, quote: string): number | null {
  return tableScaleIn(quote) ?? tableScaleIn(text.slice(Math.max(0, quoteStart - SCALE_LOOKBACK), quoteStart));
}

export function valueInQuote(value: number, unit: string, quote: string, text: string, quoteStart: number, unsigned = false): boolean {
  const scale = captionScaleAt(text, quoteStart, quote);
  return findNumbers(quote).some((t) =>
    candidates(t, unit, scale).some((c) =>
      approxEqual(unsigned ? Math.abs(c.value) : c.value, value, VALUE_TOLERANCE, c.slack),
    ),
  );
}

/**
 * Guidance bounds appear in the quote either directly ("$63 billion to $67 billion") or as a
 * midpoint with a stated spread ("$65.0 billion, plus or minus 2%" / "plus or minus 50 basis points").
 */
function guidanceValuesInQuote(low: number, high: number, unit: string, quote: string, text: string, start: number, unsigned = false): boolean {
  if (valueInQuote(low, unit, quote, text, start, unsigned) && valueInQuote(high, unit, quote, text, start, unsigned)) return true;
  const mid = (low + high) / 2;
  if (!valueInQuote(mid, unit, quote, text, start, unsigned)) return false;
  const pct = /plus or minus\s+(\d+(?:\.\d+)?)\s*%/i.exec(quote);
  if (pct) {
    const d = (Math.abs(mid) * Number(pct[1])) / 100;
    return approxEqual(low, mid - d, VALUE_TOLERANCE) && approxEqual(high, mid + d, VALUE_TOLERANCE);
  }
  const bps = /plus or minus\s+(\d+)\s*basis points/i.exec(quote);
  if (bps && unit === "percent") {
    const d = Number(bps[1]) / 100;
    return approxEqual(low, mid - d, 0, 1e-9) && approxEqual(high, mid + d, 0, 1e-9);
  }
  return false;
}
