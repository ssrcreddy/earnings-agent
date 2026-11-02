import { chunks, documents, earningsEvents } from "@eia/db";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { withTransaction, type AppContext } from "../context";
import { Q, type IngestPayload } from "../queues";
import { documentTypeForForm, selectEarningsDocument } from "../sources/edgarParse";
import { recomputeEventStatus } from "../services/events";
import { sha256 } from "../storage/raw";

export type IngestResult =
  | { documentId: string; amended: boolean }
  | { skipped: "unchanged"; documentId: string }
  | { skipped: "no_document" };

/**
 * §6 step 2 / §15: download the document, store the untouched original, record provenance.
 * Same bytes again = no-op. New bytes for a known accession = amendment: the old version is
 * superseded and the new one runs through the pipeline.
 */
export async function ingestJob(ctx: AppContext, { eventId, ref }: IngestPayload): Promise<IngestResult> {
  const log = ctx.log.child({ eventId, accession: ref.accession });

  const entries = await ctx.edgar.getFilingIndex(ref.cik, ref.accession);
  const entry = selectEarningsDocument(ref.form, entries);
  if (!entry) {
    log.warn({ form: ref.form }, "filing has no processable document");
    await ctx.db
      .update(earningsEvents)
      .set({ lastError: `${ref.form} ${ref.accession}: no ${ref.form === "8-K" ? "EX-99" : ref.form} document` })
      .where(eq(earningsEvents.id, eventId));
    return { skipped: "no_document" };
  }

  const { bytes, contentType } = await ctx.edgar.fetchDocument(entry.url);
  const hash = sha256(bytes);

  const [same] = await ctx.db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.eventId, eventId), eq(documents.sha256, hash)));
  if (same) return { skipped: "unchanged", documentId: same.id };

  const rawPath = await ctx.raw.store(ref.ticker, ref.accession, entry.filename, bytes);

  return withTransaction(ctx, async (tx) => {
    const [doc] = await tx.db
      .insert(documents)
      .values({
        eventId,
        type: documentTypeForForm(ref.form),
        sourceUrl: entry.url,
        provider: "edgar",
        externalId: ref.accession,
        sha256: hash,
        rawPath,
        contentType,
        fetchedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: documents.id });
    if (!doc) {
      // A concurrent run inserted the same bytes first.
      const [existing] = await tx.db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.eventId, eventId), eq(documents.sha256, hash)));
      return { skipped: "unchanged" as const, documentId: existing!.id };
    }

    const superseded = await tx.db
      .update(documents)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(documents.externalId, ref.accession),
          ne(documents.id, doc.id),
          isNull(documents.supersededAt),
        ),
      )
      .returning({ id: documents.id });
    if (superseded.length) {
      // Ask must never cite a superseded text (§17).
      await tx.db
        .update(chunks)
        .set({ supersededAt: new Date() })
        .where(
          and(
            inArray(
              chunks.documentId,
              superseded.map((s) => s.id),
            ),
            isNull(chunks.supersededAt),
          ),
        );
      log.info({ superseded: superseded.length }, "amended document; prior version and its chunks superseded");
    }

    await recomputeEventStatus(tx.db, eventId);
    await tx.db.update(earningsEvents).set({ lastError: null }).where(eq(earningsEvents.id, eventId));
    await ctx.boss.send(Q.parse, { documentId: doc.id }, { singletonKey: doc.id, db: tx.queue });
    return { documentId: doc.id, amended: superseded.length > 0 };
  });
}
