// Regex pre-pass over a press release's headline table (§18 step 2): deterministic, free, and the
// cross-check the model's numbers must agree with. Pure.
import type { MetricName, MetricUnit } from "@eia/shared";
import { findNumbers, tableScaleIn } from "./numbers";
import type { LabelledBlock } from "./sections";

export interface HeadlineFigure {
  metric: MetricName;
  /** Base units: dollars for usd, dollars per share, percentage points for percent. */
  value: number;
  unit: MetricUnit;
  row: string;
}

const ROW_PATTERNS: { metric: MetricName; unit: MetricUnit; re: RegExp }[] = [
  { metric: "revenue", unit: "usd", re: /^(total\s+)?(operating\s+)?(net\s+)?(revenues?|sales)$/ },
  {
    metric: "eps_gaap",
    unit: "usd_per_share",
    re: /^(gaap\s+)?(diluted\s+(earnings|net income|income)\s+per\s+(common\s+)?share|diluted\s+eps|earnings\s+per\s+(common\s+)?share\s*[-–(]?\s*diluted\)?)$/,
  },
  { metric: "net_income", unit: "usd", re: /^(gaap\s+)?net\s+income(\s+\(loss\))?(\s+attributable\s+to\s+.+)?$/ },
  { metric: "op_income", unit: "usd", re: /^(gaap\s+)?operating\s+income(\s+\(loss\))?$/ },
  { metric: "gross_margin", unit: "percent", re: /^(gaap\s+)?gross\s+margin(\s+(%|percentage))?$/ },
  { metric: "fcf", unit: "usd", re: /^free\s+cash\s+flows?$/ },
  { metric: "capex", unit: "usd", re: /^capital\s+expenditures(\s*\(.*\))?$/ },
];

/** Characters of text before the table searched for a "(in millions)" style caption. */
const CAPTION_WINDOW = 800;

/**
 * Figures from the headline table's rows for the current period (the first figure column).
 * Rows it can't read with certainty are skipped - this is a cross-check, not a source of truth.
 */
export function parseHeadlineTable(text: string, blocks: LabelledBlock[]): HeadlineFigure[] {
  const rows = blocks.filter((b) => b.section === "headline_table" && b.kind === "table_row");
  if (rows.length === 0) return [];
  const before = text.slice(Math.max(0, rows[0]!.start - CAPTION_WINDOW), rows[0]!.start);
  const header = rows
    .filter((r) => !/\d{3,}|\$\d/.test(r.text))
    .map((r) => r.text)
    .join(" ");
  // A caption inside the table wins over one in the text above it.
  const scale = tableScaleIn(header) ?? tableScaleIn(rows[0]!.text) ?? tableScaleIn(before);

  const out: HeadlineFigure[] = [];
  const seen = new Set<MetricName>();
  for (const r of rows) {
    const [label, ...cells] = r.text.split(" | ");
    if (!label || cells.length === 0) continue;
    const key = label.toLowerCase().replace(/\s+/g, " ").replace(/[:*\d]+$/, "").trim();
    const pattern = ROW_PATTERNS.find((p) => p.re.test(key));
    if (!pattern || seen.has(pattern.metric)) continue;

    const first = findNumbers(cells[0]!)[0];
    if (!first) continue;
    let value: number;
    if (pattern.unit === "percent") {
      if (!first.percent) continue;
      value = first.value;
    } else if (pattern.unit === "usd_per_share") {
      value = first.value;
    } else {
      // A dollar row needs a known table scale (or an explicit scale word in the cell).
      if (first.scale === 1 && scale === null) continue;
      value = first.value * (first.scale !== 1 ? first.scale : scale!);
    }
    seen.add(pattern.metric);
    out.push({ metric: pattern.metric, value, unit: pattern.unit, row: r.text });
  }
  return out;
}
