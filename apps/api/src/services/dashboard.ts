// Read models for the week view, alert feed, cost view and ticker page (§21, §22, §23).
import { alerts, briefs, companies, earningsEvents, guidance, llmCalls, metrics, workerHeartbeats } from "@eia/db";
import type {
  AlertsResponse,
  CostsResponse,
  GuidanceHistoryRow,
  MetricName,
  TickerResponse,
  WeekEvent,
  WeekResponse,
} from "@eia/shared";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { AppContext } from "../context";
import { AppError } from "../errors";
import { listEventsForTicker } from "./events";
import { guidanceUnit } from "./factSheet";
import { PriceTable } from "../llm/pricing";

const NY = "America/New_York";
const PAGE = 50;

/** Monday-to-Sunday week containing `date` (New York), or the given range. */
export function weekRange(from?: string, to?: string): { from: DateTime; to: DateTime } {
  if (from && to) {
    const f = DateTime.fromISO(from, { zone: NY }).startOf("day");
    const t = DateTime.fromISO(to, { zone: NY }).endOf("day");
    if (!f.isValid || !t.isValid || t < f) throw new AppError("VALIDATION_FAILED", "from/to must be YYYY-MM-DD with from <= to", 400);
    if (t.diff(f, "days").days > 62) throw new AppError("VALIDATION_FAILED", "a range can span at most 62 days", 400);
    return { from: f, to: t };
  }
  const anchor = from ? DateTime.fromISO(from, { zone: NY }) : DateTime.now().setZone(NY);
  if (!anchor.isValid) throw new AppError("VALIDATION_FAILED", "from must be YYYY-MM-DD", 400);
  const start = anchor.startOf("week"); // Luxon weeks start on Monday
  return { from: start, to: start.endOf("week") };
}

export async function weekView(ctx: AppContext, fromParam?: string, toParam?: string): Promise<WeekResponse> {
  const { from, to } = weekRange(fromParam, toParam);
  const rows = await ctx.db
    .select({ event: earningsEvents, company: companies })
    .from(earningsEvents)
    .innerJoin(companies, eq(companies.id, earningsEvents.companyId))
    .where(and(gte(earningsEvents.reportDate, from.toJSDate()), lte(earningsEvents.reportDate, to.toJSDate())))
    .orderBy(asc(earningsEvents.reportDate));

  const ids = rows.map((r) => r.event.id);
  const verdictRows = ids.length
    ? await ctx.db
        .select({ eventId: metrics.eventId, name: metrics.name, verdict: metrics.verdict })
        .from(metrics)
        .where(and(inArray(metrics.eventId, ids), eq(metrics.periodType, "quarter"), isNull(metrics.segment)))
    : [];
  const changeRows = ids.length
    ? await ctx.db
        .select({ eventId: guidance.eventId, metric: guidance.metric, targetPeriod: guidance.targetPeriod, change: guidance.change })
        .from(guidance)
        .where(inArray(guidance.eventId, ids))
    : [];
  const briefRows = ids.length
    ? await ctx.db
        .select({ eventId: briefs.eventId })
        .from(briefs)
        .where(and(inArray(briefs.eventId, ids), isNull(briefs.supersededAt)))
    : [];
  const briefed = new Set(briefRows.map((b) => b.eventId));

  const days = new Map<string, WeekEvent[]>();
  for (let d = from; d <= to; d = d.plus({ days: 1 })) days.set(d.toISODate()!, []);
  for (const { event, company } of rows) {
    const day = DateTime.fromJSDate(event.reportDate, { zone: NY }).toISODate()!;
    days.get(day)?.push({
      eventId: event.id,
      ticker: company.ticker,
      companyName: company.name,
      fiscalPeriod: event.fiscalPeriod,
      reportDate: event.reportDate.toISOString(),
      status: event.status,
      lastError: event.lastError,
      verdicts: verdictRows
        .filter((v) => v.eventId === event.id && v.verdict)
        .map((v) => ({ metric: v.name, verdict: v.verdict! })),
      guidanceChanges: changeRows
        .filter((g) => g.eventId === event.id && g.change)
        .map((g) => ({ metric: g.metric, targetPeriod: g.targetPeriod, change: g.change! })),
      hasBrief: briefed.has(event.id),
    });
  }

  const [beat] = await ctx.db.select().from(workerHeartbeats).where(eq(workerHeartbeats.name, "discover"));
  return {
    from: from.toISODate()!,
    to: to.toISODate()!,
    days: [...days].map(([date, events]) => ({ date, events })),
    lastDiscoverAt: beat?.lastRunAt.toISOString() ?? null,
  };
}

/** Cursor = "<createdAt ISO>|<id>": stable keyset paging, newest first (§21). */
export async function listAlerts(ctx: AppContext, cursor?: string): Promise<AlertsResponse> {
  let after: { at: Date; id: string } | null = null;
  if (cursor) {
    const [at, id] = cursor.split("|");
    const date = new Date(at ?? "");
    if (!id || Number.isNaN(date.getTime())) throw new AppError("VALIDATION_FAILED", "invalid cursor", 400);
    after = { at: date, id };
  }
  const rows = await ctx.db
    .select({ alert: alerts, ticker: companies.ticker, fiscalPeriod: earningsEvents.fiscalPeriod })
    .from(alerts)
    .innerJoin(earningsEvents, eq(earningsEvents.id, alerts.eventId))
    .innerJoin(companies, eq(companies.id, earningsEvents.companyId))
    .where(
      after
        ? or(lt(alerts.createdAt, after.at), and(eq(alerts.createdAt, after.at), lt(alerts.id, after.id)))
        : undefined,
    )
    .orderBy(desc(alerts.createdAt), desc(alerts.id))
    .limit(PAGE + 1);
  const page = rows.slice(0, PAGE);
  const last = page.at(-1);
  return {
    alerts: page.map((r) => ({
      id: r.alert.id,
      eventId: r.alert.eventId,
      ticker: r.ticker,
      fiscalPeriod: r.fiscalPeriod,
      kind: r.alert.kind,
      message: r.alert.message,
      createdAt: r.alert.createdAt.toISOString(),
    })),
    nextCursor: rows.length > PAGE && last ? `${last.alert.createdAt.toISOString()}|${last.alert.id}` : null,
  };
}

/** LLM spend from llm_calls, by print and purpose (§21 /admin/costs) - a SQL query, not a dashboard hunt. */
export async function costs(ctx: AppContext): Promise<CostsResponse> {
  const rows = await ctx.db
    .select({
      eventId: llmCalls.eventId,
      ticker: companies.ticker,
      fiscalPeriod: earningsEvents.fiscalPeriod,
      purpose: llmCalls.purpose,
      calls: sql<number>`count(*)::int`,
      failedCalls: sql<number>`count(*) filter (where not ${llmCalls.ok})::int`,
      inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)::int`,
      costUsd: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)`,
    })
    .from(llmCalls)
    .leftJoin(earningsEvents, eq(earningsEvents.id, llmCalls.eventId))
    .leftJoin(companies, eq(companies.id, earningsEvents.companyId))
    .groupBy(llmCalls.eventId, companies.ticker, earningsEvents.fiscalPeriod, llmCalls.purpose)
    .orderBy(desc(sql`sum(${llmCalls.costUsd})`));

  const models = await ctx.db.selectDistinct({ model: llmCalls.model }).from(llmCalls);
  const prices = new PriceTable(ctx.config.LLM_PRICES_JSON);

  const perEvent = new Map<string, { eventId: string; ticker: string; fiscalPeriod: string; costUsd: number }>();
  for (const r of rows) {
    if (!r.eventId || !r.ticker || !r.fiscalPeriod) continue;
    const e = perEvent.get(r.eventId) ?? { eventId: r.eventId, ticker: r.ticker, fiscalPeriod: r.fiscalPeriod, costUsd: 0 };
    e.costUsd += Number(r.costUsd);
    perEvent.set(r.eventId, e);
  }
  return {
    rows: rows.map((r) => ({ ...r, costUsd: Number(r.costUsd) })),
    totalUsd: rows.reduce((n, r) => n + Number(r.costUsd), 0),
    perEvent: [...perEvent.values()].sort((a, b) => b.costUsd - a.costUsd),
    unpricedModels: models.map((m) => m.model).filter((m) => !prices.has(m)),
  };
}

/** Ticker page (§22): event history plus the guidance table across quarters, with what was delivered. */
export async function tickerView(ctx: AppContext, ticker: string): Promise<TickerResponse> {
  const [company] = await ctx.db.select().from(companies).where(eq(companies.ticker, ticker.toUpperCase()));
  if (!company) throw new AppError("COMPANY_NOT_FOUND", `${ticker} is not on the watchlist`, 404);

  const rows = await ctx.db
    .select({ g: guidance, fiscalPeriod: earningsEvents.fiscalPeriod, reportDate: earningsEvents.reportDate })
    .from(guidance)
    .innerJoin(earningsEvents, eq(earningsEvents.id, guidance.eventId))
    .where(and(eq(guidance.companyId, company.id), sql`${guidance.reviewStatus} <> 'pending'`))
    .orderBy(asc(guidance.metric), asc(guidance.targetPeriod), asc(earningsEvents.reportDate));

  // Actuals the guides can be checked against: quarter figures by fiscal period, full-year figures by year.
  const actuals = await ctx.db
    .select({ name: metrics.name, value: metrics.value, periodType: metrics.periodType, verdict: metrics.verdict, fiscalPeriod: earningsEvents.fiscalPeriod })
    .from(metrics)
    .innerJoin(earningsEvents, eq(earningsEvents.id, metrics.eventId))
    .where(and(eq(earningsEvents.companyId, company.id), isNull(metrics.segment), sql`${metrics.reviewStatus} <> 'pending'`));

  const groups = new Map<string, GuidanceHistoryRow>();
  for (const { g, fiscalPeriod } of rows) {
    const key = `${g.metric}|${g.targetPeriod}`;
    let row = groups.get(key);
    if (!row) {
      const [year, part] = g.targetPeriod.split("-");
      const delivered =
        part === "FY"
          ? actuals.find((a) => a.name === g.metric && a.periodType === "full_year" && a.fiscalPeriod === `${year}-Q4`)
          : actuals.find((a) => a.name === g.metric && a.periodType === "quarter" && a.fiscalPeriod === g.targetPeriod);
      row = {
        metric: g.metric,
        targetPeriod: g.targetPeriod,
        entries: [],
        delivered: delivered
          ? { value: Number(delivered.value), fiscalPeriod: delivered.fiscalPeriod, verdict: delivered.verdict }
          : null,
        unit: guidanceUnit(g.metric as MetricName),
      };
      groups.set(key, row);
    }
    row.entries.push({
      fiscalPeriod,
      eventId: g.eventId,
      kind: g.kind,
      low: g.low === null ? null : Number(g.low),
      high: g.high === null ? null : Number(g.high),
      change: g.change,
      quote: g.quote,
    });
  }

  return {
    company: { ticker: company.ticker, name: company.name, exchange: company.exchange, fiscalYearEnd: company.fiscalYearEnd },
    events: await listEventsForTicker(ctx, company.ticker),
    guidance: [...groups.values()].sort((a, b) => b.targetPeriod.localeCompare(a.targetPeriod) || a.metric.localeCompare(b.metric)),
  };
}
