import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHeadlineTable } from "./headline";
import { cleanHtml } from "./html";
import { approxEqual, findNumbers, tableScaleIn } from "./numbers";
import { labelSections } from "./sections";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/edgar");
const release = (name: string) => {
  const clean = cleanHtml(readFileSync(path.join(fixtures, name), "utf8"));
  return { text: clean.text, blocks: labelSections("press_release", clean.blocks) };
};

describe("findNumbers", () => {
  it("reads currency, separators, decimals, negatives and scale words", () => {
    const [a] = findNumbers("Revenue was $4.02 billion");
    expect(a).toMatchObject({ value: 4.02, scale: 1e9, currency: true, decimals: 2 });
    expect(findNumbers("$96,221")[0]).toMatchObject({ value: 96221, scale: 1 });
    expect(findNumbers("$(27)")[0]!.value).toBe(-27);
    expect(findNumbers("(0.1) pts")[0]!.value).toBe(-0.1);
    expect(findNumbers("75.0%")[0]).toMatchObject({ value: 75, percent: true, decimals: 1 });
    expect(findNumbers("$305 million")[0]).toMatchObject({ value: 305, scale: 1e6 });
  });
});

describe("tableScaleIn", () => {
  it("recognises the usual captions", () => {
    expect(tableScaleIn("($ in millions, except earnings per share)")).toBe(1e6);
    expect(tableScaleIn("(Unaudited) (Millions of Dollars)")).toBe(1e6);
    expect(tableScaleIn("(in thousands, except per share data)")).toBe(1e3);
    expect(tableScaleIn("Three Months Ended June 30,")).toBeNull();
  });
});

describe("approxEqual", () => {
  it("accepts rounding of the figure as written", () => {
    expect(approxEqual(4_021_000_000, 4.02e9, 0.005)).toBe(true);
    expect(approxEqual(305, 365, 0.005)).toBe(false);
  });
});

describe("parseHeadlineTable", () => {
  it("reads NVIDIA's GAAP table: current-period column, millions scale, EPS and margin units", () => {
    const { text, blocks } = release("nvda_2027q2_ex991.htm");
    const figures = Object.fromEntries(parseHeadlineTable(text, blocks).map((f) => [f.metric, f]));
    expect(figures.revenue).toMatchObject({ value: 96_221_000_000, unit: "usd" });
    expect(figures.gross_margin).toMatchObject({ value: 75.0, unit: "percent" });
    expect(figures.op_income).toMatchObject({ value: 63_734_000_000, unit: "usd" });
    expect(figures.net_income).toMatchObject({ value: 59_688_000_000, unit: "usd" });
    expect(figures.eps_gaap).toMatchObject({ value: 2.46, unit: "usd_per_share" });
  });

  it("reads VST's table: net income only, scale from the text above, quarter column not YTD", () => {
    const { text, blocks } = release("vst_2026q2_ex991.htm");
    // VST's caption "(Millions of Dollars)" sits above the table, not in it.
    expect(parseHeadlineTable(text, blocks)).toEqual([
      { metric: "net_income", value: 305_000_000, unit: "usd", row: "Net income | $305 | $327 | $1,334 | $59" },
    ]);
  });
});
