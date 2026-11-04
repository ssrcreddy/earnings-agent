import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunks, companies, documents, earningsEvents, guidance, metrics, reviewItems, type Db } from "@eia/db";
import { LlmExtractionResult, nominalEndOf, type DocumentType, type ReviewStatus } from "@eia/shared";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Config } from "../config";
import { withTransaction, type AppContext } from "../context";
import { SCHEMA_TOKEN_ALLOWANCE } from "../llm/gateway";
import { countTokens } from "../parsing/chunker";
import { parseHeadlineTable, type HeadlineFigure } from "../parsing/headline";
import { cleanHtml } from "../parsing/html";
import { approxEqual } from "../parsing/numbers";
import { labelSections } from "../parsing/sections";
import { Q, type DocumentPayload } from "../queues";
import type { CompanyFacts } from "../services/companyFacts";
import { recomputeEventStatus } from "../services/events";
import {
  guidanceKey,
  metricKey,
  runExtraction,
  WINDOW_TOKENS,
  type ExtractionOutcome,
  type Failure,
  type ModelCall,
  type ValidGuidance,
  type ValidMetric,
} from "../services/extraction";
import { VALUE_TOLERANCE, type ValidationContext } from "../services/validate";

export const EXTRACT_PROMPT_VERSION = "extract.v1";
const EXTRACT_INSTRUCTIONS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../llm/prompts", `${EXTRACT_PROMPT_VERSION}.md`),
  "utf8",
);

export type ExtractResult =
  | {
      documentId: string;
      metrics: number;
      guidance: number;
      review: number;
      calls: number;
      documentStatus: "extracted" | "needs_review";
    }
  | { skipped: "missing" | "superseded" | "not_parsed" | "no_llm" };

/**
 * §6 step 4 / §18: structured extraction with a verbatim quote per item, validated in code. Valid
 * items are saved (auto-approved at or above the confidence threshold, pending below it); items that
 * fail twice go to the review queue. Nothing unvalidated is ever written to metrics or guidance.
 */
export async function extractJob(ctx: AppContext, { documentId }: DocumentPayload, call?: ModelCall): Promise<ExtractResult> {
  const [row] = await ctx.db
    .select({ doc: documents, event: earningsEvents, company: companies })
    .from(documents)
    .innerJoin(earningsEvents, eq(earningsEvents.id, documents.eventId))
    .innerJoin(companies, eq(companies.id, earningsEvents.companyId))
    .where(eq(documents.id, documentId));
  if (!row) return { skipped: "missing" };
  const { doc, event, company } = row;
  if (doc.supersededAt) return { skipped: "superseded" };
  if (!doc.cleanText) return { skipped: "not_parsed" };

  const model = ctx.config.STRONG_MODEL;
  const modelCall = call ?? extractionModelCall(ctx, { eventId: event.id, documentId });
  if (!modelCall) {
    // Leave the document parsed; POST /events/:id/reprocess re-runs extraction once a model is set.
    ctx.log.warn({ documentId }, "no extraction model configured (OPENAI_API_KEY + STRONG_MODEL); skipping");
    return { skipped: "no_llm" };
  }

  const fye = company.fiscalYearEnd ?? "1231";
  const vc: ValidationContext = {
    text: doc.cleanText,
    docType: doc.type,
    fiscalPeriod: event.fiscalPeriod,
    periodEnd: nominalEndOf(event.fiscalPeriod, fye),
    facts: await loadFacts(ctx, company.cik),
    headline: doc.type === "press_release" ? await headlineFigures(ctx, doc.rawPath) : [],
  };
  const header = extractionHeader(company.ticker, company.name, doc.type, event.fiscalPeriod, vc.periodEnd);

  const outcome = await runExtraction(
    modelCall,
    await extractionParts(ctx, doc.id, doc.type, doc.cleanText, header),
    vc,
    extractionWindowTokens(ctx.config),
  );
  const usedModel = call ? "injected" : model;
  return persist(ctx, { doc, event, outcome, model: usedModel });
}

/** The configured extraction model as a ModelCall, or null when none is set. Shared with the eval (§24). */
export function extractionModelCall(ctx: AppContext, meta: { eventId?: string; documentId?: string } = {}): ModelCall | null {
  const model = ctx.config.STRONG_MODEL;
  if (!ctx.llm || !model) return null;
  const llm = ctx.llm;
  return (input) =>
    llm.generateStructured({
      purpose: "extract",
      promptVersion: EXTRACT_PROMPT_VERSION,
      ...meta,
      model,
      instructions: EXTRACT_INSTRUCTIONS,
      input,
      schema: LlmExtractionResult,
      schemaName: "extraction_result",
      reasoningEffort: ctx.config.EXTRACT_REASONING_EFFORT,
      // A ceiling, not a target: reasoning models spend hidden reasoning tokens from this budget.
      maxOutputTokens: 8000,
    });
}

/** Room left for the request header and retry notes in each call. */
const HEADER_ALLOWANCE = 400;

/**
 * Document tokens per extraction call. Under a tokens-per-minute limit, a window must leave room
 * for the instructions, schema, header and expected output; otherwise the default window applies.
 */
export function extractionWindowTokens(config: Pick<Config, "LLM_TPM_LIMIT" | "LLM_OUTPUT_RESERVE">): number {
  if (!config.LLM_TPM_LIMIT) return WINDOW_TOKENS;
  // The gateway reserves input x 1.1 + output; solve for the document's share of the limit.
  const inputBudget = (config.LLM_TPM_LIMIT - config.LLM_OUTPUT_RESERVE) / 1.1;
  const window = Math.floor(inputBudget - countTokens(EXTRACT_INSTRUCTIONS) - SCHEMA_TOKEN_ALLOWANCE - HEADER_ALLOWANCE);
  if (window < 1000) {
    throw new Error(
      `LLM_TPM_LIMIT ${config.LLM_TPM_LIMIT} leaves only ${window} document tokens per call; raise the limit or lower LLM_OUTPUT_RESERVE`,
    );
  }
  return Math.min(window, WINDOW_TOKENS);
}

/** The request header every extraction call carries: company, document and the period in force. */
export function extractionHeader(ticker: string, name: string, type: DocumentType, fiscalPeriod: string, periodEnd: Date): string {
  return [
    `Company: ${ticker} (${name})`,
    `Document: ${describe(type)}`,
    `Fiscal period in force: ${fiscalPeriod} (fiscal year ${fiscalPeriod.slice(0, 4)}, quarter ending around ${periodEnd.toISOString().slice(0, 10)})`,
  ].join("\n");
}

function describe(type: DocumentType): string {
  return { press_release: "earnings press release", filing_10q: "Form 10-Q", filing_10k: "Form 10-K", transcript: "call transcript" }[type];
}

async function loadFacts(ctx: AppContext, cik: string): Promise<CompanyFacts | null> {
  try {
    return (await ctx.edgar.getCompanyFacts(cik)) as CompanyFacts;
  } catch (err) {
    // The cross-check is optional: without facts, values must appear in their quotes.
    ctx.log.warn({ err, cik }, "company facts unavailable; validating against quotes only");
    return null;
  }
}

async function headlineFigures(ctx: AppContext, rawPath: string): Promise<HeadlineFigure[]> {
  const clean = cleanHtml((await ctx.raw.read(rawPath)).toString("utf8"));
  return parseHeadlineTable(clean.text, labelSections("press_release", clean.blocks));
}

/**
 * What the model reads (§18 step 1): a press release whole; a 10-Q/10-K by its MD&A section, never
 * the whole filing in one call. A filing whose MD&A wasn't found is read whole, in windows.
 */
async function extractionParts(ctx: AppContext, documentId: string, type: DocumentType, text: string, header: string) {
  if (type === "press_release") return [{ header, text }];
  const rows = await ctx.db
    .select({ start: chunks.charStart, end: chunks.charEnd })
    .from(chunks)
    .where(and(eq(chunks.documentId, documentId), eq(chunks.section, "mda")))
    .orderBy(asc(chunks.seq));
  if (rows.length === 0) {
    ctx.log.warn({ documentId }, "no MD&A section found; extracting from the whole filing");
    return [{ header, text }];
  }
  const start = Math.min(...rows.map((r) => r.start));
  const end = Math.max(...rows.map((r) => r.end));
  return [{ header: `${header}\nSection: Management's Discussion and Analysis`, text: text.slice(start, end) }];
}

type DocRow = typeof documents.$inferSelect;
type EventRow = typeof earningsEvents.$inferSelect;

async function persist(
  ctx: AppContext,
  { doc, event, outcome, model }: { doc: DocRow; event: EventRow; outcome: ExtractionOutcome; model: string },
): Promise<ExtractResult> {
  const threshold = ctx.config.REVIEW_CONFIDENCE_THRESHOLD;
  const status = (confidence: number): ReviewStatus => (confidence >= threshold ? "auto_approved" : "pending");
  const base = { promptVersion: EXTRACT_PROMPT_VERSION, model };

  return withTransaction(ctx, async (tx) => {
    const failures: Failure[] = [...outcome.failures];
    let savedMetrics = 0;
    let savedGuidance = 0;

    const existingMetrics = new Map(
      (await tx.db.select().from(metrics).where(eq(metrics.eventId, event.id))).map((m) => [metricKey(m), m]),
    );
    for (const v of outcome.metrics) {
      const m = v.item;
      const values = {
        eventId: event.id,
        name: m.name,
        segment: m.segment,
        value: String(m.value),
        unit: m.unit,
        periodType: m.periodType,
        quote: m.quote,
        documentId: doc.id,
        charStart: v.charStart,
        charEnd: v.charEnd,
        confidence: String(m.confidence),
        reviewStatus: status(m.confidence),
        ...base,
      };
      const existing = existingMetrics.get(metricKey(m));
      if (!existing) {
        await tx.db.insert(metrics).values(values);
        savedMetrics++;
      } else if (existing.documentId === doc.id && !isHumanReviewed(existing.reviewStatus)) {
        // Re-extraction of the same document: replace the machine-made row.
        await tx.db.update(metrics).set(values).where(eq(metrics.id, existing.id));
        savedMetrics++;
      } else if (!approxEqual(Number(existing.value), m.value, VALUE_TOLERANCE)) {
        failures.push(disagreement(v, existing.value, doc.type));
      }
      // Otherwise another document already stated the same value: corroborated, nothing to write.
    }

    const existingGuidance = new Map(
      (await tx.db.select().from(guidance).where(eq(guidance.eventId, event.id))).map((g) => [guidanceKey(g), g]),
    );
    for (const v of outcome.guidance) {
      const g = v.item;
      const values = {
        eventId: event.id,
        companyId: event.companyId,
        metric: g.metric,
        kind: g.kind,
        low: g.low === null ? null : String(g.low),
        high: g.high === null ? null : String(g.high),
        targetPeriod: g.targetPeriod,
        quote: g.quote,
        documentId: doc.id,
        charStart: v.charStart,
        charEnd: v.charEnd,
        confidence: String(g.confidence),
        reviewStatus: status(g.confidence),
        ...base,
      };
      const existing = existingGuidance.get(guidanceKey(g));
      if (!existing) {
        await tx.db.insert(guidance).values(values);
        savedGuidance++;
      } else if (existing.documentId === doc.id && !isHumanReviewed(existing.reviewStatus)) {
        await tx.db.update(guidance).set(values).where(eq(guidance.id, existing.id));
        savedGuidance++;
      } else if (!sameGuide(existing, g)) {
        failures.push({
          kind: "guidance",
          candidate: g,
          errors: [`guidance ${g.metric} ${g.targetPeriod}: this ${describe(doc.type)} disagrees with the guide already recorded`],
        });
      }
    }

    // A human already settled these - by approving, correcting or rejecting: re-extraction must not reopen them.
    const decided = await tx.db
      .select({ kind: reviewItems.kind, candidate: reviewItems.candidate })
      .from(reviewItems)
      .where(and(eq(reviewItems.documentId, doc.id), inArray(reviewItems.status, ["corrected", "rejected"])));
    const settled = new Set([
      ...[...existingMetrics.values()].filter((m) => isHumanReviewed(m.reviewStatus)).map((m) => `metric:${metricKey(m)}`),
      ...[...existingGuidance.values()].filter((g) => isHumanReviewed(g.reviewStatus)).map((g) => `guidance:${guidanceKey(g)}`),
      ...decided.map((d) =>
        d.kind === "metric"
          ? `metric:${metricKey(d.candidate as Parameters<typeof metricKey>[0])}`
          : `guidance:${guidanceKey(d.candidate as Parameters<typeof guidanceKey>[0])}`,
      ),
    ]);
    const open = failures.filter(
      (f) => !settled.has(f.kind === "metric" ? `metric:${metricKey(f.candidate)}` : `guidance:${guidanceKey(f.candidate)}`),
    );

    // Re-extraction replaces this document's open review items.
    await tx.db
      .delete(reviewItems)
      .where(and(eq(reviewItems.documentId, doc.id), eq(reviewItems.status, "open")));
    if (open.length) {
      await tx.db.insert(reviewItems).values(
        open.map((f) => ({
          kind: f.kind,
          eventId: event.id,
          documentId: doc.id,
          candidate: f.candidate,
          errors: f.errors,
          regexValue: f.kind === "metric" && f.regexValue !== null ? String(f.regexValue) : null,
          ...base,
        })),
      );
    }

    // Open review items + validated rows below the confidence threshold.
    const pending = await pendingCount(tx.db, doc.id);
    const needsReview = pending > 0 || outcome.attemptErrors.length > 0;
    const documentStatus = needsReview ? "needs_review" : "extracted";
    await tx.db
      .update(documents)
      .set({ status: documentStatus, lastError: outcome.attemptErrors.join("; ").slice(0, 2000) || null })
      .where(eq(documents.id, doc.id));

    // Compare runs once every document of the event is extracted or approved (§19).
    if ((await recomputeEventStatus(tx.db, event.id)) === "extracted") {
      await ctx.boss.send(Q.compareAndBrief, { eventId: event.id }, { singletonKey: event.id, db: tx.queue });
    }

    return {
      documentId: doc.id,
      metrics: savedMetrics,
      guidance: savedGuidance,
      review: pending,
      calls: outcome.calls,
      documentStatus,
    };
  });
}

function isHumanReviewed(s: ReviewStatus): boolean {
  return s === "approved" || s === "corrected";
}

function sameGuide(existing: typeof guidance.$inferSelect, g: ValidGuidance["item"]): boolean {
  if (existing.kind !== g.kind) return false;
  const eq = (a: string | null, b: number | null) => (a === null ? b === null : b !== null && approxEqual(Number(a), b, VALUE_TOLERANCE));
  return eq(existing.low, g.low) && eq(existing.high, g.high);
}

function disagreement(v: ValidMetric, recorded: string, type: DocumentType): Failure {
  const m = v.item;
  return {
    kind: "metric",
    candidate: { ...m },
    errors: [
      `${m.name} [${m.periodType}]: this ${describe(type)} states ${m.value}, but ${recorded} is already recorded from another document`,
    ],
    regexValue: null,
  };
}

/** Rows from this document still waiting for a human (validated, but below the confidence threshold). */
export async function pendingCount(db: Db, documentId: string): Promise<number> {
  const [m] = await db
    .select({ n: count() })
    .from(metrics)
    .where(and(eq(metrics.documentId, documentId), eq(metrics.reviewStatus, "pending")));
  const [g] = await db
    .select({ n: count() })
    .from(guidance)
    .where(and(eq(guidance.documentId, documentId), eq(guidance.reviewStatus, "pending")));
  const [r] = await db
    .select({ n: count() })
    .from(reviewItems)
    .where(and(eq(reviewItems.documentId, documentId), inArray(reviewItems.status, ["open"])));
  return (m?.n ?? 0) + (g?.n ?? 0) + (r?.n ?? 0);
}
