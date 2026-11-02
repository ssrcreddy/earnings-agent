import { describe, expect, it } from "vitest";
import { compareGuidance, deriveQ4, priorYearPeriod, verdictFor, yoyChange, type GuideValues } from "./compare";

describe("verdictFor", () => {
  it("is no_consensus without a snapshot - never a substitute", () => {
    expect(verdictFor("revenue", 100, null)).toEqual({ verdict: "no_consensus", surprisePct: null, surprisePoints: null });
  });

  it("applies the ±1% revenue band", () => {
    expect(verdictFor("revenue", 102, 100).verdict).toBe("beat");
    expect(verdictFor("revenue", 98, 100).verdict).toBe("miss");
    expect(verdictFor("revenue", 100.5, 100).verdict).toBe("inline");
  });

  it("treats exactly the band edge as inline, with no float error", () => {
    // 1.01 / 1.00 in floating point is 0.010000000000000009 - beyond the band. Decimal keeps it exact.
    expect(verdictFor("revenue", "1.01", "1.00").verdict).toBe("inline");
    expect(verdictFor("revenue", "4040000000", "4000000000").verdict).toBe("inline");
    expect(verdictFor("revenue", "4040000001", "4000000000").verdict).toBe("beat");
  });

  it("applies the ±2% EPS band and reports the surprise", () => {
    expect(verdictFor("eps_adj", 1.03, 1.0)).toEqual({ verdict: "beat", surprisePct: "0.03", surprisePoints: null });
    expect(verdictFor("eps_adj", 1.02, 1.0).verdict).toBe("inline");
    expect(verdictFor("eps_gaap", 0.97, 1.0).verdict).toBe("miss");
  });

  it("measures margins in points (±0.5 pt), not percent", () => {
    expect(verdictFor("gross_margin", 75.0, 74.4)).toEqual({ verdict: "beat", surprisePct: null, surprisePoints: "0.6" });
    expect(verdictFor("gross_margin", 75.0, 74.5).verdict).toBe("inline");
    expect(verdictFor("gross_margin", 73.9, 74.5).verdict).toBe("miss");
  });

  it("handles losses and negative consensus by magnitude", () => {
    // Consensus loss of 0.50 per share; actual loss of 0.40 is better: a beat.
    expect(verdictFor("eps_gaap", -0.4, -0.5).verdict).toBe("beat");
    expect(verdictFor("eps_gaap", -0.6, -0.5).verdict).toBe("miss");
  });

  it("uses direction only when consensus is zero", () => {
    expect(verdictFor("net_income", 5, 0).verdict).toBe("beat");
    expect(verdictFor("net_income", -5, 0).verdict).toBe("miss");
    expect(verdictFor("net_income", 0, 0).verdict).toBe("inline");
  });
});

describe("compareGuidance", () => {
  const g = (id: string, kind: GuideValues["kind"], low: number | null, high: number | null): GuideValues => ({ id, kind, low, high });

  it("is new without a previous guide (including when the target period rolled forward)", () => {
    expect(compareGuidance(g("n", "range", 1, 2), null).change).toBe("new");
  });

  it("detects withdrawal", () => {
    const r = compareGuidance(g("n", "withdrawn", null, null), g("p", "range", 100, 110));
    expect(r.change).toBe("withdrawn");
    expect(r.inputs.prevId).toBe("p");
  });

  it("never labels qualitative guidance", () => {
    expect(compareGuidance(g("n", "qualitative", null, null), g("p", "range", 1, 2)).change).toBeNull();
    expect(compareGuidance(g("n", "qualitative", null, null), null).change).toBeNull();
  });

  it("treats the first numeric guide after a qualitative one as new", () => {
    expect(compareGuidance(g("n", "range", 1, 2), g("p", "qualitative", null, null)).change).toBe("new");
  });

  it("raises and lowers on midpoint moves beyond 0.5% of the previous midpoint", () => {
    expect(compareGuidance(g("n", "range", 102, 112), g("p", "range", 100, 110)).change).toBe("raised");
    expect(compareGuidance(g("n", "range", 98, 108), g("p", "range", 100, 110)).change).toBe("lowered");
  });

  it("keeps small midpoint moves as maintained, exactly at the tolerance edge too", () => {
    // Previous midpoint 105 -> tolerance 0.525; a 0.5 move is within it.
    expect(compareGuidance(g("n", "range", 100.5, 110.5), g("p", "range", 100, 110)).change).toBe("maintained");
    expect(compareGuidance(g("n", "range", 100.525, 110.525), g("p", "range", 100, 110)).change).toBe("maintained");
  });

  it("narrows and widens around a steady midpoint", () => {
    expect(compareGuidance(g("n", "range", 101, 109), g("p", "range", 100, 110)).change).toBe("narrowed");
    expect(compareGuidance(g("n", "range", 99, 111), g("p", "range", 100, 110)).change).toBe("widened");
  });

  it("compares a point guide to a range by midpoint", () => {
    expect(compareGuidance(g("n", "point", 105, 105), g("p", "range", 100, 110)).change).toBe("narrowed");
    expect(compareGuidance(g("n", "point", 110, 110), g("p", "range", 100, 110)).change).toBe("raised");
  });

  it("records every input used, so the label can be re-derived", () => {
    const r = compareGuidance(g("n", "range", 3.925e9, 4.725e9), g("p", "range", 3.925e9, 4.725e9));
    expect(r).toEqual({
      change: "maintained",
      inputs: {
        newId: "n",
        prevId: "p",
        newLow: "3925000000",
        newHigh: "4725000000",
        prevLow: "3925000000",
        prevHigh: "4725000000",
        midpointDelta: "0",
        widthDelta: "0",
        tolerance: "21625000",
        rule: "midpoint and width within tolerance",
      },
    });
  });
});

describe("helpers", () => {
  it("computes year-over-year change", () => {
    expect(yoyChange(305, 327)).toBe("-0.067278");
    expect(yoyChange(305, null)).toBeNull();
    expect(yoyChange(305, 0)).toBeNull();
  });

  it("derives Q4 as full year minus nine months (fix 6)", () => {
    expect(deriveQ4("17000000000", "12500000000")).toBe("4500000000");
    expect(deriveQ4(null, "1")).toBeNull();
  });

  it("finds the same quarter a year earlier", () => {
    expect(priorYearPeriod("2026-Q2")).toBe("2025-Q2");
  });
});
