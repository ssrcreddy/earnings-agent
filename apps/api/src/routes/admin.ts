import { Ticker } from "@eia/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { Q, type DiscoverPayload } from "../queues";

const DiscoverBody = z.object({ tickers: z.array(Ticker).optional() }).default({});

export function adminRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Run discovery now instead of waiting for the nightly cron. */
  app.post("/admin/discover", async (req, reply) => {
    const { tickers } = DiscoverBody.parse(req.body ?? {});
    const payload: DiscoverPayload = { mode: "manual", ...(tickers ? { tickers } : {}) };
    const jobId = await ctx.boss.send(Q.discover, payload, { singletonKey: "manual" });
    return reply.code(202).send({ jobId, queued: jobId !== null });
  });
}
