// Eval report: dated JSON + Markdown, a diff against the last run, and the gate (§24).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EvalReport } from "./run";

export interface GateResult {
  passed: boolean;
  failures: string[];
}

/**
 * A prompt or model change may not become the default unless there is no regression on accuracy,
 * no new wrong values, and the false guidance-change rate stays at zero (§24).
 */
export function gate(report: EvalReport, previous: EvalReport | null): GateResult {
  const failures: string[] = [];
  // A partial run can't pass: an errored case would hide its regressions.
  if (report.caseErrors?.length) {
    failures.push(`${report.caseErrors.length} golden case(s) could not run: ${report.caseErrors.map((e) => e.case).join(", ")}`);
  }
  if (report.guidance.labels.falseChanges > 0) {
    failures.push(`compare produced ${report.guidance.labels.falseChanges} false guidance change(s) on hand-checked values`);
  }
  if (report.guidance.labels.correct < report.guidance.labels.checked) {
    failures.push(`compare got ${report.guidance.labels.checked - report.guidance.labels.correct} guidance label(s) wrong`);
  }
  if (report.guidance.extracted && report.guidance.extracted.falseChanges > 0) {
    failures.push(`${report.guidance.extracted.falseChanges} false guidance change(s) from extracted guidance`);
  }
  if (report.citation && report.citation.precision < 1) {
    failures.push(`citation precision ${pct(report.citation.precision)} is below 100%`);
  }
  const now = report.extraction;
  // Regressions are only meaningful against a run over the same cases (not a --cases subset).
  const sameCases = previous !== null && [...previous.cases].sort().join() === [...report.cases].sort().join();
  const before = sameCases ? previous?.extraction : undefined;
  if (now && before) {
    if (now.overall.accuracy < before.overall.accuracy) {
      failures.push(`extraction accuracy fell from ${pct(before.overall.accuracy)} to ${pct(now.overall.accuracy)}`);
    }
    if (now.overall.wrong > before.overall.wrong) {
      failures.push(`wrong values rose from ${before.overall.wrong} to ${now.overall.wrong}`);
    }
  }
  return { passed: failures.length === 0, failures };
}

export function latestReport(dir: string): EvalReport | null {
  try {
    const files = readdirSync(dir)
      .filter((f) => /^eval-.*\.json$/.test(f))
      .sort();
    const last = files.at(-1);
    return last ? (JSON.parse(readFileSync(path.join(dir, last), "utf8")) as EvalReport) : null;
  } catch {
    return null;
  }
}

/** Writes eval-<timestamp>.json and .md; returns the Markdown path. */
export function writeReport(dir: string, report: EvalReport, previous: EvalReport | null, result: GateResult): string {
  mkdirSync(dir, { recursive: true });
  const stamp = report.runAt.replace(/[:.]/g, "-").slice(0, 19);
  writeFileSync(path.join(dir, `eval-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const md = path.join(dir, `eval-${stamp}.md`);
  writeFileSync(md, toMarkdown(report, previous, result));
  return md;
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`);

function delta(now: number | null | undefined, before: number | null | undefined): string {
  if (now === null || now === undefined || before === null || before === undefined) return "";
  const d = (now - before) * 100;
  if (Math.abs(d) < 0.05) return " (no change)";
  return ` (${d > 0 ? "+" : ""}${d.toFixed(1)} pts)`;
}

export function toMarkdown(r: EvalReport, prev: EvalReport | null, result: GateResult): string {
  const lines: string[] = [
    `# Eval report ${r.runAt}`,
    "",
    `Prompt ${r.promptVersion} · model ${r.model ?? "none"} · ${r.cases.length} golden cases${prev ? ` · compared with the run at ${prev.runAt}` : ""}`,
    "",
    `**Gate: ${result.passed ? "PASSED" : "FAILED"}**`,
    ...result.failures.map((f) => `- ${f}`),
    "",
    "| Metric | Result | Target |",
    "|---|---|---|",
  ];
  const e = r.extraction;
  lines.push(
    e
      ? `| Extraction accuracy (headline) | ${pct(e.headline.accuracy)} (${e.headline.correct}/${e.headline.expected})${delta(e.headline.accuracy, prev?.extraction?.headline.accuracy)} | ≥95% |`
      : "| Extraction accuracy | not run (no model configured) | ≥95% |",
  );
  if (e) {
    lines.push(
      `| Extraction accuracy (all) | ${pct(e.overall.accuracy)}; ${e.overall.wrong} wrong, ${e.overall.missing} missing${delta(e.overall.accuracy, prev?.extraction?.overall.accuracy)} | no regression |`,
    );
  }
  lines.push(
    r.citation
      ? `| Citation precision | ${pct(r.citation.precision)} (${r.citation.supported}/${r.citation.checked}) | 100% |`
      : "| Citation precision | not run (no model configured) | 100% |",
    `| False guidance changes (compare, hand-checked values) | ${r.guidance.labels.falseChanges} of ${r.guidance.labels.checked}; ${r.guidance.labels.correct} labels correct | 0 |`,
    r.guidance.extracted
      ? `| False guidance changes (end to end) | ${r.guidance.extracted.falseChanges} of ${r.guidance.extracted.checked}; ${r.guidance.extracted.missing} guides not extracted | 0 |`
      : "| False guidance changes (end to end) | not run (no model configured) | 0 |",
    r.retrieval
      ? `| Retrieval recall@5 | ${pct(r.retrieval.recallAt5)} (${r.retrieval.hits}/${r.retrieval.questions})${r.retrieval.unavailable ? `; ${r.retrieval.unavailable} not in the corpus` : ""}${delta(r.retrieval.recallAt5, prev?.retrieval?.recallAt5)} | ≥90% |`
      : "| Retrieval recall@5 | not run | ≥90% |",
    r.cost
      ? `| Cost and latency | $${r.cost.costUsd.toFixed(4)} total, $${r.cost.perCaseUsd.toFixed(4)} per print, ${r.cost.calls} calls, ${r.cost.avgLatencyMs} ms average | reported |`
      : "| Cost and latency | no model calls | reported |",
    "",
  );

  if (e) {
    lines.push("## Per metric", "", "| Metric | Correct | Wrong | Missing |", "|---|---|---|---|");
    for (const [name, t] of Object.entries(e.perMetric)) lines.push(`| ${name} | ${t.correct}/${t.expected} | ${t.wrong} | ${t.missing} |`);
    lines.push("");
    if (e.wrongValues.length) {
      lines.push("## Wrong values", "", ...e.wrongValues.map((w) => `- ${w.case} ${w.key}: expected ${w.expected}, got ${w.got}`), "");
    }
  }
  const mismatches = [...r.guidance.labels.mismatches, ...(r.guidance.extracted?.mismatches ?? [])];
  if (mismatches.length) lines.push("## Guidance label mismatches", "", ...mismatches.map((m) => `- ${m}`), "");
  if (r.caseErrors?.length) lines.push("## Cases that could not run", "", ...r.caseErrors.map((e) => `- ${e.case}: ${e.message}`), "");
  if (r.retrieval?.misses.length) lines.push("## Retrieval misses", "", ...r.retrieval.misses.map((m) => `- ${m}`), "");
  return `${lines.join("\n")}\n`;
}
