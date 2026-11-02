import { describe, expect, it } from "vitest";
import { checkBrief } from "./briefCheck";
import { formatFigure, formatGuide, formatPct, type FactSheet } from "./factSheet";

const sheet: FactSheet = {
  ticker: "VST",
  companyName: "Vistra Corp.",
  fiscalPeriod: "2026-Q2",
  reportDate: "2026-08-07T11:00:25.000Z",
  metrics: [
    {
      id: "M1",
      rowId: "m-1",
      name: "net_income",
      segment: null,
      periodType: "quarter",
      unit: "usd",
      value: 305e6,
      derived: false,
      verdict: "beat",
      consensus: 290e6,
      consensusProvider: "finnhub",
      surprisePct: 0.051724,
      surprisePoints: null,
      priorYear: 327e6,
      yoyPct: -0.067278,
      quote: "Net income | $305 | $327 | $1,334 | $59",
    },
  ],
  guidance: [
    {
      id: "G1",
      rowId: "g-1",
      metric: "fcf",
      kind: "range",
      targetPeriod: "2026-FY",
      low: 3.925e9,
      high: 4.725e9,
      change: "maintained",
      previous: { low: 3.925e9, high: 4.725e9, fiscalPeriod: "2026-Q1", quote: "..." },
      fromQa: false,
      quote: "guidance ranges of ... $3.925 billion to $4.725 billion",
    },
  ],
};

describe("formatting", () => {
  it("writes figures the way briefs do", () => {
    expect(formatFigure(305e6, "usd")).toBe("$305 million");
    expect(formatFigure(4.021e9, "usd")).toBe("$4.021 billion");
    expect(formatFigure(-27e6, "usd")).toBe("-$27 million");
    expect(formatFigure(2.46, "usd_per_share")).toBe("$2.46");
    expect(formatFigure(75, "percent")).toBe("75.0%");
    expect(formatPct(0.051724)).toBe("+5.2%");
    expect(formatGuide(3.925e9, 4.725e9, "usd")).toBe("$3.925 billion to $4.725 billion");
  });
});

describe("checkBrief", () => {
  it("passes a draft whose every figure is a cited fact-sheet value", () => {
    const draft = [
      "**VST 2026-Q2:** net income $305 million, ahead of consensus [M1].",
      "- Net income was $305 million versus $290 million expected (+5.2%) [M1].",
      "- Down 6.7% from $327 million a year earlier [M1].",
      "- Fiscal 2026 free cash flow guidance maintained at $3.925 billion to $4.725 billion [G1].",
    ].join("\n");
    expect(checkBrief(draft, sheet)).toEqual({ ok: true, errors: [], cited: ["M1", "G1"] });
  });

  it("rejects a number that is not in the fact sheet", () => {
    const r = checkBrief("- Net income was $310 million [M1].", sheet);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/\$310 million.*not a fact-sheet value/);
    // Rounding slack follows the decimals written: $306 million is not $305 million.
    expect(checkBrief("- Net income was $306 million [M1].", sheet).ok).toBe(false);
    expect(checkBrief("- Up 5.3% on consensus [M1].", sheet).ok).toBe(false);
  });

  it("rejects citations to facts that do not exist", () => {
    expect(checkBrief("- Net income was $305 million [M7].", sheet).errors).toContain(
      "cites M7, which is not in the fact sheet",
    );
  });

  it("rejects figures without a citation on the same line", () => {
    expect(checkBrief("- Net income was $305 million.", sheet).errors.join(" ")).toMatch(/has no citation/);
  });

  it("blocks recommendation language", () => {
    const r = checkBrief("- Net income beat [M1]; the stock looks undervalued with a price target upside.", sheet);
    expect(r.errors.join(" ")).toMatch(/recommendation language/);
  });

  it("allows other figures only inside a verbatim source quote", () => {
    const quoted = '- Management: "guidance ranges of ... $3.925 billion to $4.725 billion" [G1]';
    expect(checkBrief(quoted, sheet).ok).toBe(true);
    const invented = '- Management: "we expect revenue of $9 billion next year" [G1]';
    expect(checkBrief(invented, sheet).errors.join(" ")).toMatch(/not a fact's source quote/);
  });

  it("ignores years, fiscal labels and list numbers", () => {
    expect(checkBrief("1. In Q2 2026 and FY26 the company reported results [M1].", sheet).ok).toBe(true);
  });
});
