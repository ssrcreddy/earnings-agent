// Brief post-check (§20 step 3): code, not the model, decides whether a draft can be published.
import { findNumbers } from "../parsing/numbers";
import { allowedNumbers, type FactSheet } from "./factSheet";

/** Recommendation language is forbidden: briefs report facts (§9 output safety). */
const BLOCKLIST = [
  /\bstrong buy\b/i,
  /\b(buy|sell)\b(?!-?side)/i,
  /\b(hold|accumulate)\s+(the\s+)?(stock|shares|rating)\b/i,
  /\b(under|over)valued\b/i,
  /\bprice target\b/i,
  /\b(out|under)perform\b/i,
  /\brecommend(s|ed|ation)?\b/i,
  /\b(attractive|cheap|expensive)\s+(stock|valuation|entry)\b/i,
];

const CITATION = /\[([MG]\d+)\]/g;
/** Relative slack for large figures written in rounded units ("$4.02 billion" for 4,021,000,000). */
const ROUNDING_REL = 0.0005;

export interface BriefCheckResult {
  ok: boolean;
  errors: string[];
  /** Fact ids the draft cites, in first-use order. */
  cited: string[];
}

/** Numbers that aren't figures: years, fiscal labels (Q2, FY26), list markers, footnote-free counts. */
function isLabelNumber(line: string, index: number, text: string): boolean {
  const before = line.slice(Math.max(0, index - 6), index);
  const n = Number(text.replace(/[$,]/g, ""));
  if (/^\d{4}$/.test(text) && n >= 1990 && n <= 2100) return true; // years
  if (/(Q|FY|H)$/i.test(before) && n <= 99) return true; // Q2, FY26, H1
  if (/^\d$/.test(text) && /^\s*$/.test(line.slice(0, index))) return true; // numbered list
  return false;
}

function normalizeQuote(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function checkBrief(draft: string, sheet: FactSheet): BriefCheckResult {
  const errors: string[] = [];
  const ids = new Set([...sheet.metrics.map((m) => m.id), ...sheet.guidance.map((g) => g.id)]);
  const cited: string[] = [];
  const allowed = allowedNumbers(sheet);

  for (const m of draft.matchAll(CITATION)) {
    const id = m[1]!;
    if (!ids.has(id)) errors.push(`cites ${id}, which is not in the fact sheet`);
    else if (!cited.includes(id)) cited.push(id);
  }

  // The reader never sees the pipeline: no talk of the inputs the writer was given.
  if (/\bfact[- ]sheet\b/i.test(draft)) errors.push('mentions "the fact sheet" - write for the reader, not about the inputs');

  for (const re of BLOCKLIST) {
    const hit = re.exec(draft);
    if (hit) errors.push(`uses recommendation language ("${hit[0]}") - briefs state facts only`);
  }

  // Verbatim source quotes may carry other figures: they are cited text, not claims the brief makes.
  const quotes = [...sheet.metrics, ...sheet.guidance].map((f) => normalizeQuote(f.quote));
  for (const rawLine of draft.split("\n")) {
    // Citation ids ("M1") are references, not figures.
    let line = rawLine.replace(CITATION, (s) => " ".repeat(s.length));
    line = line.replace(/["“]([^"”]{10,})["”]/g, (whole, inner: string) => {
      if (quotes.some((q) => q.includes(normalizeQuote(inner)))) return " ".repeat(whole.length);
      errors.push(`quotes text that is not a fact's source quote: "${inner.slice(0, 60)}"`);
      return whole;
    });
    let lineHasFigure = false;
    for (const m of line.matchAll(/(?:\$|-|\+|−)?\(?\d[\d,]*(?:\.\d+)?\)?\s*(?:%|billion|million|thousand|pts?\b|bps\b)?/gi)) {
      const text = m[0].trim();
      const digits = /\d[\d,]*(?:\.\d+)?/.exec(text)![0];
      if (isLabelNumber(line, m.index! + text.indexOf(digits), digits)) continue;
      const token = findNumbers(text)[0];
      if (!token) continue;
      lineHasFigure = true;
      // A figure may be rounded to the decimals written: "5.2%" stands for 5.15..5.25.
      const slack = 0.5 * 10 ** -token.decimals + 1e-9;
      const candidates = [
        { v: token.value, slack },
        { v: token.value * token.scale, slack: slack * token.scale },
      ];
      const ok = candidates.some(({ v, slack: s }) =>
        allowed.some((a) => Math.abs(Math.abs(a) - Math.abs(v)) <= Math.max(s, Math.abs(a) * ROUNDING_REL)),
      );
      if (!ok) errors.push(`states "${text}", which is not a fact-sheet value`);
    }
    if (lineHasFigure && !/\[[MG]\d+\]/.test(rawLine)) {
      errors.push(`a line with figures has no citation: "${rawLine.trim().slice(0, 80)}"`);
    }
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)], cited };
}
