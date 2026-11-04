// Extraction orchestration (§18 steps 3-5), independent of the database: windows -> model call ->
// validation -> one retry with the errors -> merge. The model is a function, so tests can fake it.
import type { ExtractedGuidance, ExtractedMetric, LlmExtractionResult, LlmGuidance, LlmMetric } from "@eia/shared";
import { countTokens } from "../parsing/chunker";
import { StructuredOutputError } from "../llm/gateway";
import { approxEqual } from "../parsing/numbers";
import { VALUE_TOLERANCE, validateGuidance, validateMetric, type FactsCheck, type ValidationContext } from "./validate";

/** Max tokens of document text per call. Longer sections are split at paragraph breaks, never truncated. */
export const WINDOW_TOKENS = 24_000;

export type ModelCall = (input: string) => Promise<LlmExtractionResult>;

export interface ValidMetric {
  item: ExtractedMetric;
  charStart: number;
  charEnd: number;
  facts: FactsCheck;
}
export interface ValidGuidance {
  item: ExtractedGuidance;
  charStart: number;
  charEnd: number;
}
export type Failure =
  | { kind: "metric"; candidate: LlmMetric; errors: string[]; regexValue: number | null }
  | { kind: "guidance"; candidate: LlmGuidance; errors: string[] };

export interface ExtractionOutcome {
  metrics: ValidMetric[];
  guidance: ValidGuidance[];
  failures: Failure[];
  /** Set when every attempt for some window failed outright (refusal, unparseable output). */
  attemptErrors: string[];
  calls: number;
}

export const metricKey = (m: { name: string; segment: string | null; periodType: string }) =>
  `${m.name}|${m.segment ?? ""}|${m.periodType}`;
export const guidanceKey = (g: { metric: string; targetPeriod: string }) => `${g.metric}|${g.targetPeriod}`;
const failureKey = (f: Failure) => (f.kind === "metric" ? metricKey(f.candidate) : guidanceKey(f.candidate));

/** Split text into windows of at most `maxTokens`, at paragraph breaks (falling back to lines). */
export function windows(text: string, maxTokens = WINDOW_TOKENS): string[] {
  if (countTokens(text) <= maxTokens) return [text];
  const out: string[] = [];
  let current = "";
  let tokens = 0;
  for (const para of text.split(/\n\n/)) {
    const t = countTokens(para) + 1;
    if (tokens + t > maxTokens && current) {
      out.push(current);
      current = "";
      tokens = 0;
    }
    if (t > maxTokens) {
      // One enormous paragraph (a long table): split it by lines.
      for (const piece of windows(para.split("\n").join("\n\n"), maxTokens)) out.push(piece);
      continue;
    }
    current = current ? `${current}\n\n${para}` : para;
    tokens += t;
  }
  if (current) out.push(current);
  return out;
}

function retryNote(errors: string[]): string {
  return [
    "",
    "Your previous answer for this document had these problems:",
    ...errors.map((e) => `- ${e}`),
    "Return the full result again. Fix each item listed, by copying its quote exactly from the document and",
    "reading the value from that quote, or leave the item out if the document does not support it.",
    "Keep the items that had no problems.",
  ].join("\n");
}

interface Attempt {
  metrics: ValidMetric[];
  guidance: ValidGuidance[];
  failures: Failure[];
  error: string | null;
}

async function attempt(call: ModelCall, input: string, vc: ValidationContext): Promise<Attempt> {
  let result: LlmExtractionResult;
  try {
    result = await call(input);
  } catch (err) {
    // Only output problems are attempt failures; network/API errors go to the job's retry policy.
    if (err instanceof StructuredOutputError) return { metrics: [], guidance: [], failures: [], error: err.message };
    throw err;
  }
  const a: Attempt = { metrics: [], guidance: [], failures: [], error: null };
  for (const m of result.metrics) {
    const v = validateMetric(m, vc);
    if (v.ok) a.metrics.push({ item: v.item, charStart: v.charStart, charEnd: v.charEnd, facts: v.facts });
    else a.failures.push({ kind: "metric", candidate: m, errors: v.errors, regexValue: v.regexValue });
  }
  for (const g of result.guidance) {
    const v = validateGuidance(g, vc);
    if (v.ok) a.guidance.push({ item: v.item, charStart: v.charStart, charEnd: v.charEnd });
    else a.failures.push({ kind: "guidance", candidate: g, errors: v.errors });
  }
  return a;
}

/** Valid items keyed; `preferred` wins ties, otherwise higher confidence wins. */
function mergeValid<T extends { item: { confidence: number } }>(key: (x: T) => string, preferred: T[], other: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const x of other) {
    const k = key(x);
    const cur = byKey.get(k);
    if (!cur || x.item.confidence > cur.item.confidence) byKey.set(k, x);
  }
  for (const x of preferred) byKey.set(key(x), x);
  return [...byKey.values()];
}

async function extractWindow(call: ModelCall, input: string, vc: ValidationContext) {
  const first = await attempt(call, input, vc);
  if (!first.error && first.failures.length === 0) return { ...first, calls: 1, attemptError: null };

  // One retry with the specific errors appended (§18 step 5). Never more: it would fail the same way.
  const problems = first.error ? [`Your answer could not be used: ${first.error}`] : first.failures.flatMap((f) => f.errors);
  const second = await attempt(call, input + retryNote(problems), vc);

  const metrics = mergeValid((x) => metricKey(x.item), second.metrics, first.metrics);
  const guidance = mergeValid((x) => guidanceKey(x.item), second.guidance, first.guidance);
  const validKeys = new Set([...metrics.map((x) => metricKey(x.item)), ...guidance.map((x) => guidanceKey(x.item))]);
  // Items that failed twice go to review; a failure the retry fixed does not.
  const failures = (second.error ? first.failures : second.failures).filter((f) => !validKeys.has(failureKey(f)));
  const attemptError = first.error && second.error ? second.error : null;
  return { metrics, guidance, failures, calls: 2, attemptError };
}

export async function runExtraction(
  call: ModelCall,
  parts: { header: string; text: string }[],
  vc: ValidationContext,
  /** Document tokens per call; smaller under a tokens-per-minute limit. */
  windowTokens = WINDOW_TOKENS,
): Promise<ExtractionOutcome> {
  const outcome: ExtractionOutcome = { metrics: [], guidance: [], failures: [], attemptErrors: [], calls: 0 };
  const all = parts.flatMap((p) => windows(p.text, windowTokens).map((w) => ({ header: p.header, text: w })));
  const metricsFound: ValidMetric[] = [];
  const guidanceFound: ValidGuidance[] = [];
  for (const [i, w] of all.entries()) {
    const input = `${w.header}\nPart ${i + 1} of ${all.length}.\n\n<document>\n${w.text}\n</document>`;
    const r = await extractWindow(call, input, vc);
    outcome.calls += r.calls;
    metricsFound.push(...r.metrics);
    guidanceFound.push(...r.guidance);
    outcome.failures.push(...r.failures);
    if (r.attemptError) outcome.attemptErrors.push(r.attemptError);
  }

  // Valid items for the same key must agree. A document that states two different figures for one
  // item (VST's guidance line vs an adjusted reconciliation row) is ambiguous: a human decides,
  // never the merge - picking one silently is how a false "lowered" got through.
  const metricGroups = groupBy(metricsFound, (x) => metricKey(x.item));
  for (const group of metricGroups.values()) {
    const distinct = uniqueBy(group, (a, b) => approxEqual(a.item.value, b.item.value, VALUE_TOLERANCE));
    if (distinct.length === 1) outcome.metrics.push(mergeValid((x) => metricKey(x.item), [], group)[0]!);
    else {
      const first = distinct[0]!.item;
      outcome.failures.push({
        kind: "metric",
        candidate: { ...first },
        errors: [conflictMessage(`${first.name} [${first.periodType}]`, distinct.map((d) => [String(d.item.value), d.item.quote]))],
        regexValue: null,
      });
    }
  }
  const guidanceGroups = groupBy(guidanceFound, (x) => guidanceKey(x.item));
  for (const group of guidanceGroups.values()) {
    const distinct = uniqueBy(group, (a, b) => sameGuideValues(a.item, b.item));
    if (distinct.length === 1) outcome.guidance.push(mergeValid((x) => guidanceKey(x.item), [], group)[0]!);
    else {
      const first = distinct[0]!.item;
      outcome.failures.push({
        kind: "guidance",
        candidate: { ...first },
        errors: [
          conflictMessage(
            `guidance ${first.metric} ${first.targetPeriod}`,
            distinct.map((d) => [`${d.item.kind} ${d.item.low ?? "-"}..${d.item.high ?? "-"}`, d.item.quote]),
          ),
        ],
      });
    }
  }
  const conflicted = new Set(outcome.failures.filter((f) => f.errors.some((e) => e.includes(CONFLICT))).map(failureKey));
  // A failure in one window is moot if another window produced a valid item for the same key.
  const validKeys = new Set([
    ...outcome.metrics.map((x) => metricKey(x.item)),
    ...outcome.guidance.map((x) => guidanceKey(x.item)),
  ]);
  const seen = new Set<string>();
  outcome.failures = outcome.failures.filter((f) => {
    const k = `${f.kind}:${failureKey(f)}`;
    if (validKeys.has(failureKey(f)) || seen.has(k)) return false;
    // A conflict replaces the ordinary failures for its key: it already carries both quotes.
    if (conflicted.has(failureKey(f)) && !f.errors.some((e) => e.includes(CONFLICT))) return false;
    seen.add(k);
    return true;
  });
  return outcome;
}

const CONFLICT = "states different values for the same item";

function conflictMessage(what: string, values: [string, string][]): string {
  return `${what}: the document ${CONFLICT} - ${values.map(([v, q]) => `${v} ("${q.slice(0, 120)}")`).join(" vs ")}; a reviewer must choose`;
}

function sameGuideValues(a: ValidGuidance["item"], b: ValidGuidance["item"]): boolean {
  const same = (x: number | null, y: number | null) => (x === null ? y === null : y !== null && approxEqual(x, y, VALUE_TOLERANCE));
  return a.kind === b.kind && same(a.low, b.low) && same(a.high, b.high);
}

function groupBy<T>(items: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) {
    const k = key(x);
    m.set(k, [...(m.get(k) ?? []), x]);
  }
  return m;
}

/** The items that differ from each other under `same`. */
function uniqueBy<T>(items: T[], same: (a: T, b: T) => boolean): T[] {
  const out: T[] = [];
  for (const x of items) if (!out.some((y) => same(x, y))) out.push(x);
  return out;
}
