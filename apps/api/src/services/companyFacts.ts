// EDGAR company-facts (XBRL) lookup for the numeric cross-check (§18). Pure. Never an extraction
// source: a fact can confirm a value the model quoted, but it never creates one.
import type { MetricName, PeriodType } from "@eia/shared";

interface FactEntry {
  start?: string;
  end: string;
  val: number;
  filed: string;
}

export interface CompanyFacts {
  facts?: { "us-gaap"?: Record<string, { units: Record<string, FactEntry[]> }> };
}

/** us-gaap concepts per metric, most specific first. Gross margin is derived; fcf has no concept. */
const CONCEPTS: Partial<Record<MetricName, { concepts: string[]; unit: string }>> = {
  revenue: {
    concepts: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"],
    unit: "USD",
  },
  eps_gaap: { concepts: ["EarningsPerShareDiluted"], unit: "USD/shares" },
  net_income: { concepts: ["NetIncomeLoss"], unit: "USD" },
  op_income: { concepts: ["OperatingIncomeLoss"], unit: "USD" },
  capex: { concepts: ["PaymentsToAcquirePropertyPlantAndEquipment"], unit: "USD" },
};

const QUARTER_DAYS = 91.3;
/** Allowed spread around a nominal duration (52/53-week years, odd calendars). */
const DURATION_SLACK_DAYS = 12;

/** Duration window of a period type; year to date depends on which quarter it runs to. */
function durationDays(periodType: PeriodType, quarter: number): [number, number] {
  const nominal =
    periodType === "quarter" ? QUARTER_DAYS : periodType === "full_year" ? 4 * QUARTER_DAYS : quarter * QUARTER_DAYS;
  return [nominal - DURATION_SLACK_DAYS, nominal + DURATION_SLACK_DAYS];
}
const END_TOLERANCE_DAYS = 10;
const DAY_MS = 86_400_000;

/**
 * Every value company-facts reports for the metric over a period of that type ending near
 * `periodEnd`. `fiscalPeriod` ("2026-Q2") sets how long a year-to-date period is. Several concepts
 * (revenue tags) can disagree, so all are returned; a match on any one confirms the extraction.
 */
export function factValues(
  facts: CompanyFacts | null,
  metric: MetricName,
  periodType: PeriodType,
  periodEnd: Date,
  fiscalPeriod: string,
): number[] {
  const gaap = facts?.facts?.["us-gaap"];
  if (!gaap) return [];
  const quarter = Number(/Q([1-4])$/.exec(fiscalPeriod)?.[1] ?? 4);
  if (metric === "gross_margin") return grossMargins(facts, periodType, periodEnd, fiscalPeriod, quarter);
  const spec = CONCEPTS[metric];
  if (!spec) return [];
  const out: number[] = [];
  for (const concept of spec.concepts) {
    for (const e of gaap[concept]?.units[spec.unit] ?? []) {
      if (matchesPeriod(e, periodType, periodEnd, quarter)) out.push(e.val);
    }
  }
  return [...new Set(out)];
}

function grossMargins(
  facts: CompanyFacts | null,
  periodType: PeriodType,
  periodEnd: Date,
  fiscalPeriod: string,
  quarter: number,
): number[] {
  const gp = facts?.facts?.["us-gaap"]?.GrossProfit?.units.USD ?? [];
  const profits = gp.filter((e) => matchesPeriod(e, periodType, periodEnd, quarter)).map((e) => e.val);
  const revenues = factValues(facts, "revenue", periodType, periodEnd, fiscalPeriod);
  return profits.flatMap((p) => revenues.filter((r) => r !== 0).map((r) => (p / r) * 100));
}

function matchesPeriod(e: FactEntry, periodType: PeriodType, periodEnd: Date, quarter: number): boolean {
  if (!e.start) return false;
  const end = Date.parse(`${e.end}T00:00:00Z`);
  if (Math.abs(end - periodEnd.getTime()) > END_TOLERANCE_DAYS * DAY_MS) return false;
  const days = (end - Date.parse(`${e.start}T00:00:00Z`)) / DAY_MS;
  const [min, max] = durationDays(periodType, quarter);
  return days >= min && days <= max;
}
