// Display formatting shared by the pages. Values arrive in base units (dollars, dollars per share, points).

export function formatValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return "—";
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "usd_per_share") return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${trim((abs / 1e9).toFixed(3))}B`;
  if (abs >= 1e6) return `${sign}$${trim((abs / 1e6).toFixed(1))}M`;
  return `${sign}$${abs.toLocaleString("en-US")}`;
}

export function formatRange(low: number | null, high: number | null, unit: string): string {
  if (low === null || high === null) return "Qualitative";
  return low === high ? formatValue(low, unit) : `${formatValue(low, unit)} – ${formatValue(high, unit)}`;
}

export function formatUsd(n: number): string {
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

const METRIC_LABELS: Record<string, string> = {
  revenue: "Revenue",
  eps_gaap: "GAAP EPS",
  eps_adj: "Adj. EPS",
  gross_margin: "Gross margin",
  op_income: "Operating income",
  net_income: "Net income",
  fcf: "Free cash flow",
  capex: "Capex",
};

export function metricLabel(name: string): string {
  return METRIC_LABELS[name] ?? name;
}

/** "2026-FY" -> "FY2026"; "2026-Q4" -> "Q4 FY2026". */
export function periodLabel(p: string): string {
  const [y, part] = p.split("-");
  return part === "FY" ? `FY${y}` : `${part} FY${y}`;
}

export function ageLabel(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function trim(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
