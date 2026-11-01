import { companies, documents, earningsEvents, type Db } from "@eia/db";
import type { DocumentStatus, EventSummary } from "@eia/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../context";
import { eventStatusFromDocuments } from "./eventStatus";

/** Re-derive the event's status from its live documents (fix 9). Call inside the transaction that changed them. */
export async function recomputeEventStatus(db: Db, eventId: string): Promise<void> {
  const rows = await db
    .select({ status: documents.status })
    .from(documents)
    .where(and(eq(documents.eventId, eventId), isNull(documents.supersededAt)));
  const status = eventStatusFromDocuments(rows.map((r) => r.status as DocumentStatus));
  if (!status) return;
  await db.update(earningsEvents).set({ status, updatedAt: new Date() }).where(eq(earningsEvents.id, eventId));
}

/** Events for a ticker, newest first, with their documents (§21 - the Phase 1 exit-test endpoint). */
export async function listEventsForTicker(ctx: AppContext, ticker: string): Promise<EventSummary[]> {
  const events = await ctx.db
    .select({
      id: earningsEvents.id,
      ticker: companies.ticker,
      fiscalPeriod: earningsEvents.fiscalPeriod,
      reportDate: earningsEvents.reportDate,
      status: earningsEvents.status,
    })
    .from(earningsEvents)
    .innerJoin(companies, eq(companies.id, earningsEvents.companyId))
    .where(eq(companies.ticker, ticker.toUpperCase()))
    .orderBy(desc(earningsEvents.reportDate));
  if (events.length === 0) return [];

  const docs = await ctx.db
    .select({
      id: documents.id,
      eventId: documents.eventId,
      type: documents.type,
      status: documents.status,
      sourceUrl: documents.sourceUrl,
      fetchedAt: documents.fetchedAt,
    })
    .from(documents)
    .where(
      and(
        inArray(
          documents.eventId,
          events.map((e) => e.id),
        ),
        isNull(documents.supersededAt),
      ),
    )
    .orderBy(sql`${documents.fetchedAt} asc`);

  return events.map((e) => ({
    id: e.id,
    ticker: e.ticker,
    fiscalPeriod: e.fiscalPeriod,
    reportDate: e.reportDate.toISOString(),
    status: e.status,
    documents: docs
      .filter((d) => d.eventId === e.id)
      .map((d) => ({
        id: d.id,
        type: d.type,
        status: d.status,
        sourceUrl: d.sourceUrl,
        fetchedAt: d.fetchedAt.toISOString(),
      })),
  }));
}
