// HTML filings/releases -> clean text + positioned blocks (§16). Pure: no I/O, no LLM.
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

export type BlockKind = "heading" | "paragraph" | "table_row";

export interface Block {
  kind: BlockKind;
  text: string;
  /** Offsets into CleanDocument.text; text === clean.text.slice(start, end). */
  start: number;
  end: number;
  /** Which table a row belongs to (0-based, document order). */
  tableIndex?: number;
  /** Row position within its table. */
  rowIndex?: number;
}

export interface CleanDocument {
  text: string;
  blocks: Block[];
}

// Everything not listed here is treated as a block - EDGAR wraps documents in SGML tags
// (<document>, <type>, <text>) that a block allow-list would miss.
const INLINE_TAGS = new Set([
  "span", "font", "b", "strong", "i", "em", "u", "a", "sup", "sub", "small", "big", "abbr", "code", "s", "strike",
  "mark", "label",
]);
const isInline = (tag: string): boolean => INLINE_TAGS.has(tag) || tag.startsWith("ix:");

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const MAX_HEADING_CHARS = 140;

export function cleanHtml(html: string): CleanDocument {
  const $ = cheerio.load(html);
  // Scripts, styles and the hidden inline-XBRL header carry no readable content.
  // <title> is listed too: inside the SGML wrapper the parser puts it in the body.
  $("script, style, head, title, noscript, ix\\:header").remove();
  // EDGAR SGML wrapper fields ("EX-99.1", sequence number, filename) are metadata, not content.
  // They are never closed, so the parser nests the rest of the document inside them: drop only
  // their own text and unwrap them, keeping the children.
  $("type, sequence, filename, description").each((_, el) => {
    $(el)
      .contents()
      .filter((__, n) => n.type === "text")
      .remove();
    $(el).replaceWith($(el).contents());
  });
  $("[style]").each((_, el) => {
    if (/display\s*:\s*none/i.test($(el).attr("style") ?? "")) $(el).remove();
  });

  const raw: Omit<Block, "start" | "end">[] = [];
  let tableIndex = 0;

  const isHeading = (el: Element, tag: string, text: string): boolean => {
    if (text.length > MAX_HEADING_CHARS) return false;
    // Sentences end in punctuation; headings don't (except "Item 2." style headings).
    if (/[.:;,]$/.test(text) && !/^item\s+\d/i.test(text)) return false;
    if (HEADING_TAGS.has(tag)) return true;
    // EDGAR headings are usually a block whose visible text is entirely bold.
    const texts = textNodesUnder(el);
    return texts.length > 0 && texts.every((t) => underBold(t, el));
  };

  const underBold = (node: AnyNode, root: Element): boolean => {
    for (let cur = node.parent as Element | null; cur; cur = cur.parent as Element | null) {
      if (isBold($(cur).attr("style"), cur.tagName.toLowerCase())) return true;
      if (cur === root) return false;
    }
    return false;
  };

  const emitTable = (table: Element, index: number): void => {
    let rowIndex = 0;
    $(table)
      .find("tr")
      .each((_, tr) => {
        const cells = $(tr)
          .children("td, th")
          .map((__, c) => normalize($(c).text()))
          .get()
          .filter(Boolean);
        const text = joinCells(cells);
        if (text) raw.push({ kind: "table_row", text, tableIndex: index, rowIndex: rowIndex++ });
      });
  };

  const walk = (node: AnyNode): void => {
    if (node.type !== "tag") return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "table") {
      emitTable(el, tableIndex++);
      return;
    }
    if (!hasBlockChild(el)) {
      const text = normalize($(el).text());
      if (text) raw.push({ kind: isHeading(el, tag, text) ? "heading" : "paragraph", text });
      return;
    }
    // Mixed content: inline text directly under a block parent is its own paragraph.
    let inline = "";
    const flush = () => {
      const text = normalize(inline);
      if (text) raw.push({ kind: "paragraph", text });
      inline = "";
    };
    for (const child of el.children) {
      if (child.type === "text") inline += (child as unknown as { data: string }).data;
      else if (child.type === "tag" && isInline((child as Element).tagName.toLowerCase())) inline += $(child).text();
      else {
        flush();
        walk(child);
      }
    }
    flush();
  };

  // Walk <body> itself, not just its child elements: text placed directly in it is content too.
  const body = $("body").get(0);
  if (body) walk(body);
  else for (const child of $.root().get(0)?.children ?? []) walk(child);

  // Assemble text: paragraphs/headings separated by blank lines, table rows by single newlines.
  let text = "";
  const blocks: Block[] = [];
  for (const b of raw) {
    const prev = blocks.at(-1);
    if (prev) {
      const sameTable = prev.kind === "table_row" && b.kind === "table_row" && prev.tableIndex === b.tableIndex;
      text += sameTable ? "\n" : "\n\n";
    }
    const start = text.length;
    text += b.text;
    blocks.push({ ...b, start, end: text.length });
  }
  return { text, blocks };
}

function hasBlockChild(el: Element): boolean {
  return el.children.some((c) => c.type === "tag" && !isInline((c as Element).tagName.toLowerCase()));
}

function textNodesUnder(el: Element): AnyNode[] {
  const out: AnyNode[] = [];
  const visit = (n: AnyNode) => {
    if (n.type === "text") {
      if (/\S/.test((n as unknown as { data: string }).data)) out.push(n);
    } else if (n.type === "tag") {
      for (const c of (n as Element).children) visit(c);
    }
  };
  visit(el);
  return out;
}

function isBold(style: string | undefined, tag: string): boolean {
  if (tag === "b" || tag === "strong") return true;
  return /font-weight\s*:\s*(bold|[6-9]00)/i.test(style ?? "");
}

/** Collapse whitespace, including non-breaking and zero-width spaces, to single spaces. */
export function normalize(s: string): string {
  return (
    s
      .replace(/[\s\u00a0\u200b]+/g, " ")
      .trim()
      // Bullets often sit in their own span with no space before the text.
      .replace(/^([\u2022\u00b7\u25aa\u25e6\u2023])\s*/, "$1 ")
  );
}

/**
 * EDGAR tables split "$", the number and ")" or "%" into separate cells. Glue them back so a
 * row reads "Revenue | $4,021 | $3,612" - the shape the headline-table regex expects (§16).
 */
export function joinCells(cells: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    if (/^[$€£]$/.test(c) && i + 1 < cells.length) {
      cells[i + 1] = `${c}${cells[i + 1]}`;
      continue;
    }
    if (/^(\)|%|\)%|pts?)$/.test(c) && out.length) {
      out[out.length - 1] += c === "pts" || c === "pt" ? ` ${c}` : c;
      continue;
    }
    out.push(c);
  }
  return out.join(" | ");
}
