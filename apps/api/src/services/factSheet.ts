// The fact sheet (§20): the closed set of verified, compared facts a brief may contain. The writer
// sees this - never the raw filing - which is what makes the post-check possible.
import type { GuidanceChange, GuidanceKind, MetricName, MetricUnit, PeriodType, Verdict } from "@eia/shared";

export interface MetricFact {
  id: string; // "M1"
  rowId: string; // metrics.id
  name: MetricName;
  segment: string | null;
  periodType: PeriodType;
  unit: MetricUnit;
  value: number;
  derived: boolean;
  verdict: Verdict | null;
  consensus: number | null;
  consensusProvider: string | null;
  /** Fraction, e.g. 0.031 for +3.1%. */
  surprisePct: number | null;
  surprisePoints: number | null;
  /** Same period a year earlier, when stored. */
  priorYear: number | null;
  yoyPct: number | null;
  quote: string;
}

export interface GuidanceFact {
  id: string; // "G1"
  rowId: string;
  metric: MetricName;
  kind: GuidanceKind;
  targetPeriod: string;
  low: number | null;
  high: number | null;
  change: GuidanceChange | null;
  previous: { low: number | null; high: number | null; fiscalPeriod: string; quote: string } | null;
  fromQa: boolean;
  quote: string;
}

export interface FactSheet {
  ticker: string;
  companyName: string;
  fiscalPeriod: string;
  reportDate: string;
  metrics: MetricFact[];
  guidance: GuidanceFact[];
}

const LABELS: Record<MetricName, string> = {
  revenue: "Revenue",
  eps_gaap: "GAAP diluted EPS",
  eps_adj: "Adjusted EPS",
  gross_margin: "Gross margin",
  op_income: "Operating income",
  net_income: "Net income",
  fcf: "Free cash flow",
  capex: "Capital expenditures",
};

export function metricLabel(name: MetricName, segment: string | null = null): string {
  return segment ? `${segment} ${LABELS[name].toLowerCase()}` : LABELS[name];
}

/** Figures written the way the brief writes them: "$305 million", "$4.02 billion", "$2.46", "75.0%". */
export function formatFigure(value: number, unit: MetricUnit): string {
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "usd_per_share") return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${trim((abs / 1e9).toFixed(3))} billion`;
  if (abs >= 1e6) return `${sign}$${trim((abs / 1e6).toFixed(1))} million`;
  return `${sign}$${abs.toLocaleString("en-US")}`;
}

/** Signed percentage from a fraction: 0.0312 -> "+3.1%". */
export function formatPct(fraction: number): string {
  const p = fraction * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

export function formatPoints(points: number): string {
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pts`;
}

function trim(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export function guidanceUnit(metric: MetricName): MetricUnit {
  return metric === "gross_margin" ? "percent" : metric.startsWith("eps") ? "usd_per_share" : "usd";
}

/** "2026-FY" -> "fiscal 2026"; "2026-Q4" -> "Q4 of fiscal 2026". */
export function formatTargetPeriod(p: string): string {
  const [y, part] = p.split("-");
  return part === "FY" ? `fiscal ${y}` : `${part} of fiscal ${y}`;
}

export function formatGuide(low: number | null, high: number | null, unit: MetricUnit): string {
  if (low === null || high === null) return "no figures";
  return low === high ? formatFigure(low, unit) : `${formatFigure(low, unit)} to ${formatFigure(high, unit)}`;
}

/** Every number the brief is allowed to state, as values in the units it might be written in. */
export function allowedNumbers(sheet: FactSheet): number[] {
  const out: number[] = [];
  const money = (v: number | null) => {
    if (v === null) return;
    out.push(v, v / 1e3, v / 1e6, v / 1e9);
  };
  for (const m of sheet.metrics) {
    money(m.value);
    money(m.consensus);
    money(m.priorYear);
    if (m.surprisePct !== null) out.push(m.surprisePct * 100);
    if (m.yoyPct !== null) out.push(m.yoyPct * 100);
    if (m.surprisePoints !== null) out.push(m.surprisePoints);
  }
  for (const g of sheet.guidance) {
    money(g.low);
    money(g.high);
    if (g.low !== null && g.high !== null) money((g.low + g.high) / 2);
    money(g.previous?.low ?? null);
    money(g.previous?.high ?? null);
  }
  return out;
}
