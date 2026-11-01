import type Bottleneck from "bottleneck";
import type { MetricName } from "@eia/shared";
import { createRateLimiter, defaultFetcher, limitedGet, type Fetcher } from "./http";

export interface CalendarEntry {
  ticker: string;
  date: string; // YYYY-MM-DD
  /** Provider's fiscal year/quarter for the print. */
  fiscalYear: number;
  fiscalQuarter: number;
  hour: string | null; // bmo | amc | dmh
}

export interface ConsensusEstimate {
  metric: MetricName;
  value: number;
  provider: string;
  asOf: Date;
}

/** One interface, one implementation chosen by DATA_PROVIDER (§15). */
export interface MarketDataProvider {
  readonly name: string;
  readonly enabled: boolean;
  getEarningsCalendar(from: string, to: string, ticker?: string): Promise<CalendarEntry[]>;
  /** Consensus for one print, as published by this provider. Empty when it has none. */
  getConsensus(ticker: string, fiscalYear: number, fiscalQuarter: number): Promise<ConsensusEstimate[]>;
  getQuote(ticker: string): Promise<{ price: number; asOf: Date } | null>;
}

/** Used when no provider key is configured: everything works, beat/miss becomes no_consensus. */
export class DisabledProvider implements MarketDataProvider {
  readonly name = "none";
  readonly enabled = false;
  async getEarningsCalendar(): Promise<CalendarEntry[]> {
    return [];
  }
  async getConsensus(): Promise<ConsensusEstimate[]> {
    return [];
  }
  async getQuote(): Promise<null> {
    return null;
  }
}

interface FinnhubCalendarRow {
  date: string;
  epsEstimate: number | null;
  hour: string | null;
  quarter: number;
  revenueEstimate: number | null;
  symbol: string;
  year: number;
}

export class FinnhubProvider implements MarketDataProvider {
  readonly name = "finnhub";
  readonly enabled = true;
  private readonly limiter: Bottleneck;
  private readonly fetcher: Fetcher;
  private readonly base = "https://finnhub.io/api/v1";

  constructor(
    private readonly apiKey: string,
    fetcher?: Fetcher,
  ) {
    // Free tier allows 60 calls/minute; stay under it.
    this.limiter = createRateLimiter(50, 60_000);
    this.fetcher = fetcher ?? defaultFetcher;
  }

  private async getJson<T>(pathAndQuery: string): Promise<T> {
    const res = await limitedGet(this.limiter, this.fetcher, `${this.base}${pathAndQuery}`, {
      // Key in a header, not the URL, so it never lands in logs.
      headers: { "X-Finnhub-Token": this.apiKey },
    });
    return (await res.json()) as T;
  }

  private async calendarRows(from: string, to: string, ticker?: string): Promise<FinnhubCalendarRow[]> {
    const q = new URLSearchParams({ from, to, ...(ticker ? { symbol: ticker } : {}) });
    const body = await this.getJson<{ earningsCalendar?: FinnhubCalendarRow[] }>(`/calendar/earnings?${q}`);
    return body.earningsCalendar ?? [];
  }

  async getEarningsCalendar(from: string, to: string, ticker?: string): Promise<CalendarEntry[]> {
    return (await this.calendarRows(from, to, ticker)).map((r) => ({
      ticker: r.symbol,
      date: r.date,
      fiscalYear: r.year,
      fiscalQuarter: r.quarter,
      hour: r.hour || null,
    }));
  }

  async getConsensus(ticker: string, fiscalYear: number, fiscalQuarter: number): Promise<ConsensusEstimate[]> {
    // The calendar row carries the consensus Finnhub publishes for that print. A wide window
    // around today covers prints just reported and those coming up.
    const now = Date.now();
    const from = new Date(now - 120 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(now + 120 * 86_400_000).toISOString().slice(0, 10);
    const row = (await this.calendarRows(from, to, ticker)).find(
      (r) => r.year === fiscalYear && r.quarter === fiscalQuarter,
    );
    if (!row) return [];
    const asOf = new Date();
    const out: ConsensusEstimate[] = [];
    // Finnhub's EPS estimate is the adjusted (non-GAAP) consensus.
    if (row.epsEstimate != null) out.push({ metric: "eps_adj", value: row.epsEstimate, provider: this.name, asOf });
    if (row.revenueEstimate != null) {
      out.push({ metric: "revenue", value: row.revenueEstimate, provider: this.name, asOf });
    }
    return out;
  }

  async getQuote(ticker: string): Promise<{ price: number; asOf: Date } | null> {
    const q = await this.getJson<{ c?: number; t?: number }>(`/quote?symbol=${encodeURIComponent(ticker)}`);
    if (!q.c) return null;
    return { price: q.c, asOf: new Date((q.t ?? Date.now() / 1000) * 1000) };
  }
}

export function createProvider(kind: string, apiKey: string, fetcher?: Fetcher): MarketDataProvider {
  if (!apiKey) return new DisabledProvider();
  if (kind === "finnhub") return new FinnhubProvider(apiKey, fetcher);
  throw new Error(`Unsupported DATA_PROVIDER "${kind}"`);
}
