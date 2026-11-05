// Rules added after reading the first real brief (VST Q2 2026).
import type { LlmGuidance, LlmMetric } from "@eia/shared";
import { describe, expect, it } from "vitest";
import { findNumbers } from "../parsing/numbers";
import { checkBrief } from "./briefCheck";
import { briefInput, renderTemplateBrief } from "./briefWriter";
import { isReportableSegment, selectBriefMetrics, statementQuote, type FactSheet } from "./factSheet";
import { validateGuidance, validateMetric, type ValidationContext } from "./validate";

const TABLE = "(Millions of Dollars)\n\nCapital expenditures, including nuclear fuel | (1,572) | (1,104)\nCapital expenditures guidance | (1,536) | (1,536)";
const vc: ValidationContext = {
  text: TABLE,
  docType: "press_release",
  fiscalPeriod: "2026-Q2",
  periodEnd: new Date("2026-06-30T00:00:00Z"),
  facts: null,
  headline: [],
};

describe("capex sign", () => {
  const metric: LlmMetric = {
    name: "capex",
    segment: null,
    value: -1_572_000_000,
    unit: "usd",
    periodType: "ytd",
    quote: "Capital expenditures, including nuclear fuel | (1,572) | (1,104)",
    confidence: 0.9,
  };

  it("stores spending as a positive amount, whichever sign the model returned", () => {
    for (const value of [-1_572_000_000, 1_572_000_000]) {
      const v = validateMetric({ ...metric, value }, vc);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.item.value).toBe(1_572_000_000);
    }
  });

  it("still rejects a capex figure that is not in its quote", () => {
    expect(validateMetric({ ...metric, value: 2_000_000_000 }, vc).ok).toBe(false);
  });

  it("normalises capex guidance the same way", () => {
    const guide: LlmGuidance = {
      metric: "capex",
      kind: "point",
      low: -1_536_000_000,
      high: -1_536_000_000,
      targetPeriod: "2026-FY",
      quote: "Capital expenditures guidance | (1,536) | (1,536)",
      confidence: 0.9,
    };
    const v = validateGuidance(guide, vc);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.item).toMatchObject({ low: 1_536_000_000, high: 1_536_000_000 });
  });

  it("refuses guidance taken from a multi-column reconciliation row", () => {
    // Regression: the eval caught a false "lowered" from VST's adjusted column in such a row.
    const row = "Adjusted free cash flow before growth guidance | $3,925 | $4,725 | $(165) | $(165) | $3,760 | $4,560";
    const text = `(Millions of Dollars)

${row}

Ongoing Operations Adjusted FCFbG | $3,925 - $4,725`;
    const guide: LlmGuidance = { metric: "fcf", kind: "range", low: 3.76e9, high: 4.56e9, targetPeriod: "2026-FY", quote: row, confidence: 0.9 };
    const v = validateGuidance(guide, { ...vc, text });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/multi-column table row/);
    const summary = validateGuidance(
      { ...guide, low: 3.925e9, high: 4.725e9, quote: "Ongoing Operations Adjusted FCFbG | $3,925 - $4,725" },
      { ...vc, text },
    );
    expect(summary.ok).toBe(true);
  });

  it("reads a dash between two figures as a range, and a leading dash as a minus", () => {
    expect(findNumbers("$3,925 - $4,725").map((n) => n.value)).toEqual([3925, 4725]);
    expect(findNumbers("$63 billion - $67 billion").map((n) => n.value)).toEqual([63, 67]);
    expect(findNumbers("Net loss | -$305").map((n) => n.value)).toEqual([-305]);
  });

  it("leaves signs alone for other metrics: a loss stays a loss", () => {
    const v = validateMetric(
      { ...metric, name: "net_income", value: 1_572_000_000, quote: "Capital expenditures, including nuclear fuel | (1,572) | (1,104)" },
      vc,
    );
    expect(v.ok).toBe(false);
  });
});

describe("what a brief covers", () => {
  it("treats totals and eliminations as table columns, not segments", () => {
    for (const s of ["Ongoing Operations Consolidated", "Eliminations / Corp and Other", "Corporate and Other", "Total"]) {
      expect(isReportableSegment(s)).toBe(false);
    }
    for (const s of ["Retail", "Texas", "Asset Closure", "Data Center"]) expect(isReportableSegment(s)).toBe(true);
  });

  it("keeps company-wide figures and real quarterly segments, and leaves year to date off the page", () => {
    const m = (periodType: string, segment: string | null) => ({ periodType, segment });
    const rows = [
      m("quarter", null),
      m("ytd", null),
      m("full_year", null),
      m("quarter", "Retail"),
      m("ytd", "Retail"),
      m("quarter", "Ongoing Operations Consolidated"),
    ];
    expect(selectBriefMetrics(rows)).toEqual([m("quarter", null), m("full_year", null), m("quarter", "Retail")]);
  });

  it("caps segments so a brief stays on one page", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ periodType: "quarter", segment: `Segment ${i}` }));
    expect(selectBriefMetrics(rows)).toHaveLength(6);
  });

  it("still returns something when a document has only year-to-date figures", () => {
    const rows = [{ periodType: "ytd", segment: null }];
    expect(selectBriefMetrics(rows)).toEqual(rows);
  });
});

describe("brief wording", () => {
  const sheet: FactSheet = {
    ticker: "VST",
    companyName: "Vistra Corp.",
    fiscalPeriod: "2026-Q2",
    reportDate: "2026-08-07T11:00:25.000Z",
    metrics: [
      {
        id: "M1",
        rowId: "m",
        name: "revenue",
        segment: null,
        periodType: "quarter",
        unit: "usd",
        value: 4.017e9,
        derived: false,
        verdict: null,
        consensus: null,
        consensusProvider: null,
        surprisePct: null,
        surprisePoints: null,
        priorYear: null,
        yoyPct: null,
        quote: "Operating revenues | $4,017 | $4,250",
      },
    ],
    guidance: [
      {
        id: "G1",
        rowId: "g",
        metric: "fcf",
        kind: "range",
        targetPeriod: "2026-FY",
        low: 3.925e9,
        high: 4.725e9,
        change: "new",
        changeNote: "first on record (earlier quarters are not processed yet)",
        previous: null,
        fromQa: false,
        quote: "Adjusted free cash flow before growth guidance | $3,925 | $4,725",
      },
    ],
  };

  it("states a figure with no comparison plainly", () => {
    expect(renderTemplateBrief(sheet)).toContain("- Revenue: $4.017 billion [M1]");
  });

  it("does not call a guide new when earlier quarters simply aren't processed", () => {
    const body = renderTemplateBrief(sheet);
    expect(body).toContain("$3.925 billion to $4.725 billion, first on record (earlier quarters are not processed yet) [G1]");
    expect(body).not.toMatch(/new guidance/);
  });

  it("never presents a table row as something management said", () => {
    expect(statementQuote("Net income | $305 | $327")).toBeNull();
    expect(statementQuote("We reaffirmed our 2026 guidance.")).toBe("We reaffirmed our 2026 guidance.");
    expect(renderTemplateBrief(sheet)).not.toContain("What management said");
    expect(JSON.parse(briefInput(sheet, null).replace(/<\/?fact_sheet>/g, "")).guidance[0].quote).toBeNull();
  });

  it("fails a draft that talks about its own inputs", () => {
    expect(checkBrief("- Revenue was $4.017 billion, not in the fact sheet [M1]", sheet).errors.join(" ")).toMatch(/write for the reader/);
  });

  it("the template passes its own check", () => {
    expect(checkBrief(renderTemplateBrief(sheet), sheet)).toMatchObject({ ok: true });
  });
});
