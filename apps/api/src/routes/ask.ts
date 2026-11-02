import { Readable } from "node:stream";
import { Ticker } from "@eia/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { ask, type AskEvent } from "../services/ask";

const AskBody = z.object({
  question: z.string().trim().min(3).max(1000),
  ticker: Ticker.optional(),
});

export function askRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * POST /ask (§21): `{ refused: true, reason }` when retrieval finds nothing; otherwise a stream of
   * newline-delimited JSON events - citations first, then answer text deltas, then done.
   */
  app.post("/ask", async (req, reply) => {
    const body = AskBody.parse(req.body);
    const events = ask(ctx, body);
    const first = await events.next();
    if (first.done) return reply.send({ refused: true, reason: "not covered in the available documents" });
    if (first.value.type === "refused") return reply.send({ refused: true, reason: first.value.reason });

    async function* ndjson(): AsyncGenerator<string> {
      yield `${JSON.stringify(first.value)}\n`;
      try {
        for await (const event of events) yield `${JSON.stringify(event)}\n`;
      } catch (err) {
        req.log.error({ err }, "ask stream failed");
        const failure: AskEvent | { type: "error"; message: string } = { type: "error", message: "answer generation failed" };
        yield `${JSON.stringify(failure)}\n`;
      }
    }
    reply.header("content-type", "application/x-ndjson; charset=utf-8");
    return reply.send(Readable.from(ndjson()));
  });
}
