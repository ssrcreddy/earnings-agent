import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chunkDocument, countTokens, DEFAULT_CHUNK_OPTIONS } from "./chunker";
import { cleanHtml } from "./html";
import { labelSections } from "./sections";

const fixture = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/edgar/vst_2026q2_ex991.htm"),
  "utf8",
);

const sentence = (i: number) => `Sentence number ${i} talks about capital expenditures and liquidity in some detail. `;

/** Builds a clean text + blocks the same way cleanHtml lays them out. */
function doc(parts: { kind: "heading" | "paragraph" | "table_row"; text: string; section: string; tableIndex?: number }[]) {
  let text = "";
  const blocks = parts.map((p, i) => {
    const prev = parts[i - 1];
    if (i > 0) text += p.kind === "table_row" && prev?.kind === "table_row" ? "\n" : "\n\n";
    const start = text.length;
    text += p.text;
    return { ...p, start, end: text.length } as Parameters<typeof chunkDocument>[1][number];
  });
  return { text, blocks };
}

describe("chunkDocument", () => {
  it("keeps chunks within the token budget and makes each an exact slice of the text", () => {
    const long = Array.from({ length: 200 }, (_, i) => sentence(i)).join("").trim();
    const { text, blocks } = doc([{ kind: "paragraph", text: long, section: "mda" }]);
    const chunks = chunkDocument(text, blocks);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxTokens);
      expect(text.slice(c.charStart, c.charEnd)).toBe(c.text);
    }
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
  });

  it("counts the breaks between many short paragraphs and table rows toward the budget", () => {
    // Regression: real 10-Qs produced 823-token chunks because unit counts ignored separators.
    const { text, blocks } = doc([
      ...Array.from({ length: 400 }, (_, i) => ({ kind: "paragraph" as const, text: `Item ${i} rose.`, section: "mda" })),
      ...Array.from({ length: 400 }, (_, i) => ({
        kind: "table_row" as const,
        text: `Row ${i} | $${i} | $${i + 1}`,
        section: "other",
        tableIndex: 0,
      })),
    ]);
    const chunks = chunkDocument(text, blocks);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxTokens);
  });

  it("overlaps consecutive prose chunks by roughly the overlap budget", () => {
    const long = Array.from({ length: 200 }, (_, i) => sentence(i)).join("").trim();
    const { text, blocks } = doc([{ kind: "paragraph", text: long, section: "mda" }]);
    const [a, b] = chunkDocument(text, blocks);
    expect(b!.charStart).toBeLessThan(a!.charEnd);
    const overlap = countTokens(text.slice(b!.charStart, a!.charEnd));
    expect(overlap).toBeGreaterThan(20);
    expect(overlap).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.overlapTokens);
  });

  it("never splits across a section boundary, even for a short section", () => {
    const { text, blocks } = doc([
      { kind: "paragraph", text: "MD&A text about capex.", section: "mda" },
      { kind: "paragraph", text: "Risk text.", section: "risk" },
    ]);
    const chunks = chunkDocument(text, blocks);
    expect(chunks.map((c) => [c.section, c.text])).toEqual([
      ["mda", "MD&A text about capex."],
      ["risk", "Risk text."],
    ]);
  });

  it("keeps tables apart from prose, folding a short caption into its table", () => {
    const { text, blocks } = doc([
      { kind: "paragraph", text: "Some narrative before the table.", section: "release_body" },
      { kind: "heading", text: "Table 1", section: "headline_table" },
      { kind: "table_row", text: "Revenue | $4,021 | $3,612", section: "headline_table", tableIndex: 0 },
      { kind: "table_row", text: "Net income | $305 | $365", section: "headline_table", tableIndex: 0 },
      { kind: "paragraph", text: "Narrative after.", section: "release_body" },
    ]);
    const chunks = chunkDocument(text, blocks);
    expect(chunks.map((c) => c.text)).toEqual([
      "Some narrative before the table.",
      "Table 1\n\nRevenue | $4,021 | $3,612\nNet income | $305 | $365",
      "Narrative after.",
    ]);
  });

  it("does not split numbers like $1.2 billion as sentence ends", () => {
    const para = Array.from({ length: 120 }, (_, i) => `Capex was $1.${i % 10} billion in period ${i}. `).join("").trim();
    const { text, blocks } = doc([{ kind: "paragraph", text: para, section: "mda" }]);
    for (const c of chunkDocument(text, blocks)) {
      expect(c.text).toMatch(/^Capex was \$1\.\d billion/);
      expect(c.text).toMatch(/\.$/);
    }
  });

  it("chunks a real press release into retrievable pieces", () => {
    const clean = cleanHtml(fixture);
    const chunks = chunkDocument(clean.text, labelSections("press_release", clean.blocks));
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.some((c) => c.section === "headline_table")).toBe(true);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxTokens);
      expect(clean.text.slice(c.charStart, c.charEnd)).toBe(c.text);
    }
  });
});
