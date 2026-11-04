import type { LlmExtractionResult, LlmGuidance } from "@eia/shared";
import { describe, expect, it } from "vitest";
import { runExtraction, type ModelCall } from "./extraction";
import type { ValidationContext } from "./validate";

// The VST pattern: the guidance line states one range; a reconciliation table further down states an
// adjusted range for the same item. Both quotes are real and valid on their own.
const GUIDE_LINE = "We reaffirm 2026 free cash flow guidance of $3.925 billion to $4.725 billion.";
const ADJUSTED_ROW = "Adjusted free cash flow guidance | $3,760 | $4,560";
const filler = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} describes the business in general terms.`).join("\n\n");
const text = `${GUIDE_LINE}\n\n${filler}\n\n(Millions of Dollars)\n\n${ADJUSTED_ROW}`;

const vc: ValidationContext = {
  text,
  docType: "press_release",
  fiscalPeriod: "2026-Q2",
  periodEnd: new Date("2026-06-30T00:00:00Z"),
  facts: null,
  headline: [],
};

const guide = (low: number, high: number, quote: string): LlmGuidance => ({
  metric: "fcf",
  kind: "range",
  low,
  high,
  targetPeriod: "2026-FY",
  quote,
  confidence: 0.9,
});

/** Answers per window: whichever of the two statements the window contains. */
function modelFor(adjusted: { low: number; high: number; quote: string }): ModelCall {
  return async (input) => {
    const result: LlmExtractionResult = { metrics: [], guidance: [] };
    if (input.includes(GUIDE_LINE)) result.guidance.push(guide(3.925e9, 4.725e9, GUIDE_LINE));
    if (input.includes(ADJUSTED_ROW)) result.guidance.push(guide(adjusted.low, adjusted.high, adjusted.quote));
    return result;
  };
}

describe("runExtraction across windows", () => {
  it("sends two different values for the same guide to review instead of picking one", async () => {
    const outcome = await runExtraction(modelFor({ low: 3.76e9, high: 4.56e9, quote: ADJUSTED_ROW }), [{ header: "h", text }], vc, 120);
    expect(outcome.calls).toBeGreaterThan(1); // the two statements landed in different windows
    expect(outcome.guidance).toEqual([]);
    expect(outcome.failures).toHaveLength(1);
    const [f] = outcome.failures;
    expect(f!.kind).toBe("guidance");
    expect(f!.errors[0]).toMatch(/states different values for the same item/);
    expect(f!.errors[0]).toContain("3925000000..4725000000");
    expect(f!.errors[0]).toContain("3760000000..4560000000");
  });

  it("merges windows that agree into one item", async () => {
    // Same range stated twice (the line, and a table row with the same figures).
    const sameRow = "Adjusted free cash flow guidance | $3,760 | $4,560";
    const outcome = await runExtraction(
      async (input) => {
        const r: LlmExtractionResult = { metrics: [], guidance: [] };
        if (input.includes(GUIDE_LINE)) r.guidance.push(guide(3.925e9, 4.725e9, GUIDE_LINE));
        if (input.includes(sameRow)) r.guidance.push(guide(3.925e9 * 1.0001, 4.725e9, GUIDE_LINE));
        return r;
      },
      [{ header: "h", text }],
      vc,
      120,
    );
    expect(outcome.failures).toEqual([]);
    expect(outcome.guidance).toHaveLength(1);
    expect(outcome.guidance[0]!.item).toMatchObject({ low: 3.925e9, high: 4.725e9 });
  });
});
