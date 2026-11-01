// Pure parsers for EDGAR payloads - no I/O, unit-tested against saved fixtures.
import * as cheerio from "cheerio";
import type { DocumentType } from "@eia/shared";

export interface TickerEntry {
  cik: string; // zero-padded to 10
  ticker: string;
  title: string;
}

/** www.sec.gov/files/company_tickers.json -> lookup by ticker. */
export function parseCompanyTickers(json: unknown): Map<string, TickerEntry> {
  const map = new Map<string, TickerEntry>();
  for (const v of Object.values(json as Record<string, { cik_str: number; ticker: string; title: string }>)) {
    map.set(v.ticker.toUpperCase(), {
      cik: padCik(v.cik_str),
      ticker: v.ticker.toUpperCase(),
      title: v.title,
    });
  }
  return map;
}

export function padCik(cik: number | string): string {
  return String(cik).replace(/^0+/, "").padStart(10, "0");
}

export interface CompanyProfile {
  cik: string;
  name: string;
  exchange: string | null;
  fiscalYearEnd: string | null;
}

export type EarningsForm = "8-K" | "10-Q" | "10-K";

export interface EarningsFiling {
  form: EarningsForm;
  accession: string; // 0001692819-26-000017
  filingDate: string; // YYYY-MM-DD
  reportDate: string | null; // period end for 10-Q/10-K; event date for 8-K
  acceptedAt: Date;
  items: string[];
  primaryDocument: string;
}

interface RecentFilings {
  accessionNumber: string[];
  filingDate: string[];
  reportDate: string[];
  acceptanceDateTime: string[];
  form: string[];
  items: string[];
  primaryDocument: string[];
}

interface Submissions {
  cik: string;
  name: string;
  exchanges?: string[];
  fiscalYearEnd?: string;
  filings: { recent: RecentFilings };
}

export function parseCompanyProfile(json: unknown): CompanyProfile {
  const s = json as Submissions;
  return {
    cik: padCik(s.cik),
    name: s.name,
    exchange: s.exchanges?.[0] || null,
    fiscalYearEnd: s.fiscalYearEnd || null,
  };
}

/**
 * Earnings-relevant filings from the submissions JSON: 10-Q, 10-K, and 8-Ks carrying item 2.02
 * (Results of Operations). The item list comes from the filing index metadata, not the text (§15).
 */
export function parseEarningsFilings(json: unknown, acceptedAfter: Date | null): EarningsFiling[] {
  const r = (json as Submissions).filings.recent;
  const out: EarningsFiling[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i];
    if (form !== "8-K" && form !== "10-Q" && form !== "10-K") continue;
    const items = (r.items[i] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (form === "8-K" && !items.includes("2.02")) continue;
    const acceptedAt = new Date(r.acceptanceDateTime[i]!);
    if (acceptedAfter && acceptedAt <= acceptedAfter) continue;
    out.push({
      form,
      accession: r.accessionNumber[i]!,
      filingDate: r.filingDate[i]!,
      reportDate: r.reportDate[i] || null,
      acceptedAt,
      items,
      primaryDocument: r.primaryDocument[i]!,
    });
  }
  // Oldest first, so the watermark can advance in order.
  return out.sort((a, b) => a.acceptedAt.getTime() - b.acceptedAt.getTime());
}

export function documentTypeForForm(form: EarningsForm): DocumentType {
  return form === "8-K" ? "press_release" : form === "10-Q" ? "filing_10q" : "filing_10k";
}

export interface FilingIndexEntry {
  seq: number | null;
  description: string;
  filename: string;
  url: string;
  type: string; // "8-K", "EX-99.1", "GRAPHIC", ...
}

/** The `<accession>-index.htm` page: the only EDGAR listing that labels each file with its exhibit type. */
export function parseFilingIndex(html: string): FilingIndexEntry[] {
  const $ = cheerio.load(html);
  const out: FilingIndexEntry[] = [];
  $("table.tableFile")
    .first()
    .find("tr")
    .each((_, tr) => {
      const cells = $(tr).find("td");
      if (cells.length < 4) return;
      const link = $(cells[2]).find("a").attr("href");
      if (!link) return;
      // Inline-XBRL viewer links look like /ix?doc=/Archives/...; keep the raw document path.
      const rawPath = link.startsWith("/ix?doc=") ? link.slice("/ix?doc=".length) : link;
      const seqText = $(cells[0]).text().trim();
      out.push({
        seq: seqText ? Number(seqText) : null,
        description: $(cells[1]).text().trim(),
        filename: rawPath.split("/").pop()!,
        url: `https://www.sec.gov${rawPath}`,
        type: $(cells[3]).text().trim(),
      });
    });
  return out;
}

/** Which file in a filing is the document we process: EX-99.1 for an earnings 8-K, the main form otherwise. */
export function selectEarningsDocument(form: EarningsForm, entries: FilingIndexEntry[]): FilingIndexEntry | null {
  const html = entries.filter((e) => /\.html?$/i.test(e.filename));
  if (form === "8-K") {
    return (
      html.find((e) => e.type.toUpperCase() === "EX-99.1") ??
      html.find((e) => e.type.toUpperCase().startsWith("EX-99")) ??
      null
    );
  }
  return html.find((e) => e.type.toUpperCase() === form) ?? null;
}

export function accessionPath(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}`;
}
