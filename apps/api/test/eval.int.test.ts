// The eval harness against the real golden set (data/golden), with a fake model that replays the
// hand-checked answers - except one wrong-column EPS figure, which the validator must stop.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { LlmExtractionResult } from "@eia/shared";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createContext, type AppContext } from "../src/context";
import { gate, latestReport, toMarkdown, writeReport } from "../src/eval/report";
import { loadCases, runEval, type EvalReport } from "../src/eval/run";
import type { ModelCall } from "../src/services/extraction";

const GOLDEN = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../../data/golden");
const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://eia:eia@localhost:55432/eia_test";

/** Answers from expected.json for the case named in the request header. */
const replay: ModelCall = async (input) => {
  const ticker = /Company: (\w+)/.exec(input)![1];
  const period = /Fiscal period in force: (\d{4}-Q\d)/.exec(input)![1];
  const golden = JSON.parse(readFileSync(path.join(GOLDEN, `${ticker}-${period}`, "expected.json"), "utf8"));
  const result: LlmExtractionResult = {
    metrics: golden.metrics.map((m: Record<string, unknown>) => ({
      name: m.name,
      segment: m.segment,
      value: m.value,
      unit: m.unit,
      periodType: m.periodType,
      quote: m.quote,
      confidence: 0.95,
    })),
    guidance: golden.guidance.map((g: Record<string, unknown>) => ({
      metric: g.metric,
      kind: g.kind,
      low: g.low,
      high: g.high,
      targetPeriod: g.targetPeriod,
      quote: g.quote,
      confidence: 0.95,
    })),
  };
  // One model mistake: NVIDIA Q2 FY27 EPS read from the prior-quarter column.
  if (ticker === "NVDA" && period === "2027-Q2") {
    result.metrics = result.metrics.map((m) => (m.name === "eps_gaap" ? { ...m, value: 2.39 } : m));
  }
  return result;
};

let ctx: AppContext;
let report: EvalReport;

beforeAll(async () => {
  ctx = createContext(
    loadConfig({ ...process.env, DATABASE_URL: TEST_DB, EDGAR_USER_AGENT: "EarningsAgent/1.0 test test@example.com" }),
    { log: pino({ level: "silent" }) },
  );
  report = await runEval(ctx, { goldenDir: GOLDEN, call: replay, model: "replay", retrieval: false });
});

afterAll(async () => {
  await ctx.pool.end();
});

describe("eval harness", () => {
  it("loads the seeded golden cases", () => {
    expect(loadCases(GOLDEN).map((c) => c.id)).toEqual([
      "NVDA-2026-Q3",
      "NVDA-2026-Q4",
      "NVDA-2027-Q1",
      "NVDA-2027-Q2",
      "VST-2025-Q4",
      "VST-2026-Q1",
      "VST-2026-Q2",
    ]);
  });

  it("scores extraction per metric; the validator turns the wrong-column EPS into a miss, not a wrong value", () => {
    expect(report.extraction!.overall).toMatchObject({ expected: 23, correct: 22, wrong: 0, missing: 1 });
    expect(report.extraction!.perMetric.eps_gaap).toEqual({ expected: 4, correct: 3, wrong: 0, missing: 1 });
    expect(report.extraction!.headline.accuracy).toBeCloseTo(22 / 23, 6);
  });

  it("re-checks every citation independently", () => {
    expect(report.citation).toMatchObject({ precision: 1 });
    expect(report.citation!.checked).toBe(22 + 7);
  });

  it("reproduces every hand-checked guidance label with no false changes, from golden values and from extraction", () => {
    expect(report.guidance.labels).toEqual({ checked: 7, correct: 7, falseChanges: 0, mismatches: [] });
    expect(report.guidance.extracted).toMatchObject({ checked: 7, correct: 7, falseChanges: 0, missing: 0 });
  });

  it("gates on regressions against the previous report", () => {
    expect(gate(report, null).passed).toBe(true);
    const better: EvalReport = JSON.parse(JSON.stringify(report));
    better.extraction!.overall.accuracy = 1;
    expect(gate(report, better)).toMatchObject({
      passed: false,
      failures: [expect.stringMatching(/extraction accuracy fell from 100.0% to 95.7%/)],
    });
    const falseChange: EvalReport = JSON.parse(JSON.stringify(report));
    falseChange.guidance.labels.falseChanges = 1;
    expect(gate(falseChange, null).passed).toBe(false);
  });

  it("writes a dated JSON + Markdown report that the next run can diff against", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eia-eval-"));
    try {
      const md = writeReport(dir, report, null, gate(report, null));
      expect(await fs.readFile(md, "utf8")).toMatch(/Extraction accuracy \(headline\) \| 95\.7% \(22\/23\)/);
      expect(latestReport(dir)?.runAt).toBe(report.runAt);
      expect(toMarkdown(report, report, gate(report, report))).toMatch(/\(no change\)/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
