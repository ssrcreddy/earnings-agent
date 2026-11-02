// UC-3 review queue (§3, §21, §22): low-confidence and failed extractions wait here for a human.
import { companies, documents, earningsEvents, guidance, metrics, reviewItems, type Db } from "@eia/db";
import {
  ExtractedGuidance,
  ExtractedMetric,
  nominalEndOf,
  type LlmGuidance,
  type LlmMetric,
  type ReviewAction,
  type ReviewEntry,
  type ReviewKind,
  type ReviewListResponse,
  type ReviewResult,
} from "@eia/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import { withTransaction, type AppContext, type TxScope } from "../context";
import { AppError } from "../errors";
import { pendingCount } from "../jobs/extract";
import { Q } from "../queues";
import { factValues, type CompanyFacts } from "./companyFacts";
import { recomputeEventStatus } from "./events";
import { locateQuote } from "./validate";

/** Characters of document text shown either side of a quote. */
const CONTEXT_CHARS = 600;
const PAGE_SIZE = 50;

interface Row {
  ticker: string;
  fiscalPeriod: string;
  fiscalYearEnd: string | null;
  cik: string;
  documentId: string;
  documentType: string;
  sourceUrl: string;
  cleanText: string | null;
}

export async function listReview(ctx: AppContext): Promise<ReviewListResponse> {
  const base = {
    ticker: companies.ticker,
    fiscalPeriod: earningsEvents.fiscalPeriod,
    fiscalYearEnd: companies.fiscalYearEnd,
    cik: companies.cik,
    documentId: documents.id,
    documentType: documents.type,
    sourceUrl: documents.sourceUrl,
    cleanText: documents.cleanText,
  };

  const candidates = await ctx.db
    .select({ r: reviewItems, ...base })
    .from(reviewItems)
    .innerJoin(documents, eq(documents.id, reviewItems.documentId))
    .innerJoin(earningsEvents, eq(earningsEvents.id, reviewItems.eventId))
    .innerJoin(companies, eq(companies.id, earningsEvents.companyId))
    .where(eq(reviewItems.status, "open"))
    .orderBy(asc(reviewItems.createdAt));
  const pendingMetrics = await ctx.db
    .select({ m: metrics, ...base })
    .from(metrics)
    .innerJoin(documents, eq(documents.id, metrics.documentId))
    .innerJoin(earningsEvents, eq(earningsEvents.id, metrics.eventId))
    .innerJoin(companies, eq(companies.id, earningsEvents.companyId))
    .where(eq(metrics.reviewStatus, "pending"))
    .orderBy(asc(metrics.createdAt));
  const pendingGuidance = await ctx.db
    .select({ g: guidance, ...base })
    .from(guidance)
    .innerJoin(documents, eq(documents.id, guidance.documentId))
    .innerJoin(earningsEvents, eq(earningsEvents.id, guidance.eventId))
    .innerJoin(companies, eq(companies.id, earningsEvents.companyId))
    .where(eq(guidance.reviewStatus, "pending"))
    .orderBy(asc(guidance.createdAt));

  const facts = new Map<string, CompanyFacts | null>();
  const factsFor = async (cik: string) => {
    if (!facts.has(cik)) {
      try {
        facts.set(cik, (await ctx.edgar.getCompanyFacts(cik)) as CompanyFacts);
      } catch {
        facts.set(cik, null);
      }
    }
    return facts.get(cik)!;
  };
  const metricFacts = async (row: Row, name: string, periodType: string) =>
    factValues(
      await factsFor(row.cik),
      name as LlmMetric["name"],
      periodType as LlmMetric["periodType"],
      nominalEndOf(row.fiscalPeriod, row.fiscalYearEnd ?? "1231"),
      row.fiscalPeriod,
    );

  const items: ReviewEntry[] = [];
  for (const c of candidates) {
    const cand = c.r.candidate as LlmMetric | LlmGuidance;
    items.push({
      kind: "candidate",
      id: c.r.id,
      ...entryBase(c),
      item: { itemKind: c.r.kind, ...cand },
      confidence: Number(cand.confidence),
      reasons: c.r.errors,
      regexValue: c.r.regexValue === null ? null : Number(c.r.regexValue),
      factValues: "name" in cand ? await metricFacts(c, cand.name, cand.periodType) : [],
      context: contextFor(c.cleanText, cand.quote, null),
    });
  }
  for (const r of pendingMetrics) {
    const m = r.m;
    items.push({
      kind: "metric",
      id: m.id,
      ...entryBase(r),
      item: { name: m.name, segment: m.segment, value: Number(m.value), unit: m.unit, periodType: m.periodType, quote: m.quote },
      confidence: Number(m.confidence),
      reasons: [`confidence ${Number(m.confidence)} is below the review threshold ${ctx.config.REVIEW_CONFIDENCE_THRESHOLD}`],
      regexValue: null,
      factValues: await metricFacts(r, m.name, m.periodType),
      context: contextFor(r.cleanText, m.quote, { start: m.charStart, end: m.charEnd }),
    });
  }
  for (const r of pendingGuidance) {
    const g = r.g;
    items.push({
      kind: "guidance",
      id: g.id,
      ...entryBase(r),
      item: {
        metric: g.metric,
        kind: g.kind,
        low: g.low === null ? null : Number(g.low),
        high: g.high === null ? null : Number(g.high),
        targetPeriod: g.targetPeriod,
        quote: g.quote,
      },
      confidence: Number(g.confidence),
      reasons: [`confidence ${Number(g.confidence)} is below the review threshold ${ctx.config.REVIEW_CONFIDENCE_THRESHOLD}`],
      regexValue: null,
      factValues: [],
      context: contextFor(r.cleanText, g.quote, { start: g.charStart, end: g.charEnd }),
    });
  }
  return { items: items.slice(0, PAGE_SIZE), total: items.length };
}

function entryBase(r: Row) {
  return {
    ticker: r.ticker,
    fiscalPeriod: r.fiscalPeriod,
    documentId: r.documentId,
    documentType: r.documentType,
    sourceUrl: r.sourceUrl,
  };
}

function contextFor(
  text: string | null,
  quote: string,
  known: { start: number; end: number } | null,
): ReviewEntry["context"] {
  if (!text) return { text: "", quoteStart: null, quoteEnd: null };
  const at = known ?? locateQuote(text, quote);
  if (!at) return { text: text.slice(0, CONTEXT_CHARS * 2), quoteStart: null, quoteEnd: null };
  const from = Math.max(0, at.start - CONTEXT_CHARS);
  const to = Math.min(text.length, at.end + CONTEXT_CHARS);
  return { text: text.slice(from, to), quoteStart: at.start - from, quoteEnd: at.end - from };
}

export async function applyReview(ctx: AppContext, kind: ReviewKind, id: string, action: ReviewAction): Promise<ReviewResult> {
  const result = await withTransaction(ctx, async (tx) => {
    if (kind === "candidate") return reviewCandidate(ctx, tx, id, action);
    if (kind === "metric") return reviewMetric(ctx, tx, id, action);
    return reviewGuidance(ctx, tx, id, action);
  });
  // The golden case is written after the commit: a failed write must not undo the human's decision.
  let goldenFile: string | null = null;
  if (result.golden) {
    try {
      goldenFile = await result.golden();
    } catch (err) {
      ctx.log.error({ err, kind, id }, "failed to record golden case");
    }
  }
  return { kind, id, status: result.status, rowId: result.rowId, goldenFile, documentStatus: result.documentStatus };
}

interface Applied {
  status: string;
  rowId: string | null;
  documentStatus: string;
  golden: (() => Promise<string>) | null;
}

async function documentFor(db: Db, documentId: string) {
  const [row] = await db
    .select({ doc: documents, event: earningsEvents, company: companies })
    .from(documents)
    .innerJoin(earningsEvents, eq(earningsEvents.id, documents.eventId))
    .innerJoin(companies, eq(companies.id, earningsEvents.companyId))
    .where(eq(documents.id, documentId));
  if (!row) throw new AppError("REVIEW_ITEM_NOT_FOUND", `document ${documentId} not found`, 404);
  return row;
}

/** A correction's quote must be text that exists in the document, like any extraction's. */
function locateOrThrow(text: string | null, quote: string) {
  const at = text ? locateQuote(text, quote) : null;
  if (!at) throw new AppError("QUOTE_NOT_FOUND", "The quote must be copied exactly from the document", 422);
  return at;
}

/** Once nothing from a document waits for review, it counts as extracted and the event can move on. */
async function settleDocument(ctx: AppContext, tx: TxScope, documentId: string, eventId: string): Promise<string> {
  const remaining = await pendingCount(tx.db, documentId);
  const [doc] = await tx.db.select({ status: documents.status }).from(documents).where(eq(documents.id, documentId));
  let status = doc!.status;
  if (remaining === 0 && status === "needs_review") {
    await tx.db.update(documents).set({ status: "extracted", lastError: null }).where(eq(documents.id, documentId));
    status = "extracted";
  }
  // Human approves -> resume at compare (§14).
  if ((await recomputeEventStatus(tx.db, eventId)) === "extracted") {
    await ctx.boss.send(Q.compareAndBrief, { eventId }, { singletonKey: eventId, db: tx.queue });
  }
  return status;
}

async function reviewMetric(ctx: AppContext, tx: TxScope, id: string, action: ReviewAction): Promise<Applied> {
  const [m] = await tx.db.select().from(metrics).where(eq(metrics.id, id));
  if (!m) throw new AppError("REVIEW_ITEM_NOT_FOUND", `metric ${id} not found`, 404);
  if (m.reviewStatus !== "pending") throw new AppError("REVIEW_CONFLICT", `metric ${id} is already ${m.reviewStatus}`, 409);
  if (action.action === "reject") {
    throw new AppError("REVIEW_CONFLICT", "A validated metric can be approved or corrected, not rejected", 409);
  }
  const { doc, event, company } = await documentFor(tx.db, m.documentId);
  if (action.action === "approve") {
    await tx.db.update(metrics).set({ reviewStatus: "approved" }).where(eq(metrics.id, id));
    return { status: "approved", rowId: id, documentStatus: await settleDocument(ctx, tx, doc.id, event.id), golden: null };
  }
  if (action.value === undefined) throw new AppError("VALIDATION_FAILED", "A metric correction needs a value", 400);
  const at = locateOrThrow(doc.cleanText, action.quote);
  await tx.db
    .update(metrics)
    .set({
      value: String(action.value),
      quote: action.quote,
      charStart: at.start,
      charEnd: at.end,
      reviewStatus: "corrected",
      originalValue: m.value,
      originalQuote: m.quote,
    })
    .where(eq(metrics.id, id));
  const value = action.value;
  return {
    status: "corrected",
    rowId: id,
    documentStatus: await settleDocument(ctx, tx, doc.id, event.id),
    golden: goldenMetric(ctx, { doc, event, company }, { ...m, value, quote: action.quote }, Number(m.value)),
  };
}

async function reviewGuidance(ctx: AppContext, tx: TxScope, id: string, action: ReviewAction): Promise<Applied> {
  const [g] = await tx.db.select().from(guidance).where(eq(guidance.id, id));
  if (!g) throw new AppError("REVIEW_ITEM_NOT_FOUND", `guidance ${id} not found`, 404);
  if (g.reviewStatus !== "pending") throw new AppError("REVIEW_CONFLICT", `guidance ${id} is already ${g.reviewStatus}`, 409);
  if (action.action === "reject") {
    throw new AppError("REVIEW_CONFLICT", "Validated guidance can be approved or corrected, not rejected", 409);
  }
  const { doc, event, company } = await documentFor(tx.db, g.documentId);
  if (action.action === "approve") {
    await tx.db.update(guidance).set({ reviewStatus: "approved" }).where(eq(guidance.id, id));
    return { status: "approved", rowId: id, documentStatus: await settleDocument(ctx, tx, doc.id, event.id), golden: null };
  }
  const at = locateOrThrow(doc.cleanText, action.quote);
  const low = action.low === undefined ? (g.low === null ? null : Number(g.low)) : action.low;
  const high = action.high === undefined ? (g.high === null ? null : Number(g.high)) : action.high;
  await tx.db
    .update(guidance)
    .set({
      low: low === null ? null : String(low),
      high: high === null ? null : String(high),
      quote: action.quote,
      charStart: at.start,
      charEnd: at.end,
      reviewStatus: "corrected",
      originalLow: g.low,
      originalHigh: g.high,
      originalQuote: g.quote,
    })
    .where(eq(guidance.id, id));
  return {
    status: "corrected",
    rowId: id,
    documentStatus: await settleDocument(ctx, tx, doc.id, event.id),
    golden: goldenGuidance(ctx, { doc, event, company }, { ...g, low, high, quote: action.quote }, g),
  };
}

/** A failed candidate becomes a real row only through a human correction (or is rejected). */
async function reviewCandidate(ctx: AppContext, tx: TxScope, id: string, action: ReviewAction): Promise<Applied> {
  const [item] = await tx.db.select().from(reviewItems).where(eq(reviewItems.id, id));
  if (!item) throw new AppError("REVIEW_ITEM_NOT_FOUND", `review item ${id} not found`, 404);
  if (item.status !== "open") throw new AppError("REVIEW_CONFLICT", `review item ${id} is already ${item.status}`, 409);
  if (action.action === "approve") {
    throw new AppError("REVIEW_CONFLICT", "This item failed validation; correct it or reject it", 409);
  }
  const { doc, event, company } = await documentFor(tx.db, item.documentId);
  if (action.action === "reject") {
    await tx.db.update(reviewItems).set({ status: "rejected", resolvedAt: new Date() }).where(eq(reviewItems.id, id));
    return { status: "rejected", rowId: null, documentStatus: await settleDocument(ctx, tx, doc.id, event.id), golden: null };
  }

  const at = locateOrThrow(doc.cleanText, action.quote);
  const common = {
    eventId: event.id,
    quote: action.quote,
    documentId: doc.id,
    charStart: at.start,
    charEnd: at.end,
    confidence: "1",
    reviewStatus: "corrected" as const,
    promptVersion: item.promptVersion,
    model: item.model,
  };

  let rowId: string;
  let golden: Applied["golden"];
  if (item.kind === "metric") {
    const cand = item.candidate as LlmMetric;
    if (action.value === undefined) throw new AppError("VALIDATION_FAILED", "A metric correction needs a value", 400);
    const fixed = ExtractedMetric.safeParse({ ...cand, value: action.value, quote: action.quote, confidence: 1 });
    if (!fixed.success) throw new AppError("VALIDATION_FAILED", fixed.error.issues.map((i) => i.message).join("; "), 400);
    // A disagreement candidate targets an existing row: the human's value replaces it.
    const [existing] = await tx.db
      .select()
      .from(metrics)
      .where(
        and(
          eq(metrics.eventId, event.id),
          eq(metrics.name, cand.name),
          eq(metrics.periodType, cand.periodType),
          cand.segment === null ? isNull(metrics.segment) : eq(metrics.segment, cand.segment),
        ),
      );
    const values = {
      ...common,
      name: cand.name,
      segment: cand.segment,
      value: String(action.value),
      unit: cand.unit,
      periodType: cand.periodType,
      originalValue: String(cand.value),
      originalQuote: cand.quote,
    };
    if (existing) {
      await tx.db.update(metrics).set(values).where(eq(metrics.id, existing.id));
      rowId = existing.id;
    } else {
      const [ins] = await tx.db.insert(metrics).values(values).returning({ id: metrics.id });
      rowId = ins!.id;
    }
    golden = goldenMetric(ctx, { doc, event, company }, { ...cand, value: action.value, quote: action.quote }, cand.value);
  } else {
    const cand = item.candidate as LlmGuidance;
    const low = action.low === undefined ? cand.low : action.low;
    const high = action.high === undefined ? cand.high : action.high;
    const fixed = ExtractedGuidance.safeParse({ ...cand, low, high, quote: action.quote, confidence: 1 });
    if (!fixed.success) throw new AppError("VALIDATION_FAILED", fixed.error.issues.map((i) => i.message).join("; "), 400);
    const values = {
      ...common,
      companyId: event.companyId,
      metric: cand.metric,
      kind: cand.kind,
      low: low === null ? null : String(low),
      high: high === null ? null : String(high),
      targetPeriod: cand.targetPeriod,
      originalLow: cand.low === null ? null : String(cand.low),
      originalHigh: cand.high === null ? null : String(cand.high),
      originalQuote: cand.quote,
    };
    const [ins] = await tx.db
      .insert(guidance)
      .values(values)
      .onConflictDoUpdate({ target: [guidance.eventId, guidance.metric, guidance.targetPeriod], set: values })
      .returning({ id: guidance.id });
    rowId = ins!.id;
    golden = goldenGuidance(ctx, { doc, event, company }, { ...cand, low, high, quote: action.quote }, cand);
  }

  await tx.db
    .update(reviewItems)
    .set({ status: "corrected", resolvedRowId: rowId, resolvedAt: new Date() })
    .where(eq(reviewItems.id, id));
  return { status: "corrected", rowId, documentStatus: await settleDocument(ctx, tx, doc.id, event.id), golden };
}

type DocContext = Awaited<ReturnType<typeof documentFor>>;

function goldenMetric(
  ctx: AppContext,
  { doc, event, company }: DocContext,
  m: { name: string; segment: string | null; periodType: string; unit: string; value: number | string; quote: string },
  modelValue: number | null,
) {
  return async () =>
    ctx.golden.record(
      company.ticker,
      event.fiscalPeriod,
      { type: doc.type, sourceUrl: doc.sourceUrl, rawPath: doc.rawPath, bytes: await ctx.raw.read(doc.rawPath) },
      {
        metric: {
          name: m.name,
          segment: m.segment,
          periodType: m.periodType,
          value: Number(m.value),
          unit: m.unit,
          quote: m.quote,
          modelValue,
          documentType: doc.type,
          correctedAt: new Date().toISOString(),
        },
      },
    );
}

function goldenGuidance(
  ctx: AppContext,
  { doc, event, company }: DocContext,
  g: { metric: string; kind: string; low: number | null; high: number | null; targetPeriod: string; quote: string },
  model: { low: number | string | null; high: number | string | null },
) {
  return async () =>
    ctx.golden.record(
      company.ticker,
      event.fiscalPeriod,
      { type: doc.type, sourceUrl: doc.sourceUrl, rawPath: doc.rawPath, bytes: await ctx.raw.read(doc.rawPath) },
      {
        guidance: {
          metric: g.metric,
          kind: g.kind,
          low: g.low,
          high: g.high,
          targetPeriod: g.targetPeriod,
          quote: g.quote,
          modelLow: model.low === null ? null : Number(model.low),
          modelHigh: model.high === null ? null : Number(model.high),
          documentType: doc.type,
          correctedAt: new Date().toISOString(),
        },
      },
    );
}
