// `pnpm eval` (§24): run the golden set, print the summary, write a dated report, exit non-zero on a failed gate.
// Flags: --no-model (skip extraction even if a model is configured), --no-retrieval,
// --cases=NVDA-2027-Q2,VST-2026-Q2 (run only these golden cases).
import path from "node:path";
import { loadConfig } from "../config";
import { closeContext, createContext } from "../context";
import { extractionModelCall } from "../jobs/extract";
import { createLogger } from "../logger";
import { gate, latestReport, toMarkdown, writeReport } from "./report";
import { runEval } from "./run";

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const only = process.argv
    .find((a) => a.startsWith("--cases="))
    ?.slice("--cases=".length)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const config = loadConfig();
  const ctx = createContext(config, { log: createLogger("warn") });
  try {
    const call = args.has("--no-model") ? null : extractionModelCall(ctx);
    if (!call) console.log("No extraction model configured (OPENAI_API_KEY + STRONG_MODEL): extraction metrics are skipped.\n");
    const reportsDir = path.join(config.repoRoot, "data", "eval-reports");
    const previous = latestReport(reportsDir);
    const report = await runEval(ctx, {
      goldenDir: config.GOLDEN_DIR,
      call,
      model: call ? config.STRONG_MODEL : null,
      retrieval: !args.has("--no-retrieval"),
      only,
    });
    const result = gate(report, previous);
    const file = writeReport(reportsDir, report, previous, result);
    console.log(toMarkdown(report, previous, result));
    console.log(`Report written to ${path.relative(config.repoRoot, file)}`);
    process.exitCode = result.passed ? 0 : 1;
  } finally {
    await ctx.pool.end();
    void closeContext;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
