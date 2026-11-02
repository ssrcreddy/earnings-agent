// Chunking (§16). Pure: blocks in, chunks out. Every chunk is an exact slice of the clean text,
// so its char offsets make citations clickable to the passage.
import type { ChunkSection } from "@eia/shared";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";
import type { LabelledBlock } from "./sections";

/** cl100k_base is the tokenizer of text-embedding-3-small, the embedding model. */
export const countTokens = (text: string): number => encode(text).length;

export interface ChunkOptions {
  minTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { minTokens: 300, maxTokens: 800, overlapTokens: 80 };

export interface Chunk {
  seq: number;
  section: ChunkSection;
  speaker: string | null;
  text: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
}

interface Unit {
  start: number;
  end: number;
  tokens: number;
}

interface Group {
  section: ChunkSection;
  speaker: string | null;
  isTable: boolean;
  tableIndex?: number;
  units: Unit[];
}

/** A short heading-only group in front of a table is that table's caption, not a chunk of its own. */
const CAPTION_MAX_TOKENS = 50;

export function chunkDocument(
  text: string,
  blocks: (LabelledBlock & { speaker?: string | null })[],
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Chunk[] {
  const groups = groupBlocks(text, blocks, opts);
  const chunks: Chunk[] = [];
  for (const g of groups) {
    for (const [start, end] of packUnits(text, g, opts)) {
      const slice = text.slice(start, end);
      chunks.push({
        seq: chunks.length,
        section: g.section,
        speaker: g.speaker,
        text: slice,
        charStart: start,
        charEnd: end,
        tokenCount: countTokens(slice),
      });
    }
  }
  return chunks;
}

/**
 * Consecutive blocks that may share a chunk: same section, same speaker, and either all prose or
 * all rows of one table. Hard boundaries (§16) fall between groups.
 */
function groupBlocks(text: string, blocks: (LabelledBlock & { speaker?: string | null })[], opts: ChunkOptions) {
  const groups: Group[] = [];
  for (const b of blocks) {
    const isTable = b.kind === "table_row";
    const speaker = b.speaker ?? null;
    const last = groups.at(-1);
    const fits =
      last &&
      last.section === b.section &&
      last.speaker === speaker &&
      last.isTable === isTable &&
      (!isTable || last.tableIndex === b.tableIndex);
    const group: Group = fits ? last : { section: b.section, speaker, isTable, tableIndex: b.tableIndex, units: [] };
    if (!fits) groups.push(group);
    group.units.push(...(isTable ? [unitOf(text, b.start, b.end)] : splitProse(text, b.start, b.end, opts.maxTokens)));
  }

  // Fold caption-sized prose groups into the table that follows them in the same section.
  const merged: Group[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const next = groups[i + 1];
    const tokens = g.units.reduce((n, u) => n + u.tokens, 0);
    if (!g.isTable && next?.isTable && next.section === g.section && tokens <= CAPTION_MAX_TOKENS) {
      next.units.unshift(...g.units);
      continue;
    }
    merged.push(g);
  }
  return merged;
}

function unitOf(text: string, start: number, end: number): Unit {
  return { start, end, tokens: countTokens(text.slice(start, end)) };
}

/** Paragraph -> sentences; any sentence longer than maxTokens is cut at word boundaries. */
function splitProse(text: string, start: number, end: number, maxTokens: number): Unit[] {
  const para = text.slice(start, end);
  const units: Unit[] = [];
  let from = 0;
  // A sentence ends at . ! ? (plus closing quotes/brackets) followed by space and a likely sentence start.
  const boundary = /[.!?]["”’)\]]*\s+(?=[A-Z0-9“"(•$])/g;
  for (let m = boundary.exec(para); m; m = boundary.exec(para)) {
    const to = m.index + m[0].trimEnd().length;
    units.push(...hardSplit(text, start + from, start + to, maxTokens));
    from = m.index + m[0].length;
  }
  if (from < para.length) units.push(...hardSplit(text, start + from, end, maxTokens));
  return units;
}

function hardSplit(text: string, start: number, end: number, maxTokens: number): Unit[] {
  const unit = unitOf(text, start, end);
  if (unit.tokens <= maxTokens) return [unit];
  const out: Unit[] = [];
  const words = [...text.slice(start, end).matchAll(/\S+\s*/g)];
  let from = start;
  let tokens = 0;
  for (const w of words) {
    const wTokens = countTokens(w[0]);
    if (tokens + wTokens > maxTokens && tokens > 0) {
      out.push(unitOf(text, from, start + w.index!));
      from = start + w.index!;
      tokens = 0;
    }
    tokens += wTokens;
  }
  out.push(unitOf(text, from, end));
  return out.map((u) => ({ ...u, end: trimEndOffset(text, u.start, u.end) }));
}

function trimEndOffset(text: string, start: number, end: number): number {
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return end;
}

/** Greedy packing up to maxTokens; prose chunks begin with ~overlapTokens of the previous chunk's tail. */
function packUnits(text: string, g: Group, opts: ChunkOptions): [number, number][] {
  const out: [number, number][] = [];
  let current: Unit[] = [];
  let tokens = 0;

  // Unit counts don't include the separators between units, so near the limit count the real slice.
  const fits = (units: Unit[], unitTokens: number, next: Unit): boolean => {
    if (units.length === 0) return true;
    if (unitTokens + next.tokens <= opts.maxTokens * 0.9) return true;
    return countTokens(text.slice(units[0]!.start, next.end)) <= opts.maxTokens;
  };

  for (const u of g.units) {
    if (!fits(current, tokens, u)) {
      out.push([current[0]!.start, current.at(-1)!.end]);
      current = g.isTable ? [] : overlapTail(current, opts.overlapTokens);
      tokens = current.reduce((n, x) => n + x.tokens, 0);
      // Never let the carried overlap itself overflow the next chunk.
      if (!fits(current, tokens, u)) {
        current = [];
        tokens = 0;
      }
    }
    current.push(u);
    tokens += u.tokens;
  }
  if (current.length) out.push([current[0]!.start, current.at(-1)!.end]);
  return out;
}

/** The trailing whole units of a chunk that fit in the overlap budget (never the whole chunk). */
function overlapTail(units: Unit[], budget: number): Unit[] {
  const tail: Unit[] = [];
  let tokens = 0;
  for (let i = units.length - 1; i > 0; i--) {
    const u = units[i]!;
    if (tokens + u.tokens > budget) break;
    tail.unshift(u);
    tokens += u.tokens;
  }
  return tail;
}
