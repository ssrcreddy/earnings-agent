import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { documentContext, getBrief, listBriefs } from "../services/briefs";

const EventParams = z.object({ id: z.uuid() });
const ContextQuery = z.object({
  start: z.coerce.number().int().min(0),
  end: z.coerce.number().int().min(0),
});

export function briefRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** The current brief with its citations: quote, document, source URL, offsets (§21). */
  app.get("/events/:id/brief", async (req) => getBrief(ctx, EventParams.parse(req.params).id));

  /** Current briefs, newest print first. */
  app.get("/briefs", async () => ({ briefs: await listBriefs(ctx) }));

  /** Source text around a cited passage, for the citation panel (§22). */
  app.get("/documents/:id/context", async (req) => {
    const { id } = EventParams.parse(req.params);
    const { start, end } = ContextQuery.parse(req.query);
    return documentContext(ctx, id, start, end);
  });
}
