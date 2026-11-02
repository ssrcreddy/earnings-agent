import { ReviewAction, ReviewKind } from "@eia/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { applyReview, listReview } from "../services/review";

const Params = z.object({ kind: ReviewKind, id: z.uuid() });

export function reviewRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Pending metrics/guidance and failed candidates, oldest first, with source context (§21). */
  app.get("/review", async () => listReview(ctx));

  /** approve | correct { value | low/high, quote } | reject { reason } (candidates only). */
  app.patch("/review/:kind/:id", async (req) => {
    const { kind, id } = Params.parse(req.params);
    return applyReview(ctx, kind, id, ReviewAction.parse(req.body));
  });
}
