import { companies, consensusSnapshots, earningsEvents, workerHeartbeats } from "@eia/db";
import { fiscalPeriodOf, quarterReportedBy } from "@eia/shared";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { withTransaction, type AppContext } from "../context";
import { Q, type DiscoverPayload, type IngestPayload } from "../queues";
import { accessionPath, type EarningsFiling } from "../sources/edgarParse";

type CompanyRow = typeof companies.$inferSelect;

export interface DiscoverResult {
  skipped?: string;
  companies: number;
  filings: number;
  calendarEvents: number;
}

/**
 * UC-1 (§6 step 1): find new earnings filings for watched companies, create events, enqueue ingest.
 * Never fetches document bodies. Safe to re-run: events dedupe on (company, fiscal period) and
 * ingest jobs on the accession number.
 */
export async function discoverJob(ctx: AppContext, payload: DiscoverPayload): Promise<DiscoverResult> {
  const watched = await ctx.db
    .select()
    .from(companies)
    .where(
      payload.tickers?.length
        ? and(eq(companies.watched, true), inArray(companies.ticker, payload.tickers.map((t) => t.toUpperCase())))
        : eq(companies.watched, true),
    );

  if (payload.mode === "window" && !(await printDueSoon(ctx, watched))) {
    return { skipped: "no print due", companies: 0, filings: 0, calendarEvents: 0 };
  }

  const calendarEvents = await discoverFromCalendar(ctx, watched);
  let filings = 0;
  for (const company of watched) {
    filings += await discoverCompany(ctx, company);
  }

  await ctx.db
    .insert(workerHeartbeats)
    .values({ name: "discover", lastRunAt: new Date(), detail: { mode: payload.mode, filings } })
    .onConflictDoUpdate({
      target: workerHeartbeats.name,
      set: { lastRunAt: new Date(), detail: { mode: payload.mode, filings } },
    });

  return { companies: watched.length, filings, calendarEvents };
}

async function discoverCompany(ctx: AppContext, company: CompanyRow): Promise<number> {
  const log = ctx.log.child({ ticker: company.ticker });
  const lookback = new Date(Date.now() - ctx.config.DISCOVERY_LOOKBACK_DAYS * 86_400_000);
  const watermark = company.lastEdgarSeenAt ?? lookback;
  const { profile, filings } = await ctx.edgar.getEarningsFilings(company.cik, watermark);

  const fye = profile.fiscalYearEnd ?? company.fiscalYearEnd;
  if (profile.fiscalYearEnd && profile.fiscalYearEnd !== company.fiscalYearEnd) {
    await ctx.db.update(companies).set({ fiscalYearEnd: profile.fiscalYearEnd }).where(eq(companies.id, company.id));
  }
  if (!fye) {
    log.warn("EDGAR has no fiscal year end for this company; skipping discovery");
    return 0;
  }

  let processed = 0;
  for (const filing of filings) {
    let fiscalPeriod: string;
    try {
      fiscalPeriod = fiscalPeriodForFiling(filing, fye);
    } catch (err) {
      log.warn({ err, accession: filing.accession }, "could not place filing in a fiscal period; skipping");
      continue;
    }
    await recordFiling(ctx, company, filing, fiscalPeriod);
    processed++;
  }

  // The watermark advances only after every filing in the batch is persisted (§15).
  const last = filings.at(-1);
  if (last) {
    await ctx.db.update(companies).set({ lastEdgarSeenAt: last.acceptedAt }).where(eq(companies.id, company.id));
  }
  if (processed) log.info({ filings: processed }, "discovered filings");
  return processed;
}

/** Fix 4: a 10-Q/10-K states its period end; an 8-K reports on the quarter that just ended. */
export function fiscalPeriodForFiling(filing: EarningsFiling, fiscalYearEnd: string): string {
  if (filing.form === "8-K") {
    return quarterReportedBy(new Date(`${filing.filingDate}T00:00:00Z`), fiscalYearEnd).label;
  }
  if (!filing.reportDate) throw new Error(`${filing.form} ${filing.accession} has no report date`);
  return fiscalPeriodOf(new Date(`${filing.reportDate}T00:00:00Z`), fiscalYearEnd).label;
}

async function recordFiling(
  ctx: AppContext,
  company: CompanyRow,
  filing: EarningsFiling,
  fiscalPeriod: string,
): Promise<void> {
  const indexUrl = `${accessionPath(company.cik, filing.accession)}/${filing.accession}-index.htm`;
  await withTransaction(ctx, async (tx) => {
    await tx.db
      .insert(earningsEvents)
      .values({
        companyId: company.id,
        fiscalPeriod,
        reportDate: filing.acceptedAt,
        sourceUrls: { [filing.form]: indexUrl },
      })
      .onConflictDoUpdate({
        target: [earningsEvents.companyId, earningsEvents.fiscalPeriod],
        set: {
          sourceUrls: sql`${earningsEvents.sourceUrls} || ${JSON.stringify({ [filing.form]: indexUrl })}::jsonb`,
          // The 8-K is the print itself; its acceptance time is the report date.
          ...(filing.form === "8-K" ? { reportDate: filing.acceptedAt } : {}),
          updatedAt: new Date(),
        },
      });
    const [event] = await tx.db
      .select({ id: earningsEvents.id })
      .from(earningsEvents)
      .where(and(eq(earningsEvents.companyId, company.id), eq(earningsEvents.fiscalPeriod, fiscalPeriod)));

    const payload: IngestPayload = {
      eventId: event!.id,
      ref: {
        source: "edgar",
        cik: company.cik,
        ticker: company.ticker,
        form: filing.form,
        accession: filing.accession,
        filingDate: filing.filingDate,
      },
    };
    // Same transaction as the event row (fix 10): no event without its ingest job, and vice versa.
    await ctx.boss.send(Q.ingest, payload, { singletonKey: filing.accession, db: tx.queue });
  });
}

/**
 * Pre-print events from the provider calendar, each with its consensus snapshot taken now -
 * before the print - so later estimate revisions can't rewrite beat/miss history (§15).
 */
async function discoverFromCalendar(ctx: AppContext, watched: CompanyRow[]): Promise<number> {
  if (!ctx.provider.enabled || watched.length === 0) return 0;
  const today = DateTime.now().setZone("America/New_York");
  const rows = await ctx.provider.getEarningsCalendar(
    today.minus({ days: 3 }).toISODate()!,
    today.plus({ days: 14 }).toISODate()!,
  );
  const byTicker = new Map(watched.map((c) => [c.ticker, c]));
  let created = 0;
  for (const row of rows) {
    const company = byTicker.get(row.ticker.toUpperCase());
    if (!company?.fiscalYearEnd) continue;
    const fiscalPeriod = quarterReportedBy(new Date(`${row.date}T00:00:00Z`), company.fiscalYearEnd).label;
    const reportDate = DateTime.fromISO(row.date, { zone: "America/New_York" })
      .set({ hour: row.hour === "bmo" ? 7 : 16 })
      .toJSDate();
    const [event] = await ctx.db
      .insert(earningsEvents)
      .values({
        companyId: company.id,
        fiscalPeriod,
        reportDate,
        sourceUrls: { calendar: `${ctx.provider.name}:${row.fiscalYear}Q${row.fiscalQuarter}:${row.date}` },
      })
      .onConflictDoNothing()
      .returning({ id: earningsEvents.id });
    if (!event) continue;
    created++;
    await snapshotConsensus(ctx, event.id, company.ticker, row.fiscalYear, row.fiscalQuarter);
  }
  return created;
}

export async function snapshotConsensus(
  ctx: AppContext,
  eventId: string,
  ticker: string,
  providerFiscalYear: number,
  providerFiscalQuarter: number,
): Promise<void> {
  try {
    const estimates = await ctx.provider.getConsensus(ticker, providerFiscalYear, providerFiscalQuarter);
    for (const e of estimates) {
      // Never overwritten: the first snapshot for (event, metric, provider) wins.
      await ctx.db
        .insert(consensusSnapshots)
        .values({ eventId, metric: e.metric, value: String(e.value), provider: e.provider, asOf: e.asOf })
        .onConflictDoNothing();
    }
  } catch (err) {
    // Missing consensus is not fatal: Compare reports no_consensus (§19).
    ctx.log.warn({ err, ticker, eventId }, "consensus snapshot failed");
  }
}

/** Earnings-window polls run only when a watched company's print is within a day (§9). */
async function printDueSoon(ctx: AppContext, watched: CompanyRow[]): Promise<boolean> {
  if (watched.length === 0) return false;
  const now = Date.now();
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(earningsEvents)
    .where(
      and(
        inArray(
          earningsEvents.companyId,
          watched.map((c) => c.id),
        ),
        eq(earningsEvents.status, "discovered"),
        gte(earningsEvents.reportDate, new Date(now - 2 * 86_400_000)),
        lte(earningsEvents.reportDate, new Date(now + 86_400_000)),
      ),
    );
  return (row?.n ?? 0) > 0;
}
