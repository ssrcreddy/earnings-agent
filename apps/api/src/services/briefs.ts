// Read side of briefs (§21, §22): the current brief with every citation resolved to its source passage.
import { briefs, companies, documents, earningsEvents, guidance, metrics } from "@eia/db";
import type { BriefCitation, BriefResponse, BriefSummary, DocumentContext, MetricName } from "@eia/shared";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AppContext } from "../context";
import { AppError } from "../errors";
import { formatTargetPeriod, metricLabel } from "./factSheet";

const CONTEXT_CHARS = 1500;

export async function getBrief(ctx: AppContext, eventId: string): Promise<BriefResponse> {
  const [row] = await ctx.db
    .select({ brief: briefs, event: earningsEvents, company: companies })
    .from(briefs)
    .innerJoin(earningsEvents, eq(earningsEvents.id, briefs.eventId))
    .innerJoin(companies, eq(companies.id, earningsEvents.companyId))
    .where(and(eq(briefs.eventId, eventId), isNull(briefs.supersededAt)));
  if (!row) throw new AppError("BRIEF_NOT_FOUND", `no brief for event ${eventId}`, 404);
  const { brief, event, company } = row;

  const [versions] = await ctx.db.select({ n: count() }).from(briefs).where(eq(briefs.eventId, eventId));

  const entries = Object.entries(brief.citations);
  const metricIds = entries.filter(([, c]) => c.kind === "metric").map(([, c]) => c.rowId);
  const guidanceIds = entries.filter(([, c]) => c.kind === "guidance").map(([, c]) => c.rowId);
  const mRows = metricIds.length
    ? await ctx.db
        .select({ m: metrics, doc: documents })
        .from(metrics)
        .innerJoin(documents, eq(documents.id, metrics.documentId))
        .where(inArray(metrics.id, metricIds))
    : [];
  const gRows = guidanceIds.length
    ? await ctx.db
        .select({ g: guidance, doc: documents })
        .from(guidance)
        .innerJoin(documents, eq(documents.id, guidance.documentId))
        .where(inArray(guidance.id, guidanceIds))
    : [];

  const citations: BriefCitation[] = [];
  for (const [marker, c] of entries) {
    if (c.kind === "metric") {
      const r = mRows.find((x) => x.m.id === c.rowId);
      if (!r) continue;
      const note = r.m.derived
        ? "Derived: full-year figure minus the nine-month year to date"
        : r.m.reviewStatus === "corrected"
          ? "Corrected by a reviewer"
          : null;
      citations.push({
        marker,
        kind: "metric",
        rowId: r.m.id,
        label: `${metricLabel(r.m.name as MetricName, r.m.segment)} (${r.m.periodType.replace("_", " ")})`,
        quote: r.m.quote,
        documentId: r.doc.id,
        documentType: r.doc.type,
        sourceUrl: r.doc.sourceUrl,
        charStart: r.m.charStart,
        charEnd: r.m.charEnd,
        note,
      });
    } else {
      const r = gRows.find((x) => x.g.id === c.rowId);
      if (!r) continue;
      citations.push({
        marker,
        kind: "guidance",
        rowId: r.g.id,
        label: `${metricLabel(r.g.metric as MetricName)} guidance for ${formatTargetPeriod(r.g.targetPeriod)}`,
        quote: r.g.quote,
        documentId: r.doc.id,
        documentType: r.doc.type,
        sourceUrl: r.doc.sourceUrl,
        charStart: r.g.charStart,
        charEnd: r.g.charEnd,
        note: r.g.reviewStatus === "corrected" ? "Corrected by a reviewer" : null,
      });
    }
  }
  citations.sort((a, b) => a.marker.localeCompare(b.marker, undefined, { numeric: true }));

  return {
    eventId,
    ticker: company.ticker,
    companyName: company.name,
    fiscalPeriod: event.fiscalPeriod,
    reportDate: event.reportDate.toISOString(),
    version: brief.version,
    previousVersions: Math.max(0, (versions?.n ?? 1) - 1),
    writer: brief.model,
    promptVersion: brief.promptVersion,
    createdAt: brief.createdAt.toISOString(),
    bodyMd: brief.bodyMd,
    citations,
  };
}

export async function listBriefs(ctx: AppContext, limit = 50): Promise<BriefSummary[]> {
  const rows = await ctx.db
    .select({ brief: briefs, event: earningsEvents, company: companies })
    .from(briefs)
    .innerJoin(earningsEvents, eq(earningsEvents.id, briefs.eventId))
    .innerJoin(companies, eq(companies.id, earningsEvents.companyId))
    .where(isNull(briefs.supersededAt))
    .orderBy(desc(earningsEvents.reportDate))
    .limit(limit);
  return rows.map(({ brief, event, company }) => ({
    eventId: event.id,
    ticker: company.ticker,
    fiscalPeriod: event.fiscalPeriod,
    reportDate: event.reportDate.toISOString(),
    version: brief.version,
    // The bold headline line, without markup and citation markers.
    headline: (brief.bodyMd.split("\n")[0] ?? "").replace(/\*\*/g, "").replace(/\s*(\[[MG]\d+\])+\s*$/, ""),
    createdAt: brief.createdAt.toISOString(),
  }));
}

/** The text around [start, end) of a document's clean text - what a citation click opens (§22). */
export async function documentContext(ctx: AppContext, documentId: string, start: number, end: number): Promise<DocumentContext> {
  const [doc] = await ctx.db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc?.cleanText) throw new AppError("DOCUMENT_NOT_FOUND", `document ${documentId} not found or not parsed`, 404);
  const s = Math.max(0, Math.min(start, doc.cleanText.length));
  const e = Math.max(s, Math.min(end, doc.cleanText.length));
  const from = Math.max(0, s - CONTEXT_CHARS);
  const to = Math.min(doc.cleanText.length, e + CONTEXT_CHARS);
  return {
    documentId,
    documentType: doc.type,
    sourceUrl: doc.sourceUrl,
    text: doc.cleanText.slice(from, to),
    highlightStart: s - from,
    highlightEnd: e - from,
  };
}
