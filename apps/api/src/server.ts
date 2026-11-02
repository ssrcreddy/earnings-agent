import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AppContext } from "./context";
import { AppError, HttpError } from "./errors";
import { adminRoutes } from "./routes/admin";
import { askRoutes } from "./routes/ask";
import { eventRoutes } from "./routes/events";
import { reviewRoutes } from "./routes/review";
import { companyRoutes } from "./routes/companies";
import { healthRoutes } from "./routes/health";

/** HTTP mode: REST routes only. Nothing CPU-heavy runs here - parsing lives in the worker (§9). */
export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({ loggerInstance: ctx.log as FastifyBaseLogger });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.httpStatus).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message } });
    }
    if (err instanceof HttpError) {
      req.log.warn({ err }, "upstream error");
      return reply.code(502).send({ error: { code: "UPSTREAM_ERROR", message: err.message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: "VALIDATION_FAILED", message: (err as Error).message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal error" } });
  });

  healthRoutes(app, ctx);
  companyRoutes(app, ctx);
  adminRoutes(app, ctx);
  askRoutes(app, ctx);
  eventRoutes(app, ctx);
  reviewRoutes(app, ctx);
  return app;
}
