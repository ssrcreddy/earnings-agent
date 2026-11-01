import { earningsEvents } from "@eia/db";
import { eq } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import type { AppContext } from "./context";
import { HttpError } from "./errors";
import { discoverJob } from "./jobs/discover";
import { ingestJob } from "./jobs/ingest";
import { Q, createQueues, type DiscoverPayload, type IngestPayload } from "./queues";

const NY = "America/New_York";

/** Worker mode: pg-boss consumers + cron schedules (§14). */
export async function startWorker(ctx: AppContext): Promise<void> {
  await createQueues(ctx.boss);

  // Fix 8: schedules evaluated in New York time, so 18:30 ET survives daylight-saving changes.
  await ctx.boss.schedule(Q.discover, "30 18 * * *", { mode: "nightly" } satisfies DiscoverPayload, {
    tz: NY,
    key: "nightly",
    singletonKey: "nightly",
  });
  // Earnings-window polls: every 30 minutes on weekdays; the job no-ops unless a print is due.
  await ctx.boss.schedule(Q.discover, "*/30 6-21 * * 1-5", { mode: "window" } satisfies DiscoverPayload, {
    tz: NY,
    key: "window",
    singletonKey: "window",
  });

  await ctx.boss.work<DiscoverPayload>(Q.discover, { localConcurrency: 1 }, async (jobs) => {
    for (const job of jobs) {
      const log = ctx.log.child({ jobId: job.id, queue: Q.discover });
      const result = await discoverJob(ctx, job.data);
      log.info(result, "discover finished");
    }
  });

  // EDGAR's rate limit is per process (fix 7), so a few ingests in parallel is plenty.
  await ctx.boss.work(
    Q.ingest,
    { localConcurrency: 4, includeMetadata: true },
    async (jobs: JobWithMetadata<IngestPayload>[]) => {
      for (const job of jobs) {
        const log = ctx.log.child({ jobId: job.id, queue: Q.ingest, eventId: job.data.eventId });
        try {
          log.info(await ingestJob(ctx, job.data), "ingest finished");
        } catch (err) {
          await recordJobFailure(ctx, job, job.data.eventId, err);
          throw err;
        }
      }
    },
  );

  ctx.log.info("worker started");
}

/**
 * On the last attempt, or an error retrying can't fix, mark the event failed with the reason so
 * the UI can offer a requeue (§14). Earlier transient failures just let pg-boss retry.
 */
async function recordJobFailure(ctx: AppContext, job: JobWithMetadata<unknown>, eventId: string, err: unknown): Promise<void> {
  const permanent = err instanceof HttpError && !err.transient;
  const lastAttempt = job.retryCount >= job.retryLimit;
  ctx.log.warn({ err, jobId: job.id, retryCount: job.retryCount, permanent }, "job attempt failed");
  if (!permanent && !lastAttempt) return;
  const message = err instanceof Error ? err.message : String(err);
  await ctx.db
    .update(earningsEvents)
    .set({ status: "failed", lastError: message.slice(0, 2000), updatedAt: new Date() })
    .where(eq(earningsEvents.id, eventId));
}
