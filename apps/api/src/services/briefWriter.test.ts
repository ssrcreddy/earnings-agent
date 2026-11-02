import { describe, expect, it } from "vitest";
import { checkBrief } from "./briefCheck";
import { briefInput, renderTemplateBrief, writeBrief } from "./briefWriter";
import type { FactSheet } from "./factSheet";

const QUOTE =
  "Ongoing Operations Adjusted FCFbG1 guidance ranges of $6.8 billion to $7.6 billion and $3.925 billion to $4.725 billion";

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
    {
      id: "M2",
      rowId: "m-2",
      name: "net_income",
      segment: null,
      periodType: "ytd",
      unit: "usd",
      value: 1334e6,
      derived: false,
      verdict: null,
      consensus: null,
      consensusProvider: null,
      surprisePct: null,
      surprisePoints: null,
      priorYear: 59e6,
      yoyPct: 21.610169,
      quote: "Net income | $305 | $327 | $1,334 | $59",
    },
    {
      id: "M3",
      rowId: "m-3",
      name: "revenue",
      segment: null,
      periodType: "quarter",
      unit: "usd",
      value: 4.6e9,
      derived: false,
      verdict: "no_consensus",
      consensus: null,
      consensusProvider: null,
      surprisePct: null,
      surprisePoints: null,
      priorYear: null,
      yoyPct: null,
      quote: "Operating revenues | $4,600",
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
      previous: { low: 3.925e9, high: 4.725e9, fiscalPeriod: "2026-Q1", quote: QUOTE },
      fromQa: false,
      quote: QUOTE,
    },
  ],
};

describe("renderTemplateBrief", () => {
  const body = renderTemplateBrief(sheet);

  it("follows the fixed shape: headline, results, guidance, management, watch items", () => {
    const sections = body.split("\n").filter((l) => l.startsWith("###"));
    expect(sections).toEqual(["### Results", "### Guidance", "### What management said", "### Watch items"]);
    expect(body.split("\n")[0]).toBe(
      "**VST 2026-Q2:** revenue $4.6 billion; fiscal 2026 free cash flow guidance maintained [M3][G1]",
    );
  });

  it("states verdicts against a named provider and falls back to the prior year", () => {
    expect(body).toContain(
      "- Net income: $305 million, beat consensus (finnhub) of $290 million, a surprise of +5.2%; $327 million a year earlier (-6.7%) [M1]",
    );
    expect(body).toContain("- Net income (year to date): $1.334 billion, versus $59 million a year earlier (+2161.0%) [M2]");
    expect(body).toContain("- No consensus on record for revenue [M3]");
  });

  it("quotes management verbatim and uses the computed guidance label", () => {
    expect(body).toContain("- Free cash flow for fiscal 2026: $3.925 billion to $4.725 billion, maintained [G1]");
    expect(body).toContain(`- "${QUOTE}" [G1]`);
  });

  it("always passes its own post-check", () => {
    expect(checkBrief(body, sheet)).toMatchObject({ ok: true, cited: ["M3", "G1", "M1", "M2"] });
  });
});

describe("writeBrief", () => {
  it("publishes a draft that passes", async () => {
    const r = await writeBrief(sheet, async () => renderTemplateBrief(sheet));
    expect(r).toMatchObject({ ok: true, attempts: 1 });
  });

  it("regenerates once with the checker's errors, then publishes", async () => {
    const seen: (string[] | null)[] = [];
    const r = await writeBrief(sheet, async (_s, errors) => {
      seen.push(errors);
      return errors ? renderTemplateBrief(sheet) : "**VST:** net income $999 million [M1]";
    });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(seen[1]!.join(" ")).toMatch(/\$999 million.*not a fact-sheet value/);
  });

  it("withholds the brief after a second failure", async () => {
    const r = await writeBrief(sheet, async () => "VST is undervalued; buy before Q3 [M1].");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/recommendation language/);
  });
});

describe("briefInput", () => {
  it("hands the writer display strings, not raw numbers, and appends errors on retry", () => {
    const input = briefInput(sheet, ["states \"$999 million\", which is not a fact-sheet value"]);
    expect(input).toContain('"value": "$305 million"');
    expect(input).toContain('"surprise": "+5.2%"');
    expect(input).not.toContain("305000000");
    expect(input).toMatch(/previous draft was rejected[\s\S]*\$999 million/);
  });
});
