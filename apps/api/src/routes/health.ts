import { workerHeartbeats } from "@eia/db";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { AppContext } from "../context";
import { Q } from "../queues";

export function healthRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** DB reachability, queue depth, and the age of the last discovery run (§23). */
  app.get("/health", async (_req, reply) => {
    try {
      await ctx.db.execute(sql`select 1`);
    } catch (err) {
      ctx.log.error({ err }, "health: database unreachable");
      return reply.code(503).send({ ok: false, db: "down" });
    }
    const queues = await ctx.boss.getQueues(Object.values(Q));
    const beats = await ctx.db.select().from(workerHeartbeats);
    return {
      ok: true,
      db: "up",
      queues: Object.fromEntries(
        queues.map((q) => [
          q.name,
          { queued: q.queuedCount, active: q.activeCount, failed: q.failedCount, total: q.totalCount },
        ]),
      ),
      lastRuns: Object.fromEntries(beats.map((b) => [b.name, b.lastRunAt.toISOString()])),
    };
  });
}
