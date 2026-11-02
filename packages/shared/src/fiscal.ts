// Fix 4: derive a company's fiscal period label ("2026-Q3") from dates, never from the calendar quarter.
// fiscalYearEnd is EDGAR's "MMDD" (submissions JSON `fiscalYearEnd`, e.g. AAPL "0927", MSFT "0630").
// 52/53-week fiscal years drift a few days around the nominal date, so matching is by nearest date.

const DAY_MS = 86_400_000;
/** Max distance between a reported period end and the nominal quarter end it belongs to. */
const MATCH_TOLERANCE_DAYS = 20;
/** An earnings release never comes out within this many days of its own period end. */
const MIN_RELEASE_LAG_DAYS = 5;

export interface FiscalQuarter {
  fiscalYear: number;
  quarter: 1 | 2 | 3 | 4;
  /** "2026-Q3" */
  label: string;
  /** Nominal (not exact) quarter end, UTC midnight. */
  nominalEnd: Date;
}

function parseFye(fiscalYearEnd: string): { month: number; day: number } {
  if (!/^\d{4}$/.test(fiscalYearEnd)) throw new Error(`Invalid fiscalYearEnd "${fiscalYearEnd}"`);
  const month = Number(fiscalYearEnd.slice(0, 2));
  const day = Number(fiscalYearEnd.slice(2));
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid fiscalYearEnd "${fiscalYearEnd}"`);
  }
  return { month, day };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Nominal end of quarter `q` of fiscal year `fy` (fiscal year named by the calendar year it ends in). */
function nominalQuarterEnd(fy: number, q: 1 | 2 | 3 | 4, fye: { month: number; day: number }): Date {
  const monthsBack = (4 - q) * 3;
  let month = fye.month - monthsBack; // 1-based, may go <= 0
  let year = fy;
  while (month <= 0) {
    month += 12;
    year -= 1;
  }
  // A month-end fiscal year (e.g. 0630, 1231) has month-end quarters; otherwise clamp the day.
  const fyeIsMonthEnd = fye.day >= daysInMonth(fy, fye.month);
  const day = fyeIsMonthEnd ? daysInMonth(year, month) : Math.min(fye.day, daysInMonth(year, month));
  return new Date(Date.UTC(year, month - 1, day));
}

function candidates(around: Date, fye: { month: number; day: number }): FiscalQuarter[] {
  const out: FiscalQuarter[] = [];
  const y = around.getUTCFullYear();
  for (let fy = y - 1; fy <= y + 1; fy++) {
    for (const q of [1, 2, 3, 4] as const) {
      out.push({ fiscalYear: fy, quarter: q, label: `${fy}-Q${q}`, nominalEnd: nominalQuarterEnd(fy, q, fye) });
    }
  }
  return out;
}

/** Fiscal quarter whose end is `periodEnd` (e.g. a 10-Q's period of report). */
export function fiscalPeriodOf(periodEnd: Date, fiscalYearEnd: string): FiscalQuarter {
  const fye = parseFye(fiscalYearEnd);
  let best: FiscalQuarter | undefined;
  let bestDist = Infinity;
  for (const c of candidates(periodEnd, fye)) {
    const dist = Math.abs(c.nominalEnd.getTime() - periodEnd.getTime());
    if (dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  if (!best || bestDist > MATCH_TOLERANCE_DAYS * DAY_MS) {
    throw new Error(
      `Period end ${periodEnd.toISOString().slice(0, 10)} is not near any quarter end for FYE ${fiscalYearEnd}`,
    );
  }
  return best;
}

/** The quarter an earnings release filed on `filingDate` reports on: the latest quarter end before it. */
export function quarterReportedBy(filingDate: Date, fiscalYearEnd: string): FiscalQuarter {
  const fye = parseFye(fiscalYearEnd);
  const cutoff = filingDate.getTime() - MIN_RELEASE_LAG_DAYS * DAY_MS;
  const before = candidates(filingDate, fye)
    .filter((c) => c.nominalEnd.getTime() <= cutoff)
    .sort((a, b) => b.nominalEnd.getTime() - a.nominalEnd.getTime());
  const latest = before[0];
  if (!latest) throw new Error(`No quarter end before ${filingDate.toISOString()}`);
  return latest;
}

/** Nominal end date of a fiscal quarter label ("2026-Q2"), for matching XBRL facts by period. */
export function nominalEndOf(label: string, fiscalYearEnd: string): Date {
  const m = /^(\d{4})-Q([1-4])$/.exec(label);
  if (!m) throw new Error(`Not a fiscal quarter label: "${label}"`);
  return nominalQuarterEnd(Number(m[1]), Number(m[2]) as 1 | 2 | 3 | 4, parseFye(fiscalYearEnd));
}

/** "2026-FY" for a full-year target in fiscal year 2026. */
export function fiscalYearLabel(fiscalYear: number): string {
  return `${fiscalYear}-FY`;
}
