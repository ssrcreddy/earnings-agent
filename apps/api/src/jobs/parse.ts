import { chunks, companies, documents, earningsEvents } from "@eia/db";
import { count, eq } from "drizzle-orm";
import { withTransaction, type AppContext } from "../context";
import { chunkDocument, type Chunk } from "../parsing/chunker";
import { cleanHtml, type CleanDocument } from "../parsing/html";
import { cleanPdf } from "../parsing/pdf";
import { labelSections } from "../parsing/sections";
import { Q, type DocumentPayload } from "../queues";
import { recomputeEventStatus } from "../services/events";

export type ParseResult =
  | { documentId: string; chunks: number; embedded: boolean; parseQuality: "normal" | "low" }
  | { skipped: "missing" | "superseded" | "already_parsed" };

const INSERT_BATCH = 200;

/** A parser problem: deterministic, so retrying won't help (§14 - "alert loudly"). */
export class ParseError extends Error {
  override name = "ParseError";
}

/**
 * §6 step 3 / §16: clean text with section labels, 300-800-token chunks, embeddings.
 * Deterministic - no LLM besides the embedding call. Re-running replaces the document's chunks.
 */
export async function parseJob(ctx: AppContext, { documentId }: DocumentPayload): Promise<ParseResult> {
  const [row] = await ctx.db
    .select({ doc: documents, ticker: companies.ticker, fiscalPeriod: earningsEvents.fiscalPeriod })
    .from(documents)
    .innerJoin(earningsEvents, eq(earningsEvents.id, documents.eventId))
    .innerJoin(companies, eq(companies.id, earningsEvents.companyId))
    .where(eq(documents.id, documentId));
  if (!row) return { skipped: "missing" };
  const { doc, ticker, fiscalPeriod } = row;
  if (doc.supersededAt) return { skipped: "superseded" };
  if (doc.status !== "ingested") {
    const [existing] = await ctx.db.select({ n: count() }).from(chunks).where(eq(chunks.documentId, documentId));
    if ((existing?.n ?? 0) > 0) return { skipped: "already_parsed" };
  }

  const bytes = await ctx.raw.read(doc.rawPath);
  const isPdf = /pdf/i.test(doc.contentType ?? "") || doc.rawPath.toLowerCase().endsWith(".pdf");
  const clean: CleanDocument = isPdf ? await cleanPdf(bytes) : cleanHtml(bytes.toString("utf8"));
  if (!clean.text.trim()) throw new ParseError(`document ${documentId} produced no text`);

  const pieces = chunkDocument(clean.text, labelSections(doc.type, clean.blocks));
  const embeddings = await embedChunks(ctx, pieces, { ticker, fiscalPeriod, docType: doc.type, documentId, eventId: doc.eventId });

  await withTransaction(ctx, async (tx) => {
    await tx.db.delete(chunks).where(eq(chunks.documentId, documentId));
    for (let i = 0; i < pieces.length; i += INSERT_BATCH) {
      await tx.db.insert(chunks).values(
        pieces.slice(i, i + INSERT_BATCH).map((c, j) => ({
          documentId,
          seq: c.seq,
          section: c.section,
          speaker: c.speaker,
          text: c.text,
          charStart: c.charStart,
          charEnd: c.charEnd,
          tokenCount: c.tokenCount,
          eventId: doc.eventId,
          ticker,
          fiscalPeriod,
          embedding: embeddings?.[i + j] ?? null,
          embedModel: embeddings ? ctx.embedder!.model : null,
        })),
      );
    }
    await tx.db
      .update(documents)
      .set({ cleanText: clean.text, parseQuality: isPdf ? "low" : "normal", status: "parsed", lastError: null })
      .where(eq(documents.id, documentId));
    await recomputeEventStatus(tx.db, doc.eventId);
    await ctx.boss.send(Q.extract, { documentId }, { singletonKey: documentId, db: tx.queue });
  });

  return { documentId, chunks: pieces.length, embedded: embeddings !== null, parseQuality: isPdf ? "low" : "normal" };
}

/**
 * What gets embedded is the chunk plus a one-line header (ticker, period, document, section), so a
 * question naming a company or quarter lands on the right chunks. The stored text stays the exact slice.
 */
export function embeddingInput(c: Pick<Chunk, "text" | "section">, h: { ticker: string; fiscalPeriod: string; docType: string }): string {
  return `${h.ticker} ${h.fiscalPeriod} ${h.docType.replace("_", " ")} - ${c.section.replace("_", " ")}\n${c.text}`;
}

async function embedChunks(
  ctx: AppContext,
  pieces: Chunk[],
  h: { ticker: string; fiscalPeriod: string; docType: string; documentId: string; eventId: string },
): Promise<number[][] | null> {
  if (!ctx.embedder || pieces.length === 0) {
    if (!ctx.embedder) ctx.log.warn({ documentId: h.documentId }, "no embedder configured; storing chunks without embeddings");
    return null;
  }
  return ctx.embedder.embed(
    pieces.map((c) => embeddingInput(c, h)),
    { eventId: h.eventId, documentId: h.documentId },
  );
}
