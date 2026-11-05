// Brief generation (§20): fact sheet -> draft -> post-check -> one regeneration -> publish or withhold.
import { checkBrief } from "./briefCheck";
import {
  formatFigure,
  formatGuide,
  formatPct,
  formatPoints,
  formatTargetPeriod,
  guidanceUnit,
  metricLabel,
  statementQuote,
  type FactSheet,
  type GuidanceFact,
  type MetricFact,
} from "./factSheet";

/** Produces a draft; `errors` is set on the regeneration, listing what the post-check rejected. */
export type BriefDrafter = (sheet: FactSheet, errors: string[] | null) => Promise<string>;

export type BriefOutcome =
  | { ok: true; body: string; cited: string[]; attempts: number }
  | { ok: false; errors: string[]; attempts: number };

/** Draft, check, and regenerate once with the errors; a second failure withholds the brief (§20 step 3). */
export async function writeBrief(sheet: FactSheet, draft: BriefDrafter): Promise<BriefOutcome> {
  const first = await draft(sheet, null);
  const check1 = checkBrief(first, sheet);
  if (check1.ok) return { ok: true, body: first.trim(), cited: check1.cited, attempts: 1 };
  const second = await draft(sheet, check1.errors);
  const check2 = checkBrief(second, sheet);
  if (check2.ok) return { ok: true, body: second.trim(), cited: check2.cited, attempts: 2 };
  return { ok: false, errors: check2.errors, attempts: 2 };
}

const PERIOD_TEXT = { quarter: "quarter", ytd: "year to date", full_year: "full year" } as const;

function resultLine(m: MetricFact): string {
  const what = `${metricLabel(m.name, m.segment)}${m.periodType === "quarter" ? "" : ` (${PERIOD_TEXT[m.periodType]})`}`;
  const value = formatFigure(m.value, m.unit);
  const derived = m.derived ? " (derived: full year minus nine months)" : "";
  let comparison: string;
  if (m.verdict && m.verdict !== "no_consensus" && m.consensus !== null) {
    const surprise =
      m.surprisePoints !== null ? formatPoints(m.surprisePoints) : m.surprisePct !== null ? formatPct(m.surprisePct) : null;
    const against = `consensus (${m.consensusProvider}) of ${formatFigure(m.consensus, m.unit)}`;
    const verb = m.verdict === "beat" ? "beat" : m.verdict === "miss" ? "missed" : "was in line with";
    const yearAgo =
      m.priorYear !== null
        ? `; ${formatFigure(m.priorYear, m.unit)} a year earlier${m.yoyPct !== null ? ` (${formatPct(m.yoyPct)})` : ""}`
        : "";
    comparison = `${verb} ${against}${surprise ? `, a surprise of ${surprise}` : ""}${yearAgo}`;
  } else if (m.priorYear !== null) {
    const yoy = m.yoyPct !== null ? ` (${formatPct(m.yoyPct)})` : "";
    comparison = `versus ${formatFigure(m.priorYear, m.unit)} a year earlier${yoy}`;
  } else {
    return `- ${what}: ${value}${derived} [${m.id}]`;
  }
  return `- ${what}: ${value}${derived}, ${comparison} [${m.id}]`;
}

function guidanceLine(g: GuidanceFact): string {
  const unit = guidanceUnit(g.metric);
  const what = `${metricLabel(g.metric)} for ${formatTargetPeriod(g.targetPeriod)}`;
  if (g.kind === "withdrawn") return `- ${what}: guidance withdrawn [${g.id}]`;
  if (g.kind === "qualitative") return `- ${what}: qualitative guidance only; no change is computed [${g.id}]`;
  const range = formatGuide(g.low, g.high, unit);
  const prev = g.previous ? formatGuide(g.previous.low, g.previous.high, unit) : null;
  switch (g.change) {
    case "new":
      return `- ${what}: ${range}, ${g.changeNote ?? "new guidance"} [${g.id}]`;
    case "maintained":
      return `- ${what}: ${range}, maintained [${g.id}]`;
    case null:
      return `- ${what}: ${range}; no change is computed [${g.id}]`;
    default:
      return `- ${what}: ${range}, ${g.change} from ${prev} in ${g.previous!.fiscalPeriod} [${g.id}]`;
  }
}

function headline(sheet: FactSheet): string {
  const main =
    sheet.metrics.find((m) => m.periodType === "quarter" && m.segment === null && m.name === "revenue") ??
    sheet.metrics.find((m) => m.periodType === "quarter" && m.segment === null) ??
    sheet.metrics[0];
  const guide = sheet.guidance.find((g) => g.change && g.change !== "maintained") ?? sheet.guidance[0];
  const parts: string[] = [];
  const ids: string[] = [];
  if (main) {
    const verdict =
      main.verdict && main.verdict !== "no_consensus" ? ` (${main.verdict === "inline" ? "in line" : main.verdict})` : "";
    parts.push(`${metricLabel(main.name, main.segment).toLowerCase()} ${formatFigure(main.value, main.unit)}${verdict}`);
    ids.push(main.id);
  }
  if (guide) {
    const change = guide.changeNote ?? guide.change ?? (guide.kind === "qualitative" ? "stated qualitatively" : "not compared");
    parts.push(`${formatTargetPeriod(guide.targetPeriod)} ${metricLabel(guide.metric).toLowerCase()} guidance ${change}`);
    ids.push(guide.id);
  }
  const summary = parts.length ? parts.join("; ") : "no results extracted";
  return `**${sheet.ticker} ${sheet.fiscalPeriod}:** ${summary}${ids.length ? ` ${ids.map((i) => `[${i}]`).join("")}` : ""}`;
}

/**
 * Deterministic brief from the fact sheet, in the fixed §20 shape. Used when no model is configured,
 * and passed through the same post-check as a model's draft.
 */
export function renderTemplateBrief(sheet: FactSheet): string {
  const lines: string[] = [headline(sheet), ""];
  if (sheet.metrics.length) lines.push("### Results", ...sheet.metrics.map(resultLine), "");
  if (sheet.guidance.length) lines.push("### Guidance", ...sheet.guidance.map(guidanceLine), "");

  const said = sheet.guidance.filter((g) => statementQuote(g.quote));
  if (said.length) {
    const prepared = said.filter((g) => !g.fromQa);
    const qa = said.filter((g) => g.fromQa);
    lines.push("### What management said");
    lines.push(...prepared.map((g) => `- "${g.quote}" [${g.id}]`));
    if (qa.length) lines.push(...qa.map((g) => `- In Q&A: "${g.quote}" [${g.id}]`));
    lines.push("");
  }

  const watch: string[] = [];
  const noConsensus = sheet.metrics.filter((m) => m.periodType === "quarter" && m.segment === null && m.verdict === "no_consensus");
  if (noConsensus.length) {
    watch.push(
      `- No consensus on record for ${noConsensus.map((m) => metricLabel(m.name).toLowerCase()).join(", ")} ${noConsensus.map((m) => `[${m.id}]`).join("")}`,
    );
  }
  for (const m of sheet.metrics.filter((x) => x.derived)) {
    watch.push(`- ${metricLabel(m.name)} for the quarter is derived from the annual report, not stated directly [${m.id}]`);
  }
  if (watch.length) lines.push("### Watch items", ...watch, "");
  return lines.join("\n").trim();
}

/** What the model writer sees: the fact sheet with display strings precomputed, so it never formats a number. */
export function briefInput(sheet: FactSheet, errors: string[] | null): string {
  const facts = {
    company: `${sheet.companyName} (${sheet.ticker})`,
    fiscalPeriod: sheet.fiscalPeriod,
    results: sheet.metrics.map((m) => ({
      id: m.id,
      metric: metricLabel(m.name, m.segment),
      periodType: m.periodType,
      derived: m.derived,
      verdict: m.verdict,
      display: {
        value: formatFigure(m.value, m.unit),
        consensus: m.consensus === null ? null : formatFigure(m.consensus, m.unit),
        consensusProvider: m.consensusProvider,
        surprise:
          m.surprisePoints !== null ? formatPoints(m.surprisePoints) : m.surprisePct !== null ? formatPct(m.surprisePct) : null,
        priorYear: m.priorYear === null ? null : formatFigure(m.priorYear, m.unit),
        yoy: m.yoyPct === null ? null : formatPct(m.yoyPct),
      },
    })),
    guidance: sheet.guidance.map((g) => ({
      id: g.id,
      metric: metricLabel(g.metric),
      targetPeriod: formatTargetPeriod(g.targetPeriod),
      kind: g.kind,
      change: g.change,
      changeNote: g.changeNote ?? null,
      fromQa: g.fromQa,
      display: {
        range: formatGuide(g.low, g.high, guidanceUnit(g.metric)),
        previous: g.previous ? formatGuide(g.previous.low, g.previous.high, guidanceUnit(g.metric)) : null,
        previousPeriod: g.previous?.fiscalPeriod ?? null,
      },
      quote: statementQuote(g.quote),
    })),
  };
  const retry = errors
    ? `\n\nYour previous draft was rejected by the checker:\n${errors.map((e) => `- ${e}`).join("\n")}\nWrite the brief again, fixing each problem.`
    : "";
  return `<fact_sheet>\n${JSON.stringify(facts, null, 2)}\n</fact_sheet>${retry}`;
}
