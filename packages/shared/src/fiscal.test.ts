import { describe, expect, it } from "vitest";
import { fiscalPeriodOf, quarterReportedBy } from "./fiscal";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("fiscalPeriodOf", () => {
  it("handles a calendar-year company", () => {
    expect(fiscalPeriodOf(d("2026-03-31"), "1231").label).toBe("2026-Q1");
    expect(fiscalPeriodOf(d("2025-12-31"), "1231").label).toBe("2025-Q4");
  });

  it("handles AAPL (52/53-week year ending late September)", () => {
    expect(fiscalPeriodOf(d("2025-09-27"), "0927").label).toBe("2025-Q4");
    expect(fiscalPeriodOf(d("2025-12-27"), "0927").label).toBe("2026-Q1");
    expect(fiscalPeriodOf(d("2025-06-28"), "0927").label).toBe("2025-Q3");
  });

  it("handles NVDA (fiscal year ending late January, named for the year it ends)", () => {
    expect(fiscalPeriodOf(d("2025-10-26"), "0126").label).toBe("2026-Q3");
    expect(fiscalPeriodOf(d("2025-01-26"), "0126").label).toBe("2025-Q4");
    expect(fiscalPeriodOf(d("2025-04-27"), "0126").label).toBe("2026-Q1");
  });

  it("handles NVDA as EDGAR actually reports it (FYE 0131, 52/53-week year ending late January)", () => {
    expect(fiscalPeriodOf(d("2025-10-26"), "0131").label).toBe("2026-Q3");
    expect(fiscalPeriodOf(d("2025-04-27"), "0131").label).toBe("2026-Q1");
    expect(fiscalPeriodOf(d("2026-01-25"), "0131").label).toBe("2026-Q4");
  });

  it("handles MSFT (June year end, month-end quarters)", () => {
    expect(fiscalPeriodOf(d("2025-09-30"), "0630").label).toBe("2026-Q1");
    expect(fiscalPeriodOf(d("2025-12-31"), "0630").label).toBe("2026-Q2");
    expect(fiscalPeriodOf(d("2025-06-30"), "0630").label).toBe("2025-Q4");
  });

  it("rejects dates nowhere near a quarter end", () => {
    expect(() => fiscalPeriodOf(d("2025-08-15"), "1231")).toThrow();
  });

  it("rejects malformed fiscal year ends", () => {
    expect(() => fiscalPeriodOf(d("2025-12-31"), "13xx")).toThrow();
  });
});

describe("quarterReportedBy", () => {
  it("maps an earnings 8-K filing date to the quarter just ended", () => {
    expect(quarterReportedBy(d("2025-11-19"), "0126").label).toBe("2026-Q3"); // NVDA
    expect(quarterReportedBy(d("2025-10-30"), "0927").label).toBe("2025-Q4"); // AAPL
    expect(quarterReportedBy(d("2025-10-29"), "0630").label).toBe("2026-Q1"); // MSFT
    expect(quarterReportedBy(d("2026-02-05"), "1231").label).toBe("2025-Q4");
  });

  it("does not pick a quarter that ended only days before the filing", () => {
    expect(quarterReportedBy(d("2026-04-02"), "1231").label).toBe("2025-Q4");
  });
});
