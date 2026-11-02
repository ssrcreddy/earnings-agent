// PDF fallback (§16): used only when a document has no HTML version. Output is marked low quality
// so extraction confidence can be read accordingly.
import { extractText } from "unpdf";
import type { Block, CleanDocument } from "./html";
import { normalize } from "./html";

export async function cleanPdf(bytes: Uint8Array): Promise<CleanDocument> {
  const { text: pages } = await extractText(new Uint8Array(bytes), { mergePages: false });
  const blocks: Block[] = [];
  let text = "";
  for (const page of pages) {
    // pdf.js text has no structure beyond line breaks; blank-line runs approximate paragraphs.
    for (const para of page.split(/\n\s*\n/)) {
      const t = normalize(para);
      if (!t) continue;
      if (text) text += "\n\n";
      const start = text.length;
      text += t;
      blocks.push({ kind: "paragraph", text: t, start, end: text.length });
    }
  }
  return { text, blocks };
}
