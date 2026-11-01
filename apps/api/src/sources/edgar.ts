import fs from "node:fs/promises";
import path from "node:path";
import type Bottleneck from "bottleneck";
import { createRateLimiter, defaultFetcher, limitedGet, type Fetcher } from "./http";
import {
  accessionPath,
  parseCompanyProfile,
  parseCompanyTickers,
  parseEarningsFilings,
  parseFilingIndex,
  padCik,
  type CompanyProfile,
  type EarningsFiling,
  type FilingIndexEntry,
  type TickerEntry,
} from "./edgarParse";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EdgarOptions {
  userAgent: string;
  maxRps: number;
  cacheDir: string;
  fetcher?: Fetcher;
}

/**
 * SEC EDGAR client (§15). Every request carries the declared User-Agent and goes through one
 * token bucket per process (fix 7: run a single worker process so this stays the global limit).
 */
export class EdgarClient {
  private readonly limiter: Bottleneck;
  private readonly fetcher: Fetcher;
  private tickerMap: { loadedAt: number; map: Map<string, TickerEntry> } | null = null;

  constructor(private readonly opts: EdgarOptions) {
    this.limiter = createRateLimiter(opts.maxRps, 1000);
    this.fetcher = opts.fetcher ?? defaultFetcher;
  }

  private async get(url: string): Promise<Response> {
    return limitedGet(this.limiter, this.fetcher, url, {
      headers: { "User-Agent": this.opts.userAgent, "Accept-Encoding": "gzip, deflate" },
    });
  }

  private async getJson(url: string): Promise<unknown> {
    return (await this.get(url)).json();
  }

  async lookupTicker(ticker: string): Promise<TickerEntry | null> {
    const now = Date.now();
    if (!this.tickerMap || now - this.tickerMap.loadedAt > DAY_MS) {
      const json = await this.cached("company_tickers.json", DAY_MS, () =>
        this.getJson("https://www.sec.gov/files/company_tickers.json"),
      );
      this.tickerMap = { loadedAt: now, map: parseCompanyTickers(json) };
    }
    return this.tickerMap.map.get(ticker.toUpperCase()) ?? null;
  }

  async getSubmissions(cik: string): Promise<unknown> {
    return this.getJson(`https://data.sec.gov/submissions/CIK${padCik(cik)}.json`);
  }

  async getProfile(cik: string): Promise<CompanyProfile> {
    return parseCompanyProfile(await this.getSubmissions(cik));
  }

  /** Profile + earnings filings accepted after the watermark, from one submissions request. */
  async getEarningsFilings(
    cik: string,
    acceptedAfter: Date | null,
  ): Promise<{ profile: CompanyProfile; filings: EarningsFiling[] }> {
    const json = await this.getSubmissions(cik);
    return { profile: parseCompanyProfile(json), filings: parseEarningsFilings(json, acceptedAfter) };
  }

  async getFilingIndex(cik: string, accession: string): Promise<FilingIndexEntry[]> {
    const url = `${accessionPath(cik, accession)}/${accession}-index.htm`;
    return parseFilingIndex(await (await this.get(url)).text());
  }

  async fetchDocument(url: string): Promise<{ bytes: Buffer; contentType: string | null }> {
    const res = await this.get(url);
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
  }

  /**
   * company-facts JSON, cached on disk (§15). Used only by validation (§18) as a numeric
   * cross-check, never as an extraction source.
   */
  async getCompanyFacts(cik: string, maxAgeMs = DAY_MS): Promise<unknown> {
    const padded = padCik(cik);
    return this.cached(`companyfacts/CIK${padded}.json`, maxAgeMs, () =>
      this.getJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`),
    );
  }

  private async cached(name: string, maxAgeMs: number, load: () => Promise<unknown>): Promise<unknown> {
    const file = path.join(this.opts.cacheDir, "edgar", name);
    try {
      const stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs < maxAgeMs) return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      // cache miss
    }
    const json = await load();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(json));
    return json;
  }
}
