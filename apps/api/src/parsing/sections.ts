// Deterministic section labelling (§16) - heading matchers, no LLM.
import type { ChunkSection, DocumentType } from "@eia/shared";
import type { Block } from "./html";

export type LabelledBlock = Block & { section: ChunkSection };

/** Strip "Item 2." numbering and punctuation so headings compare by their words. */
function headingKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/^item\s+\d+[a-z]?\.?\s*/, "")
    .replace(/[^a-z' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function filingSectionFor(heading: string): ChunkSection | null {
  const key = headingKey(heading);
  if (/^management's discussion and analysis/.test(key)) return "mda";
  if (/^risk factors/.test(key)) return "risk";
  // Any other top-level "Item N." heading ends the current section.
  if (/^item\s+\d/i.test(heading.trim())) return "other";
  return null;
}

/**
 * The headline table is the first table with real figures: at least three rows, most containing a
 * digit. Logo/letterhead tables at the top of a release don't qualify.
 */
export function findHeadlineTable(blocks: Block[]): number | null {
  const rowsByTable = new Map<number, Block[]>();
  for (const b of blocks) {
    if (b.kind !== "table_row" || b.tableIndex === undefined) continue;
    const rows = rowsByTable.get(b.tableIndex) ?? [];
    rows.push(b);
    rowsByTable.set(b.tableIndex, rows);
  }
  for (const [index, rows] of [...rowsByTable].sort((a, b) => a[0] - b[0])) {
    const numeric = rows.filter((r) => /\d/.test(r.text)).length;
    if (rows.length >= 3 && numeric / rows.length >= 0.5) return index;
  }
  return null;
}

export function labelSections(type: DocumentType, blocks: Block[]): LabelledBlock[] {
  if (type === "press_release") {
    const headline = findHeadlineTable(blocks);
    return blocks.map((b) => ({
      ...b,
      section: b.kind === "table_row" && b.tableIndex === headline ? "headline_table" : "release_body",
    }));
  }
  if (type === "filing_10q" || type === "filing_10k") {
    let current: ChunkSection = "other";
    return blocks.map((b) => {
      // Table-of-contents entries live in tables, so only real headings move the section.
      if (b.kind === "heading") current = filingSectionFor(b.text) ?? current;
      return { ...b, section: current };
    });
  }
  // Transcripts are split by speaker turns from the provider, not by headings (fix 5: off in the MVP).
  return blocks.map((b) => ({ ...b, section: "other" }));
}
