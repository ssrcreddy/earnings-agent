import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanHtml, joinCells } from "./html";
import { findHeadlineTable, labelSections } from "./sections";

const fixture = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/edgar/vst_2026q2_ex991.htm"),
  "utf8",
);

describe("cleanHtml on a real EDGAR press release (VST Q2 2026, EX-99.1)", () => {
  const doc = cleanHtml(fixture);

  it("keeps every block's offsets consistent with the clean text", () => {
    expect(doc.blocks.length).toBeGreaterThan(100);
    for (const b of doc.blocks) expect(doc.text.slice(b.start, b.end)).toBe(b.text);
  });

  it("drops the EDGAR SGML wrapper fields, so the text starts at the title", () => {
    expect(doc.blocks[0]?.text).toBe("Vistra Reports Second Quarter 2026 Results");
    expect(doc.text).not.toMatch(/^EX-99\.1/);
  });

  it("finds the title and section headings", () => {
    const headings = doc.blocks.filter((b) => b.kind === "heading").map((b) => b.text);
    expect(headings).toContain("Vistra Reports Second Quarter 2026 Results");
    expect(headings).toContain("Earnings Release Highlights");
  });

  it("keeps body sentences as paragraphs, not headings", () => {
    const p = doc.blocks.find((b) => b.text.startsWith("• GAAP second quarter 2026 Net Income of $305 million"));
    expect(p?.kind).toBe("paragraph");
  });

  it("linearises tables row by row, gluing currency symbols to numbers", () => {
    const rows = doc.blocks.filter((b) => b.kind === "table_row");
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.some((r) => / \| \$[\d,]+/.test(r.text))).toBe(true);
    expect(rows.every((r) => !/(^|\| )\$( \||$)/.test(r.text))).toBe(true); // no stranded "$" cells
  });

  it("drops markup and collapses whitespace", () => {
    expect(doc.text).not.toMatch(/<\/?[a-z]+[^>]*>/i);
    expect(doc.text).not.toMatch(/[ \t]{2,}/);
  });

  it("labels the first figures table as the headline table and the rest as release body", () => {
    const labelled = labelSections("press_release", doc.blocks);
    const headline = findHeadlineTable(doc.blocks);
    expect(headline).not.toBeNull();
    expect(labelled.filter((b) => b.section === "headline_table").length).toBeGreaterThanOrEqual(3);
    expect(labelled.filter((b) => b.section === "headline_table").every((b) => b.kind === "table_row")).toBe(true);
    expect(labelled.find((b) => b.kind === "heading")?.section).toBe("release_body");
  });
});

describe("cleanHtml edge cases", () => {
  it("keeps text placed directly in <body>", () => {
    expect(cleanHtml("<html><body>10-Q</body></html>").text).toBe("10-Q");
    expect(cleanHtml("<html><body>Intro text<div>Block</div>Tail</body></html>").blocks.map((b) => b.text)).toEqual([
      "Intro text",
      "Block",
      "Tail",
    ]);
  });
});

describe("joinCells", () => {
  it("glues $, ), % and pts to their numbers", () => {
    expect(joinCells(["Revenue", "$", "4,021", "$", "3,612"])).toBe("Revenue | $4,021 | $3,612");
    expect(joinCells(["Net loss", "(12", ")", "5.1", "%"])).toBe("Net loss | (12) | 5.1%");
    expect(joinCells(["Gross margin", "42.0", "%", "1.2", "pts"])).toBe("Gross margin | 42.0% | 1.2 pts");
  });
});

describe("labelSections on a 10-Q", () => {
  const html = `<html><body>
    <table><tr><td>Item 2.</td><td>Management's Discussion and Analysis</td><td>25</td></tr></table>
    <div><span style="font-weight:700">PART I. FINANCIAL INFORMATION</span></div>
    <div><span style="font-weight:700">Item 1. Financial Statements</span></div>
    <div>Statements text.</div>
    <div><span style="font-weight:700">Item 2. Management’s Discussion and Analysis of Financial Condition and Results of Operations</span></div>
    <div>We expect capital expenditures of about $2.0 billion in 2026.</div>
    <div><b>Liquidity and Capital Resources</b></div>
    <div>Liquidity text.</div>
    <div><span style="font-weight:700">Item 1A. Risk Factors</span></div>
    <div>Risk text.</div>
    <div><span style="font-weight:700">Item 6. Exhibits</span></div>
    <div>Exhibit list.</div>
  </body></html>`;

  it("tracks MD&A and risk sections from headings, ignoring the table of contents", () => {
    const labelled = labelSections("filing_10q", cleanHtml(html).blocks);
    const section = (startsWith: string) => labelled.find((b) => b.text.startsWith(startsWith))?.section;
    expect(section("Item 2. | Management's")).toBe("other"); // TOC row
    expect(section("Statements text")).toBe("other");
    expect(section("We expect capital expenditures")).toBe("mda");
    expect(section("Liquidity text")).toBe("mda"); // sub-heading stays inside MD&A
    expect(section("Risk text")).toBe("risk");
    expect(section("Exhibit list")).toBe("other");
  });
});
