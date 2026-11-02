// UC-4 Ask (§17): grounded answers over the operator's own corpus, with citations - or a refusal.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppContext } from "../context";
import { retrieve, type RetrievedChunk } from "./retrieval";

export const ASK_PROMPT_VERSION = "ask.v1";
const ASK_INSTRUCTIONS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../llm/prompts", `${ASK_PROMPT_VERSION}.md`),
  "utf8",
);

export interface Citation {
  id: string; // "C1" - what the answer cites inline
  chunkId: string;
  ticker: string;
  fiscalPeriod: string;
  documentType: string;
  section: string;
  speaker: string | null;
  sourceUrl: string;
  charStart: number;
  charEnd: number;
  text: string;
  score: number;
}

export type AskEvent =
  | { type: "refused"; reason: string }
  | { type: "citations"; ticker: string | null; citations: Citation[] }
  | { type: "delta"; text: string }
  /** Retrieval worked but no answer model is configured; the citations are still the result. */
  | { type: "answer_unavailable"; reason: string }
  | { type: "done" };

export interface AskRequest {
  question: string;
  ticker?: string;
}

export function toCitations(chunks: RetrievedChunk[]): Citation[] {
  return chunks.map((c, i) => ({
    id: `C${i + 1}`,
    chunkId: c.chunkId,
    ticker: c.ticker,
    fiscalPeriod: c.fiscalPeriod,
    documentType: c.documentType,
    section: c.section,
    speaker: c.speaker,
    sourceUrl: c.sourceUrl,
    charStart: c.charStart,
    charEnd: c.charEnd,
    text: c.text,
    score: Number(c.score.toFixed(4)),
  }));
}

/** Source text is delimited as data and kept out of the instructions (§9 - injection). */
export function buildAskInput(question: string, citations: Citation[]): string {
  const excerpts = citations
    .map(
      (c) =>
        `<excerpt id="${c.id}" ticker="${c.ticker}" period="${c.fiscalPeriod}" document="${c.documentType}" section="${c.section}">\n${c.text.replace(/<\/excerpt>/gi, "</ excerpt>")}\n</excerpt>`,
    )
    .join("\n\n");
  return `Question: ${question}\n\n<excerpts>\n${excerpts}\n</excerpts>`;
}

export async function* ask(ctx: AppContext, req: AskRequest): AsyncGenerator<AskEvent> {
  const result = await retrieve(ctx, req.question, { ticker: req.ticker });
  if (result.refusal || result.chunks.length === 0) {
    // Nothing relevant retrieved: refuse without calling the LLM at all (§17).
    yield { type: "refused", reason: result.refusal ?? "not covered in the available documents" };
    return;
  }

  const citations = toCitations(result.chunks);
  yield { type: "citations", ticker: result.ticker, citations };

  const model = ctx.config.STRONG_MODEL;
  if (!ctx.llm || !model) {
    yield { type: "answer_unavailable", reason: "No answer model configured (set OPENAI_API_KEY and STRONG_MODEL)" };
    yield { type: "done" };
    return;
  }

  for await (const text of ctx.llm.streamText({
    purpose: "ask",
    promptVersion: ASK_PROMPT_VERSION,
    model,
    instructions: ASK_INSTRUCTIONS,
    input: buildAskInput(req.question, citations),
    maxOutputTokens: 1200,
  })) {
    yield { type: "delta", text };
  }
  yield { type: "done" };
}
