import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmGuidance, LlmMetric } from "@eia/shared";
import { describe, expect, it } from "vitest";
import { parseHeadlineTable } from "../parsing/headline";
import { cleanHtml } from "../parsing/html";
import { labelSections } from "../parsing/sections";
import { factValues } from "./companyFacts";
import { locateQuote, validateGuidance, validateMetric, type ValidationContext } from "./validate";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/edgar");

function context(file: string, fiscalPeriod: string, periodEnd: string, facts: unknown = null): ValidationContext {
  const clean = cleanHtml(readFileSync(path.join(fixtures, file), "utf8"));
  const blocks = labelSections("press_release", clean.blocks);
  return {
    text: clean.text,
    docType: "press_release",
    fiscalPeriod,
    periodEnd: new Date(`${periodEnd}T00:00:00Z`),
    facts: facts as ValidationContext["facts"],
    headline: parseHeadlineTable(clean.text, blocks),
  };
}

const nvda = context("nvda_2027q2_ex991.htm", "2027-Q2", "2026-07-31");
const vstFacts = JSON.parse(readFileSync(path.join(fixtures, "companyfacts_VST_trimmed.json"), "utf8"));
const vst = context("vst_2026q2_ex991.htm", "2026-Q2", "2026-06-30", vstFacts);

const metric = (m: Partial<LlmMetric>): LlmMetric => ({
  name: "revenue",
  segment: null,
  value: 96_221_000_000,
  unit: "usd",
  periodType: "quarter",
  quote: "Revenue | $96,221 | $81,615 | $46,743 | 18% | 106%",
  confidence: 0.95,
  ...m,
});

describe("locateQuote", () => {
  it("finds quotes despite whitespace and typographic quote/dash differences", () => {
    const text = "NVIDIA’s outlook — revenue is\n\nexpected to be $65.0 billion.";
    const hit = locateQuote(text, "NVIDIA's outlook - revenue is expected to be $65.0 billion");
    expect(hit).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe("NVIDIA’s outlook — revenue is\n\nexpected to be $65.0 billion");
  });

  it("rejects text that is not in the document", () => {
    expect(locateQuote("Revenue was $4.0 billion.", "Revenue was $5.0 billion")).toBeNull();
  });
});

describe("validateMetric", () => {
  it("accepts a headline-table row with the table's millions scale", () => {
    const v = validateMetric(metric({}), nvda);
    expect(v.ok).toBe(true);
    if (v.ok) expect(nvda.text.slice(v.charStart, v.charEnd)).toBe(metric({}).quote);
  });

  it("accepts EPS and gross margin in their own units", () => {
    expect(
      validateMetric(
        metric({ name: "eps_gaap", unit: "usd_per_share", value: 2.46, quote: "Diluted earnings per share | $2.46 | $2.39 | $1.08 | 3% | 128%" }),
        nvda,
      ).ok,
    ).toBe(true);
    expect(
      validateMetric(
        metric({ name: "gross_margin", unit: "percent", value: 75, quote: "Gross margin | 75.0% | 74.9% | 72.4% | 0.1 pts | 2.6 pts" }),
        nvda,
      ).ok,
    ).toBe(true);
  });

  it("rejects a quote that is not in the document", () => {
    const v = validateMetric(metric({ quote: "Revenue was a record $96.2 billion, up 200% from a year ago." }), nvda);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/quote not found verbatim/);
  });

  it("rejects a value that is not in its quote (the wrong column)", () => {
    const v = validateMetric(metric({ value: 81_615_000_000 * 1.5 }), nvda);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/does not appear in its quote/);
  });

  it("flags a disagreement with the headline table and keeps the regex value for review", () => {
    // Prior-quarter column: in the quote, but not this quarter's figure.
    const v = validateMetric(metric({ value: 81_615_000_000 }), nvda);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.regexValue).toBe(96_221_000_000);
      expect(v.errors.join(" ")).toMatch(/disagrees with the headline table/);
    }
  });

  it("rejects the wrong unit, schema violations and impossible periods", () => {
    const wrongUnit = validateMetric(metric({ unit: "percent" }), nvda);
    expect(!wrongUnit.ok && wrongUnit.errors.join(" ")).toMatch(/unit must be usd/);
    const lowConfidence = validateMetric(metric({ confidence: 1.5 }), nvda);
    expect(lowConfidence.ok).toBe(false);
    const fullYear = validateMetric(metric({ periodType: "full_year" }), nvda);
    expect(!fullYear.ok && fullYear.errors.join(" ")).toMatch(/full-year figure in a 2027-Q2 document/);
  });

  it("confirms a value through company facts when the quote rounds it differently", () => {
    expect(factValues(vstFacts, "net_income", "quarter", vst.periodEnd, "2026-Q2")).toContain(305_000_000);
    const quote = "Net income | $305 | $327 | $1,334 | $59";
    expect(validateMetric(metric({ name: "net_income", value: 305_000_000, quote }), vst).ok).toBe(true);
  });
});

describe("factValues", () => {
  it("matches year to date by the quarter it runs to, never a single quarter", () => {
    // Regression: a Q2 year-to-date check accepted the three-month value too.
    expect(factValues(vstFacts, "net_income", "ytd", vst.periodEnd, "2026-Q2")).toEqual([1_334_000_000]);
    expect(factValues(vstFacts, "net_income", "quarter", vst.periodEnd, "2026-Q2")).toEqual([305_000_000]);
  });
});

describe("validateGuidance", () => {
  const outlook = nvda.text.slice(nvda.text.indexOf("Revenue is expected to be"));
  const revenueLine = outlook.slice(0, outlook.indexOf("\n"));
  const guide = (g: Partial<LlmGuidance>): LlmGuidance => ({
    metric: "revenue",
    kind: "range",
    low: null,
    high: null,
    targetPeriod: "2027-Q3",
    quote: revenueLine,
    confidence: 0.9,
    ...g,
  });

  it("accepts a midpoint guide stated with plus or minus a percentage", () => {
    const [mid] = revenueLine.match(/\$([\d.]+) billion/)!.slice(1).map(Number);
    const m = mid! * 1e9;
    const v = validateGuidance(guide({ low: m * 0.98, high: m * 1.02 }), nvda);
    expect(v.ok).toBe(true);
  });

  it("rejects bounds that the quote does not support", () => {
    const v = validateGuidance(guide({ low: 1e9, high: 2e9 }), nvda);
    expect(v.ok).toBe(false);
  });

  it("checks that the shape matches the kind", () => {
    expect(validateGuidance(guide({ kind: "point", low: 1, high: 2 }), nvda).ok).toBe(false);
    expect(validateGuidance(guide({ kind: "qualitative", low: 1, high: 1 }), nvda).ok).toBe(false);
    expect(validateGuidance(guide({ kind: "qualitative" }), nvda).ok).toBe(true);
  });

  it("rejects malformed and out-of-range target periods", () => {
    expect(validateGuidance(guide({ kind: "qualitative", targetPeriod: "FY27" }), nvda).ok).toBe(false);
    expect(validateGuidance(guide({ kind: "qualitative", targetPeriod: "2031-FY" }), nvda).ok).toBe(false);
  });
});
