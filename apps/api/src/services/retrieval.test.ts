import { describe, expect, it } from "vitest";
import { companyWords, contentTerms } from "./retrieval";

describe("contentTerms", () => {
  it("keeps topic words and drops question filler", () => {
    expect(contentTerms("What did management say about capital expenditures?")).toEqual(["capital", "expenditures"]);
  });

  it("drops the named company's own words, since the ticker filter already scopes the search", () => {
    const vistra = companyWords({ ticker: "VST", name: "Vistra Corp." });
    expect(vistra).toEqual(["vst", "vistra", "corp"]);
    expect(contentTerms("What did Vistra say about capital expenditures?", vistra)).toEqual(["capital", "expenditures"]);
    expect(contentTerms("VST data center demand", vistra)).toEqual(["data", "center", "demand"]);
  });

  it("keeps figures and product names, dedupes, and ignores very short tokens", () => {
    expect(contentTerms("Blackwell revenue in 2026, Blackwell margins of 75%")).toEqual([
      "blackwell",
      "revenue",
      "2026",
      "margins",
    ]);
  });

  it("returns nothing for a question of only filler", () => {
    expect(contentTerms("What did they say?")).toEqual(["they"]);
    expect(contentTerms("What did management say about it?")).toEqual([]);
  });
});
