import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  padCik,
  parseCompanyProfile,
  parseCompanyTickers,
  parseEarningsFilings,
  parseFilingIndex,
  selectEarningsDocument,
} from "./edgarParse";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/edgar");
const json = (name: string) => JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));
const text = (name: string) => readFileSync(path.join(fixtures, name), "utf8");

describe("parseCompanyTickers", () => {
  it("maps tickers to zero-padded CIKs", () => {
    const map = parseCompanyTickers(json("company_tickers.json"));
    expect(map.get("VST")).toMatchObject({ cik: "0001692819", ticker: "VST" });
    expect(map.get("AAPL")?.cik).toBe("0000320193");
  });

  it("pads CIKs from numbers and strings", () => {
    expect(padCik(320193)).toBe("0000320193");
    expect(padCik("0001692819")).toBe("0001692819");
  });
});

describe("parseCompanyProfile", () => {
  it("reads name, exchange and fiscal year end", () => {
    expect(parseCompanyProfile(json("submissions_VST.json"))).toEqual({
      cik: "0001692819",
      name: "Vistra Corp.",
      exchange: "NYSE",
      fiscalYearEnd: "1231",
    });
  });
});

describe("parseEarningsFilings", () => {
  const submissions = json("submissions_VST.json");

  it("keeps 10-Q, 10-K and only the 8-Ks with item 2.02", () => {
    const filings = parseEarningsFilings(submissions, null);
    expect(filings.length).toBeGreaterThan(0);
    for (const f of filings) {
      expect(["8-K", "10-Q", "10-K"]).toContain(f.form);
      if (f.form === "8-K") expect(f.items).toContain("2.02");
    }
    expect(filings.find((f) => f.accession === "0001692819-26-000017")).toMatchObject({
      form: "8-K",
      filingDate: "2026-08-07",
    });
    // An 8-K for a debt agreement (items 1.01, 2.03) is not an earnings release.
    expect(filings.find((f) => f.accession === "0001140361-26-038468")).toBeUndefined();
  });

  it("returns filings oldest first", () => {
    const filings = parseEarningsFilings(submissions, null);
    const times = filings.map((f) => f.acceptedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("drops filings at or before the watermark", () => {
    const watermark = new Date("2026-08-07T11:00:25.000Z"); // acceptance time of the Q2 2026 8-K
    const filings = parseEarningsFilings(submissions, watermark);
    expect(filings.map((f) => f.accession)).not.toContain("0001692819-26-000017");
    expect(filings.every((f) => f.acceptedAt > watermark)).toBe(true);
  });
});

describe("parseFilingIndex + selectEarningsDocument", () => {
  it("finds the EX-99.1 press release in an earnings 8-K", () => {
    const entries = parseFilingIndex(text("filing_index_VST_8k.htm"));
    expect(entries.find((e) => e.type === "8-K")?.filename).toBe("vistra-20260807.htm");
    const doc = selectEarningsDocument("8-K", entries);
    expect(doc).toMatchObject({ type: "EX-99.1", filename: "vistra-20260630xearningsre.htm" });
    expect(doc?.url).toBe(
      "https://www.sec.gov/Archives/edgar/data/1692819/000169281926000017/vistra-20260630xearningsre.htm",
    );
  });

  it("finds the main document of a 10-Q, unwrapping the inline-XBRL viewer link", () => {
    const doc = selectEarningsDocument("10-Q", parseFilingIndex(text("filing_index_VST_10q.htm")));
    expect(doc?.type).toBe("10-Q");
    expect(doc?.url).toMatch(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/1692819\/.+\.htm$/);
  });

  it("returns null when an 8-K has no exhibit 99", () => {
    expect(selectEarningsDocument("8-K", [])).toBeNull();
  });
});
