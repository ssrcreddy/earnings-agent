import { documents, earningsEvents } from "@eia/db";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { withTransaction, type AppContext } from "../context";
import { AppError } from "../errors";
import { Q } from "../queues";
import { recomputeEventStatus } from "../services/events";

const Params = z.object({ id: z.uuid() });
const Body = z.object({ stage: z.enum(["parse", "extract"]) });

export function eventRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Requeue an event's live documents from a stage (§21): after a failure, a parser fix, or a
   * prompt/model change. Idempotent through singleton keys.
   */
  app.post("/events/:id/reprocess", async (req, reply) => {
    const { id } = Params.parse(req.params);
    const { stage } = Body.parse(req.body);
    const [event] = await ctx.db.select().from(earningsEvents).where(eq(earningsEvents.id, id));
    if (!event) throw new AppError("EVENT_NOT_FOUND", `event ${id} not found`, 404);

    const queued = await withTransaction(ctx, async (tx) => {
      const docs = await tx.db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.eventId, id), isNull(documents.supersededAt)));
      for (const d of docs) {
        // Re-parsing starts from the ingested original; re-extracting from the parsed text.
        await tx.db
          .update(documents)
          .set({ status: stage === "parse" ? "ingested" : "parsed", lastError: null })
          .where(eq(documents.id, d.id));
        await ctx.boss.send(stage === "parse" ? Q.parse : Q.extract, { documentId: d.id }, { singletonKey: d.id, db: tx.queue });
      }
      await tx.db.update(earningsEvents).set({ lastError: null }).where(eq(earningsEvents.id, id));
      await recomputeEventStatus(tx.db, id);
      return docs.length;
    });
    return reply.code(202).send({ eventId: id, stage, documents: queued });
  });
}
