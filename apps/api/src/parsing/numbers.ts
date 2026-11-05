// Number reading shared by the headline-table pre-pass and the validator. Pure.

/** A figure as written in a document, e.g. "$4.02 billion", "(12)", "75.0%", "$(27)". */
export interface NumberToken {
  /** The number as written, sign applied, before any scale word: "$4.02 billion" -> 4.02. */
  value: number;
  /** Multiplier from a following scale word: billion -> 1e9, million -> 1e6, thousand -> 1e3. */
  scale: number;
  percent: boolean;
  currency: boolean;
  /** Decimal places as written, for rounding tolerance: "4.02" -> 2. */
  decimals: number;
  text: string;
}

const SCALE_WORDS: Record<string, number> = {
  trillion: 1e12,
  billion: 1e9,
  bn: 1e9,
  b: 1e9,
  million: 1e6,
  mm: 1e6,
  m: 1e6,
  thousand: 1e3,
  k: 1e3,
};

// Sign or opening paren, optional currency, digits with thousands separators and decimals,
// optional closing paren, optional percent or scale word.
const NUMBER_RE =
  /(-|−|\()?\s*(\$|€|£)?\s*(\()?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(\))?\s*(%|percent\b|(?:trillion|billion|million|thousand|bn|mm)\b|[BMK]\b)?/gi;

// A dash right after a figure joins a range ("$3,925 - $4,725"); it is not a minus sign.
const RANGE_START = /(?:[\d%)]|\b(?:trillion|billion|million|thousand|bn|mm))\s*$/i;

export function findNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const [whole, sign, currency, innerParen, intPart, frac, closeParen, suffix] = m;
    const dash = (sign === "-" || sign === "−") && !RANGE_START.test(text.slice(Math.max(0, m.index - 12), m.index));
    const negative = dash || ((sign === "(" || innerParen === "(") && closeParen === ")");
    const n = Number(`${intPart!.replace(/,/g, "")}${frac ?? ""}`);
    const suf = suffix?.toLowerCase();
    const percent = suf === "%" || suf === "percent";
    const scale = suf && !percent ? (SCALE_WORDS[suf] ?? 1) : 1;
    out.push({
      value: negative ? -n : n,
      scale,
      percent,
      currency: Boolean(currency),
      decimals: frac ? frac.length - 1 : 0,
      text: whole.trim(),
    });
  }
  return out;
}

/** "(in millions", "Millions of Dollars", "$ in thousands" -> the multiplier tables use. */
export function tableScaleIn(text: string): number | null {
  const t = text.toLowerCase();
  if (/(in|of)\s+(us\s+)?(dollars\s+in\s+)?billions|billions of (us )?dollars/.test(t)) return 1e9;
  if (/(\$|dollars|amounts)?\s*in\s+millions|millions of (us )?dollars|\(millions\)/.test(t)) return 1e6;
  if (/(\$|dollars|amounts)?\s*in\s+thousands|thousands of (us )?dollars|\(thousands\)/.test(t)) return 1e3;
  return null;
}

/** Equal within relative tolerance, or within the rounding of the figure as written. */
export function approxEqual(a: number, b: number, relTol: number, roundingAbs = 0): boolean {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  if (diff <= roundingAbs) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && diff / scale <= relTol;
}
