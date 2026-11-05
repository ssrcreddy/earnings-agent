// Golden set (§24): every operator correction becomes a hand-checked case, so the dataset compounds
// with use. Format: data/golden/<ticker>-<period>/expected.json plus the source documents beside it.
import fs from "node:fs/promises";
import path from "node:path";

export interface GoldenMetric {
  name: string;
  segment: string | null;
  periodType: string;
  value: number;
  unit: string;
  quote: string;
  /** The value the model produced, kept to measure what the correction fixed. */
  modelValue: number | null;
  documentType: string;
  correctedAt: string;
  /** Where the expected value came from: "review" (a correction) or a seed note. */
  source?: string;
}

export interface GoldenGuidance {
  metric: string;
  kind: string;
  low: number | null;
  high: number | null;
  targetPeriod: string;
  quote: string;
  modelLow: number | null;
  modelHigh: number | null;
  documentType: string;
  correctedAt: string;
  source?: string;
  /** The previous guide for the same metric and target period, hand-checked; null = none. */
  previous?: { low: number | null; high: number | null; kind: string } | null;
  /** The label Compare must produce (§24's gated metric). */
  expectedChange?: string | null;
}

/** An Ask question with the passage a correct answer must retrieve (§24 recall@5). */
export interface GoldenQuestion {
  question: string;
  ticker?: string;
  /** Text that must appear in at least one of the top-5 retrieved chunks. */
  goldSnippet: string;
}

export interface GoldenCase {
  ticker: string;
  /** Needed to replay extraction exactly as the job runs it. */
  companyName?: string;
  fiscalYearEnd?: string;
  fiscalPeriod: string;
  documents: { type: string; sourceUrl: string; file: string }[];
  metrics: GoldenMetric[];
  guidance: GoldenGuidance[];
  /** Ask questions with their gold passages (§24); filled in by hand. */
  askQuestions: GoldenQuestion[];
  updatedAt: string;
}

export interface GoldenSource {
  type: string;
  sourceUrl: string;
  rawPath: string;
  bytes: Buffer;
}

export class GoldenStore {
  constructor(private readonly root: string) {}

  dirFor(ticker: string, fiscalPeriod: string): string {
    return path.join(this.root, `${ticker}-${fiscalPeriod}`);
  }

  async read(ticker: string, fiscalPeriod: string): Promise<GoldenCase> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dirFor(ticker, fiscalPeriod), "expected.json"), "utf8"));
    } catch {
      return { ticker, fiscalPeriod, documents: [], metrics: [], guidance: [], askQuestions: [], updatedAt: "" };
    }
  }

  /** Upserts one corrected item into the case (by its key) and copies the source document in. */
  async record(
    ticker: string,
    fiscalPeriod: string,
    source: GoldenSource,
    item: { metric: GoldenMetric } | { guidance: GoldenGuidance },
  ): Promise<string> {
    const dir = this.dirFor(ticker, fiscalPeriod);
    await fs.mkdir(dir, { recursive: true });
    const golden = await this.read(ticker, fiscalPeriod);

    const file = path.basename(source.rawPath);
    if (!golden.documents.some((d) => d.file === file)) {
      await fs.writeFile(path.join(dir, file), source.bytes);
      golden.documents.push({ type: source.type, sourceUrl: source.sourceUrl, file });
    }

    if ("metric" in item) {
      const m = item.metric;
      const same = (x: GoldenMetric) => x.name === m.name && x.segment === m.segment && x.periodType === m.periodType;
      const prior = golden.metrics.find(same);
      golden.metrics = golden.metrics.filter((x) => !same(x));
      golden.metrics.push({ ...prior, ...m });
    } else {
      const g = item.guidance;
      const same = (x: GoldenGuidance) => x.metric === g.metric && x.targetPeriod === g.targetPeriod;
      const prior = golden.guidance.find(same);
      golden.guidance = golden.guidance.filter((x) => !same(x));
      // A correction updates the values; hand-checked fields it doesn't set (previous guide, expected
      // label) must survive, or the eval silently stops gating this case.
      golden.guidance.push({ ...prior, ...g });
    }
    golden.updatedAt = new Date().toISOString();

    // Write-then-rename so a crash never leaves a half-written case.
    const target = path.join(dir, "expected.json");
    await fs.writeFile(`${target}.tmp`, `${JSON.stringify(golden, null, 2)}\n`);
    await fs.rename(`${target}.tmp`, target);
    return target;
  }
}
