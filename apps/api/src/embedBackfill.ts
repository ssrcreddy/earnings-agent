// Embeds chunks stored without vectors (parsed before OPENAI_API_KEY was set, or after a model change).
// Usage: pnpm embed:backfill  [--model-change]  (the flag also re-embeds chunks from a different model)
import { chunks, documents } from "@eia/db";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { loadConfig } from "./config";
import { createContext } from "./context";
import { embeddingInput } from "./jobs/parse";

const BATCH = 96;

async function main(): Promise<void> {
  const ctx = createContext(loadConfig());
  try {
    if (!ctx.embedder) throw new Error("OPENAI_API_KEY is not set; nothing can be embedded");
    const includeOtherModels = process.argv.includes("--model-change");
    const pending = await ctx.db
      .select({
        id: chunks.id,
        text: chunks.text,
        section: chunks.section,
        ticker: chunks.ticker,
        fiscalPeriod: chunks.fiscalPeriod,
        docType: documents.type,
        eventId: chunks.eventId,
      })
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(
        and(
          isNull(chunks.supersededAt),
          includeOtherModels
            ? or(isNull(chunks.embedding), ne(chunks.embedModel, ctx.embedder.model))
            : isNull(chunks.embedding),
        ),
      );
    console.log(`${pending.length} chunks to embed with ${ctx.embedder.model}`);
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      const vectors = await ctx.embedder.embed(batch.map((c) => embeddingInput(c, c)));
      for (const [j, c] of batch.entries()) {
        await ctx.db
          .update(chunks)
          .set({ embedding: vectors[j]!, embedModel: ctx.embedder.model })
          .where(inArray(chunks.id, [c.id]));
      }
      console.log(`embedded ${Math.min(i + BATCH, pending.length)}/${pending.length}`);
    }
  } finally {
    await ctx.pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
