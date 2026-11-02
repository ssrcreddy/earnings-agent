import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  alerts,
  briefs,
  companies,
  consensusSnapshots,
  documents,
  earningsEvents,
  guidance,
  metrics,
  type Db,
} from "@eia/db";
import { MetricName, type DocumentStatus, type GuidanceChange, type Verdict } from "@eia/shared";
import { and, desc, eq, isNull, lt, max, ne } from "drizzle-orm";
import { withTransaction, type AppContext } from "../context";
import { compareGuidance, deriveQ4, priorYearPeriod, verdictFor, yoyChange } from "../services/compare";
import { renderTemplateBrief, briefInput, writeBrief, type BriefDrafter } from "../services/briefWriter";
import { eventStatusFromDocuments } from "../services/eventStatus";
import { formatTargetPeriod, metricLabel, type FactSheet, type GuidanceFact, type MetricFact } from "../services/factSheet";
import type { EventPayload } from "../queues";

export const BRIEF_PROMPT_VERSION = "brief.v1";
export const TEMPLATE_VERSION = "brief.template.v1";
const BRIEF_INSTRUCTIONS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../llm/prompts", `${BRIEF_PROMPT_VERSION}.md`),
  "utf8",
);

export type CompareAndBriefResult =
  | { eventId: string; metrics: number; guidance: number; derived: number; brief: "published" | "unchanged" | "withheld"; version: number | null; writer: string }
  | { skipped: "missing" | "not_ready" };

type MetricRow = typeof metrics.$inferSelect;
type GuidanceRow = typeof guidance.$inferSelect;
type EventRow = typeof earningsEvents.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;

const VOCAB_ORDER = MetricName.options;
const usable = (s: string) => s !== "pending";

/**
 * §6 step 5-6 / §19-20: deterministic comparison, then a brief from compared facts only.
 * Runs once every live document of the event is extracted (or approved in review).
 */
export async function compareAndBriefJob(
  ctx: AppContext,
  { eventId }: EventPayload,
  drafterOverride?: { drafter: BriefDrafter; model: string; promptVersion: string },
): Promise<CompareAndBriefResult> {
  const [row] = await ctx.db
    .select({ event: earningsEvents, company: companies })
    .from(earningsEvents)
    .innerJoin(companies, eq(companies.id, earningsEvents.companyId))
    .where(eq(earningsEvents.id, eventId));
  if (!row) return { skipped: "missing" };
  const { event, company } = row;

  const docs = await ctx.db
    .select({ status: documents.status })
    .from(documents)
    .where(and(eq(documents.eventId, eventId), isNull(documents.supersededAt)));
  if (eventStatusFromDocuments(docs.map((d) => d.status as DocumentStatus)) !== "extracted") {
    return { skipped: "not_ready" };
  }

  const derived = await deriveMissingQ4(ctx, event);

  // --- Compare (§19), written onto the rows themselves -----------------------------------------
  const rows = (await ctx.db.select().from(metrics).where(eq(metrics.eventId, eventId))).filter((m) =>
    usable(m.reviewStatus),
  );
  const guides = (await ctx.db.select().from(guidance).where(eq(guidance.eventId, eventId))).filter((g) =>
    usable(g.reviewStatus),
  );
  const snapshots = await ctx.db.select().from(consensusSnapshots).where(eq(consensusSnapshots.eventId, eventId));
  // One provider, named; never blended (§2 principle 3). Prefer the configured provider's snapshot.
  const consensusFor = (name: string) =>
    snapshots.find((s) => s.metric === name && s.provider === ctx.config.DATA_PROVIDER) ??
    snapshots.find((s) => s.metric === name) ??
    null;

  const previousGuides = new Map<string, { row: GuidanceRow; fiscalPeriod: string }>();
  for (const g of guides) {
    const prev = await previousGuide(ctx.db, event, g);
    if (prev) previousGuides.set(g.id, prev);
  }

  await withTransaction(ctx, async (tx) => {
    for (const m of rows) {
      // Consensus exists for consolidated quarterly figures only.
      const comparable = m.periodType === "quarter" && m.segment === null;
      const snap = comparable ? consensusFor(m.name) : null;
      const v = comparable ? verdictFor(m.name, m.value, snap?.value ?? null) : null;
      await tx.db
        .update(metrics)
        .set({
          consensusValue: snap?.value ?? null,
          consensusProvider: snap?.provider ?? null,
          consensusAsOf: snap?.asOf ?? null,
          // Relative surprise; margins are compared in points, which the fact sheet derives.
          surprisePct: v?.surprisePct ?? null,
          verdict: (v?.verdict ?? null) as Verdict | null,
        })
        .where(eq(metrics.id, m.id));
    }
    for (const g of guides) {
      const prev = previousGuides.get(g.id)?.row ?? null;
      const cmp = compareGuidance(
        { id: g.id, kind: g.kind, low: g.low, high: g.high },
        prev ? { id: prev.id, kind: prev.kind, low: prev.low, high: prev.high } : null,
      );
      await tx.db
        .update(guidance)
        .set({ prevGuidanceId: prev?.id ?? null, change: cmp.change, compareInputs: cmp.inputs })
        .where(eq(guidance.id, g.id));
    }
    await tx.db
      .update(earningsEvents)
      .set({ status: "compared", lastError: null, updatedAt: new Date() })
      .where(eq(earningsEvents.id, eventId));
  });

  // --- Brief (§20) -------------------------------------------------------------------------------
  const sheet = await buildFactSheet(ctx, event, company);
  const writer = drafterOverride ?? chooseDrafter(ctx, eventId);
  const outcome = await writeBrief(sheet, writer.drafter);

  if (!outcome.ok) {
    // A brief that fails the post-check twice is withheld, never published unchecked.
    await withTransaction(ctx, async (tx) => {
      await tx.db
        .update(earningsEvents)
        .set({ lastError: `brief withheld: ${outcome.errors.join("; ")}`.slice(0, 2000), updatedAt: new Date() })
        .where(eq(earningsEvents.id, eventId));
      await tx.db.insert(alerts).values({
        eventId,
        kind: "brief_withheld",
        message: `${company.ticker} ${event.fiscalPeriod} brief withheld: it failed the fact check twice`,
      });
    });
    return { eventId, metrics: sheet.metrics.length, guidance: sheet.guidance.length, derived, brief: "withheld", version: null, writer: writer.model };
  }

  const metricIds = outcome.cited.filter((id) => id.startsWith("M")).map((id) => sheet.metrics.find((m) => m.id === id)!.rowId);
  const guidanceIds = outcome.cited.filter((id) => id.startsWith("G")).map((id) => sheet.guidance.find((g) => g.id === id)!.rowId);
  const citations = Object.fromEntries(
    outcome.cited.map((id) =>
      id.startsWith("M")
        ? [id, { kind: "metric" as const, rowId: sheet.metrics.find((m) => m.id === id)!.rowId }]
        : [id, { kind: "guidance" as const, rowId: sheet.guidance.find((g) => g.id === id)!.rowId }],
    ),
  );

  const published = await withTransaction(ctx, async (tx) => {
    const [current] = await tx.db
      .select()
      .from(briefs)
      .where(and(eq(briefs.eventId, eventId), isNull(briefs.supersededAt)));
    // Re-running on unchanged facts is a no-op, not a new version.
    if (current && current.bodyMd === outcome.body) {
      await tx.db.update(earningsEvents).set({ status: "briefed", updatedAt: new Date() }).where(eq(earningsEvents.id, eventId));
      return { brief: "unchanged" as const, version: current.version };
    }
    const [{ v } = { v: 0 }] = await tx.db
      .select({ v: max(briefs.version) })
      .from(briefs)
      .where(eq(briefs.eventId, eventId));
    const version = (v ?? 0) + 1;
    // Briefs are never edited in place: the old version is marked superseded (§12, fix 3).
    if (current) await tx.db.update(briefs).set({ supersededAt: new Date() }).where(eq(briefs.id, current.id));
    await tx.db.insert(briefs).values({
      eventId,
      version,
      bodyMd: outcome.body,
      metricIds,
      guidanceIds,
      citations,
      model: writer.model,
      promptVersion: writer.promptVersion,
    });
    await tx.db.update(earningsEvents).set({ status: "briefed", lastError: null, updatedAt: new Date() }).where(eq(earningsEvents.id, eventId));
    await tx.db.insert(alerts).values(alertsFor(sheet, eventId, version));
    return { brief: "published" as const, version };
  });

  return { eventId, metrics: sheet.metrics.length, guidance: sheet.guidance.length, derived, ...published, writer: writer.model };
}

function chooseDrafter(ctx: AppContext, eventId: string): { drafter: BriefDrafter; model: string; promptVersion: string } {
  const model = ctx.config.STRONG_MODEL;
  if (ctx.llm && model) {
    const llm = ctx.llm;
    return {
      model,
      promptVersion: BRIEF_PROMPT_VERSION,
      drafter: (sheet, errors) =>
        llm.generateText({
          purpose: "brief",
          promptVersion: BRIEF_PROMPT_VERSION,
          eventId,
          model,
          instructions: BRIEF_INSTRUCTIONS,
          input: briefInput(sheet, errors),
          maxOutputTokens: 2000,
        }),
    };
  }
  // No model configured: the deterministic template, through the same post-check.
  return { model: "template", promptVersion: TEMPLATE_VERSION, drafter: async (sheet) => renderTemplateBrief(sheet) };
}

/** Same company, metric and target period, most recent earlier event (§19). Pending rows don't count. */
async function previousGuide(db: Db, event: EventRow, g: GuidanceRow) {
  const [prev] = await db
    .select({ row: guidance, fiscalPeriod: earningsEvents.fiscalPeriod })
    .from(guidance)
    .innerJoin(earningsEvents, eq(earningsEvents.id, guidance.eventId))
    .where(
      and(
        eq(guidance.companyId, g.companyId),
        eq(guidance.metric, g.metric),
        eq(guidance.targetPeriod, g.targetPeriod),
        ne(guidance.eventId, event.id),
        lt(earningsEvents.reportDate, event.reportDate),
        ne(guidance.reviewStatus, "pending"),
      ),
    )
    .orderBy(desc(earningsEvents.reportDate))
    .limit(1);
  return prev ?? null;
}

/**
 * Fix 6: when a Q4 event has a full-year figure but no quarterly one, derive Q4 = full year minus
 * the nine-month year to date stored on the same fiscal year's Q3 event. Never compared against a
 * quarterly consensus unless derived this way.
 */
async function deriveMissingQ4(ctx: AppContext, event: EventRow): Promise<number> {
  if (!event.fiscalPeriod.endsWith("-Q4")) return 0;
  const year = event.fiscalPeriod.slice(0, 4);
  const own = (await ctx.db.select().from(metrics).where(eq(metrics.eventId, event.id))).filter((m) => usable(m.reviewStatus));
  const [q3] = await ctx.db
    .select({ id: earningsEvents.id })
    .from(earningsEvents)
    .where(and(eq(earningsEvents.companyId, event.companyId), eq(earningsEvents.fiscalPeriod, `${year}-Q3`)));
  if (!q3) return 0;
  const q3Rows = (await ctx.db.select().from(metrics).where(eq(metrics.eventId, q3.id))).filter((m) => usable(m.reviewStatus));

  let added = 0;
  for (const fy of own.filter((m) => m.periodType === "full_year" && m.segment === null && m.unit === "usd")) {
    if (own.some((m) => m.name === fy.name && m.periodType === "quarter" && m.segment === null)) continue;
    const nine = q3Rows.find((m) => m.name === fy.name && m.periodType === "ytd" && m.segment === null);
    const value = deriveQ4(fy.value, nine?.value ?? null);
    if (value === null) continue;
    await ctx.db
      .insert(metrics)
      .values({
        eventId: event.id,
        name: fy.name,
        segment: null,
        value,
        unit: fy.unit,
        periodType: "quarter",
        derived: true,
        quote: fy.quote,
        documentId: fy.documentId,
        charStart: fy.charStart,
        charEnd: fy.charEnd,
        confidence: "1",
        reviewStatus: "auto_approved",
        promptVersion: "derived:fy-minus-9m",
        model: "code",
      })
      .onConflictDoNothing();
    added++;
  }
  return added;
}

async function buildFactSheet(ctx: AppContext, event: EventRow, company: CompanyRow): Promise<FactSheet> {
  const rows = (await ctx.db.select().from(metrics).where(eq(metrics.eventId, event.id))).filter((m) => usable(m.reviewStatus));
  const guides = (await ctx.db.select().from(guidance).where(eq(guidance.eventId, event.id))).filter((g) =>
    usable(g.reviewStatus),
  );

  const [prior] = await ctx.db
    .select({ id: earningsEvents.id })
    .from(earningsEvents)
    .where(and(eq(earningsEvents.companyId, company.id), eq(earningsEvents.fiscalPeriod, priorYearPeriod(event.fiscalPeriod))));
  const priorRows = prior
    ? (await ctx.db.select().from(metrics).where(eq(metrics.eventId, prior.id))).filter((m) => usable(m.reviewStatus))
    : [];

  const order = (m: MetricRow) =>
    (m.periodType === "quarter" ? 0 : m.periodType === "ytd" ? 2000 : 4000) +
    (m.segment ? 1000 : 0) +
    VOCAB_ORDER.indexOf(m.name);
  const sorted = [...rows].sort((a, b) => order(a) - order(b) || (a.segment ?? "").localeCompare(b.segment ?? ""));

  const metricFacts: MetricFact[] = sorted.map((m, i) => {
    const py = priorRows.find((p) => p.name === m.name && p.periodType === m.periodType && p.segment === m.segment);
    const surprisePoints =
      m.unit === "percent" && m.consensusValue !== null ? Number(m.value) - Number(m.consensusValue) : null;
    return {
      id: `M${i + 1}`,
      rowId: m.id,
      name: m.name,
      segment: m.segment,
      periodType: m.periodType,
      unit: m.unit,
      value: Number(m.value),
      derived: m.derived,
      verdict: m.verdict,
      consensus: m.consensusValue === null ? null : Number(m.consensusValue),
      consensusProvider: m.consensusProvider,
      surprisePct: m.surprisePct === null ? null : Number(m.surprisePct),
      surprisePoints,
      priorYear: py ? Number(py.value) : null,
      yoyPct: py ? numOrNull(yoyChange(m.value, py.value)) : null,
      quote: m.quote,
    };
  });

  const guidanceFacts: GuidanceFact[] = [];
  for (const [i, g] of [...guides].sort((a, b) => VOCAB_ORDER.indexOf(a.metric) - VOCAB_ORDER.indexOf(b.metric)).entries()) {
    const prev = g.prevGuidanceId
      ? (
          await ctx.db
            .select({ row: guidance, fiscalPeriod: earningsEvents.fiscalPeriod })
            .from(guidance)
            .innerJoin(earningsEvents, eq(earningsEvents.id, guidance.eventId))
            .where(eq(guidance.id, g.prevGuidanceId))
        )[0]
      : undefined;
    guidanceFacts.push({
      id: `G${i + 1}`,
      rowId: g.id,
      metric: g.metric,
      kind: g.kind,
      targetPeriod: g.targetPeriod,
      low: numOrNull(g.low),
      high: numOrNull(g.high),
      change: g.change as GuidanceChange | null,
      previous: prev
        ? { low: numOrNull(prev.row.low), high: numOrNull(prev.row.high), fiscalPeriod: prev.fiscalPeriod, quote: prev.row.quote }
        : null,
      fromQa: g.fromQa,
      quote: g.quote,
    });
  }

  return {
    ticker: company.ticker,
    companyName: company.name,
    fiscalPeriod: event.fiscalPeriod,
    reportDate: event.reportDate.toISOString(),
    metrics: metricFacts,
    guidance: guidanceFacts,
  };
}

function numOrNull(v: string | null): number | null {
  return v === null ? null : Number(v);
}

/** "VST 2026-Q2 brief ready - net income beat; fiscal 2026 free cash flow guide maintained" (§20 step 4). */
function alertsFor(sheet: FactSheet, eventId: string, version: number) {
  const verdicts = sheet.metrics
    .filter((m) => m.periodType === "quarter" && m.segment === null && m.verdict && m.verdict !== "no_consensus")
    .slice(0, 2)
    .map((m) => `${metricLabel(m.name).toLowerCase()} ${m.verdict === "inline" ? "in line" : m.verdict}`);
  const changes = sheet.guidance
    .filter((g) => g.change)
    .slice(0, 2)
    .map((g) => `${formatTargetPeriod(g.targetPeriod)} ${metricLabel(g.metric).toLowerCase()} guide ${g.change}`);
  const summary = [...verdicts, ...changes].join("; ");
  const label = version > 1 ? `brief updated (v${version})` : "brief ready";
  const out = [{ eventId, kind: "brief_ready", message: `${sheet.ticker} ${sheet.fiscalPeriod} ${label}${summary ? ` - ${summary}` : ""}` }];
  for (const g of sheet.guidance.filter((x) => x.change === "raised" || x.change === "lowered" || x.change === "withdrawn")) {
    out.push({
      eventId,
      kind: "guidance_change",
      message: `${sheet.ticker} ${formatTargetPeriod(g.targetPeriod)} ${metricLabel(g.metric).toLowerCase()} guidance ${g.change}`,
    });
  }
  return out;
}
