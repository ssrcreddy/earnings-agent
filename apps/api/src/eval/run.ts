// Evaluation harness (§24): runs the real pipeline stages against the golden set.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { llmCalls } from "@eia/db";
import { nominalEndOf, type DocumentType, type GuidanceKind } from "@eia/shared";
import { gte, sql } from "drizzle-orm";
import type { AppContext } from "../context";
import { EXTRACT_PROMPT_VERSION, extractionHeader } from "../jobs/extract";
import { parseHeadlineTable } from "../parsing/headline";
import { cleanHtml } from "../parsing/html";
import { approxEqual } from "../parsing/numbers";
import { labelSections } from "../parsing/sections";
import { compareGuidance } from "../services/compare";
import { guidanceKey, metricKey, runExtraction, type ModelCall } from "../services/extraction";
import type { GoldenCase } from "../services/golden";
import { retrieve } from "../services/retrieval";
import { locateQuote, valueInQuote, type ValidationContext } from "../services/validate";

/** "Equals the hand-checked value": rounding noise only, not a 0.5% tolerance. */
const EXACT = 1e-6;
/** Metrics the ≥95% target applies to (§24). */
const HEADLINE = new Set(["revenue", "eps_gaap", "eps_adj", "net_income", "op_income", "gross_margin"]);

export interface Tally {
  expected: number;
  correct: number;
  wrong: number;
  missing: number;
}

export interface EvalReport {
  runAt: string;
  promptVersion: string;
  model: string | null;
  cases: string[];
  /** Null when no extraction model is configured. */
  extraction: {
    overall: Tally & { accuracy: number };
    headline: Tally & { accuracy: number };
    perMetric: Record<string, Tally>;
    /** Wrong values: the error class that matters most - listed in full. */
    wrongValues: { case: string; key: string; expected: number; got: number }[];
    /** Valid extractions with no golden counterpart (the golden set isn't exhaustive). */
    unscored: number;
  } | null;
  citation: { checked: number; supported: number; precision: number } | null;
  guidance: {
    /** Compare logic on hand-checked values: must reproduce every expected label. */
    labels: { checked: number; correct: number; falseChanges: number; mismatches: string[] };
    /** End to end: labels computed from what the model extracted. Null without a model. */
    extracted: { checked: number; correct: number; falseChanges: number; missing: number; mismatches: string[] } | null;
  };
  retrieval: { questions: number; hits: number; recallAt5: number | null; misses: string[]; unavailable: number } | null;
  cost: { calls: number; failedCalls: number; inputTokens: number; outputTokens: number; costUsd: number; perCaseUsd: number; avgLatencyMs: number } | null;
}

export interface LoadedCase {
  id: string;
  dir: string;
  golden: GoldenCase;
}

export function loadCases(goldenDir: string): LoadedCase[] {
  if (!existsSync(goldenDir)) return [];
  return readdirSync(goldenDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(goldenDir, d.name, "expected.json")))
    .map((d) => ({
      id: d.name,
      dir: path.join(goldenDir, d.name),
      golden: JSON.parse(readFileSync(path.join(goldenDir, d.name, "expected.json"), "utf8")) as GoldenCase,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const emptyTally = (): Tally => ({ expected: 0, correct: 0, wrong: 0, missing: 0 });
const accuracy = (t: Tally) => (t.expected ? t.correct / t.expected : 1);
const isFalseChange = (computed: string | null, expected: string | null | undefined) =>
  (computed === "raised" || computed === "lowered") && computed !== expected;

export interface EvalOptions {
  goldenDir: string;
  /** The extraction model; null skips the extraction metrics (they need a model). */
  call: ModelCall | null;
  model: string | null;
  retrieval: boolean;
}

export async function runEval(ctx: AppContext, opts: EvalOptions): Promise<EvalReport> {
  const started = new Date();
  const cases = loadCases(opts.goldenDir);

  // --- Guidance labels on hand-checked values: deterministic, always runs ---------------------
  const labels = { checked: 0, correct: 0, falseChanges: 0, mismatches: [] as string[] };
  for (const c of cases) {
    for (const g of c.golden.guidance) {
      if (g.expectedChange === undefined) continue;
      labels.checked++;
      const prev = g.previous
        ? { id: "prev", kind: g.previous.kind as GuidanceKind, low: g.previous.low, high: g.previous.high }
        : null;
      const computed = compareGuidance({ id: "new", kind: g.kind as GuidanceKind, low: g.low, high: g.high }, prev).change;
      if (computed === g.expectedChange) labels.correct++;
      else labels.mismatches.push(`${c.id} ${g.metric} ${g.targetPeriod}: expected ${g.expectedChange}, computed ${computed}`);
      if (isFalseChange(computed, g.expectedChange)) labels.falseChanges++;
    }
  }

  // --- Extraction, citations, end-to-end guidance labels: need a model ------------------------
  let extraction: EvalReport["extraction"] = null;
  let citation: EvalReport["citation"] = null;
  let extracted: EvalReport["guidance"]["extracted"] = null;
  if (opts.call) {
    const overall = emptyTally();
    const headline = emptyTally();
    const perMetric: Record<string, Tally> = {};
    const wrongValues: NonNullable<EvalReport["extraction"]>["wrongValues"] = [];
    let unscored = 0;
    citation = { checked: 0, supported: 0, precision: 1 };
    extracted = { checked: 0, correct: 0, falseChanges: 0, missing: 0, mismatches: [] };

    for (const c of cases) {
      const g = c.golden;
      const fye = g.fiscalYearEnd ?? "1231";
      const periodEnd = nominalEndOf(g.fiscalPeriod, fye);
      const gotMetrics = new Map<string, number>();
      const gotGuides = new Map<string, { kind: GuidanceKind; low: number | null; high: number | null }>();

      for (const d of g.documents) {
        const type = d.type as DocumentType;
        const clean = cleanHtml(readFileSync(path.join(c.dir, d.file), "utf8"));
        const blocks = labelSections(type, clean.blocks);
        const vc: ValidationContext = {
          text: clean.text,
          docType: type,
          fiscalPeriod: g.fiscalPeriod,
          periodEnd,
          facts: null, // offline: values must appear in their quotes
          headline: type === "press_release" ? parseHeadlineTable(clean.text, blocks) : [],
        };
        const header = extractionHeader(g.ticker, g.companyName ?? g.ticker, type, g.fiscalPeriod, periodEnd);
        const mda = blocks.filter((b) => b.section === "mda");
        const text = type === "press_release" || mda.length === 0 ? clean.text : clean.text.slice(mda[0]!.start, mda.at(-1)!.end);
        const outcome = await runExtraction(opts.call, [{ header, text }], vc);

        for (const m of outcome.metrics) {
          gotMetrics.set(metricKey(m.item), m.item.value);
          // Citation precision: re-run the support check independently of the validator's verdict.
          citation.checked++;
          const at = locateQuote(clean.text, m.item.quote);
          if (at && valueInQuote(m.item.value, m.item.unit, m.item.quote, clean.text, at.start)) citation.supported++;
        }
        for (const v of outcome.guidance) {
          gotGuides.set(guidanceKey(v.item), { kind: v.item.kind, low: v.item.low, high: v.item.high });
          citation.checked++;
          if (locateQuote(clean.text, v.item.quote)) citation.supported++;
        }
      }

      // Score every expected metric: correct, wrong value, or missing.
      for (const m of g.metrics) {
        const key = metricKey(m);
        const t = (perMetric[m.name] ??= emptyTally());
        const buckets = [overall, t, ...(HEADLINE.has(m.name) && m.periodType === "quarter" && !m.segment ? [headline] : [])];
        for (const b of buckets) b.expected++;
        const got = gotMetrics.get(key);
        if (got === undefined) for (const b of buckets) b.missing++;
        else if (approxEqual(got, m.value, EXACT)) for (const b of buckets) b.correct++;
        else {
          for (const b of buckets) b.wrong++;
          wrongValues.push({ case: c.id, key, expected: m.value, got });
        }
      }
      unscored += [...gotMetrics.keys()].filter((k) => !g.metrics.some((m) => metricKey(m) === k)).length;

      // End-to-end guidance labels: what Compare says about what the model extracted.
      for (const eg of g.guidance) {
        if (eg.expectedChange === undefined) continue;
        extracted.checked++;
        const got = gotGuides.get(guidanceKey(eg));
        if (!got) {
          extracted.missing++;
          continue;
        }
        const prev = eg.previous ? { id: "prev", kind: eg.previous.kind as GuidanceKind, low: eg.previous.low, high: eg.previous.high } : null;
        const computed = compareGuidance({ id: "new", ...got }, prev).change;
        if (computed === eg.expectedChange) extracted.correct++;
        else extracted.mismatches.push(`${c.id} ${eg.metric} ${eg.targetPeriod}: expected ${eg.expectedChange}, computed ${computed}`);
        if (isFalseChange(computed, eg.expectedChange)) extracted.falseChanges++;
      }
    }
    citation.precision = citation.checked ? citation.supported / citation.checked : 1;
    extraction = {
      overall: { ...overall, accuracy: accuracy(overall) },
      headline: { ...headline, accuracy: accuracy(headline) },
      perMetric,
      wrongValues,
      unscored,
    };
  }

  // --- Retrieval recall@5 over the corpus in the database --------------------------------------
  let retrieval: EvalReport["retrieval"] = null;
  if (opts.retrieval) {
    retrieval = { questions: 0, hits: 0, recallAt5: null, misses: [], unavailable: 0 };
    const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
    for (const c of cases) {
      for (const q of c.golden.askQuestions ?? []) {
        if (!("goldSnippet" in q)) continue;
        const r = await retrieve(ctx, q.question, { ticker: q.ticker });
        if (r.chunks.length === 0 && r.refusal) {
          // Distinguish "nothing ingested for this company" from a genuine miss.
          const corpus = await ctx.db.execute<{ n: number }>(
            sql`select count(*)::int as n from chunks where ticker = ${q.ticker ?? c.golden.ticker}`,
          );
          if ((corpus.rows[0]?.n ?? 0) === 0) {
            retrieval.unavailable++;
            continue;
          }
        }
        retrieval.questions++;
        if (r.chunks.slice(0, 5).some((ch) => norm(ch.text).includes(norm(q.goldSnippet)))) retrieval.hits++;
        else retrieval.misses.push(`${c.id}: "${q.question}"`);
      }
    }
    retrieval.recallAt5 = retrieval.questions ? retrieval.hits / retrieval.questions : null;
  }

  // --- Cost and latency of this run's model calls ----------------------------------------------
  let cost: EvalReport["cost"] = null;
  if (opts.call) {
    const calls = await ctx.db.select().from(llmCalls).where(gte(llmCalls.createdAt, started));
    const extractCalls = calls.filter((c) => c.purpose === "extract");
    const costUsd = extractCalls.reduce((n, c) => n + Number(c.costUsd), 0);
    cost = {
      calls: extractCalls.length,
      failedCalls: extractCalls.filter((c) => !c.ok).length,
      inputTokens: extractCalls.reduce((n, c) => n + c.inputTokens, 0),
      outputTokens: extractCalls.reduce((n, c) => n + c.outputTokens, 0),
      costUsd,
      perCaseUsd: cases.length ? costUsd / cases.length : 0,
      avgLatencyMs: extractCalls.length ? Math.round(extractCalls.reduce((n, c) => n + c.latencyMs, 0) / extractCalls.length) : 0,
    };
  }

  return {
    runAt: started.toISOString(),
    promptVersion: EXTRACT_PROMPT_VERSION,
    model: opts.model,
    cases: cases.map((c) => c.id),
    extraction,
    citation,
    guidance: { labels, extracted },
    retrieval,
    cost,
  };
}
