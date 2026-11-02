import { llmCalls, type Db } from "@eia/db";
import type { Logger } from "../logger";
import { PriceTable, type Usage } from "./pricing";

/**
 * The slice of the OpenAI SDK the gateway uses. The real client satisfies it; tests pass a fake.
 * Keeping it narrow is what lets another provider slot in later (§10).
 */
export interface OpenAILike {
  embeddings: {
    create(body: { model: string; input: string[] }): Promise<{
      data: { embedding: number[]; index: number }[];
      usage: { prompt_tokens: number };
    }>;
  };
  responses: {
    create(body: Record<string, unknown> & { stream: true }): Promise<AsyncIterable<ResponseStreamEvent>>;
  };
}

export interface ResponseStreamEvent {
  type: string;
  delta?: string;
  message?: string;
  response?: {
    usage?: {
      input_tokens: number;
      output_tokens: number;
      input_tokens_details?: { cached_tokens?: number };
    } | null;
    error?: { message?: string } | null;
  };
}

export interface CallMeta {
  purpose: "extract" | "brief" | "ask" | "embed" | "classify";
  promptVersion?: string;
  eventId?: string;
  documentId?: string;
}

export interface StreamTextRequest extends CallMeta {
  model: string;
  /** System-level rules. Untrusted document text never goes here - only in `input` (§9). */
  instructions: string;
  input: string;
  maxOutputTokens?: number;
}

const EMBED_BATCH = 96;

/** Reasoning-class models reject sampling parameters, so temperature is sent only where accepted. */
export function supportsTemperature(model: string): boolean {
  return !/^(o\d|gpt-5)/i.test(model);
}

/**
 * Single choke point for every model call (§5): one place for retries (the SDK's), token and cost
 * logging into llm_calls, and prompt-version tagging. Holds no business logic.
 */
export class LlmGateway {
  constructor(
    private readonly client: OpenAILike,
    private readonly db: Db,
    private readonly log: Logger,
    private readonly prices: PriceTable,
  ) {}

  async embed(model: string, texts: string[], meta: Omit<CallMeta, "purpose"> = {}): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const started = Date.now();
      try {
        const res = await this.client.embeddings.create({ model, input: batch });
        const vectors = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
        await this.record({ purpose: "embed", ...meta }, model, started, {
          inputTokens: res.usage.prompt_tokens,
          cachedInputTokens: 0,
          outputTokens: 0,
        });
        out.push(...vectors);
      } catch (err) {
        await this.record({ purpose: "embed", ...meta }, model, started, null, err);
        throw err;
      }
    }
    return out;
  }

  /** Streams output text deltas; the usage row is written when the stream ends (or fails). */
  async *streamText(req: StreamTextRequest): AsyncGenerator<string> {
    const started = Date.now();
    let usage: Usage | null = null;
    try {
      const stream = await this.client.responses.create({
        model: req.model,
        instructions: req.instructions,
        input: req.input,
        stream: true,
        store: false,
        ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
        ...(supportsTemperature(req.model) ? { temperature: 0 } : {}),
      });
      for await (const event of stream) {
        if (event.type === "response.output_text.delta" && event.delta) yield event.delta;
        else if (event.type === "response.completed" || event.type === "response.incomplete") {
          const u = event.response?.usage;
          if (u) {
            usage = {
              inputTokens: u.input_tokens,
              cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
              outputTokens: u.output_tokens,
            };
          }
        } else if (event.type === "response.failed" || event.type === "error") {
          throw new Error(event.response?.error?.message ?? event.message ?? `LLM stream ${event.type}`);
        }
      }
      await this.record(req, req.model, started, usage);
    } catch (err) {
      await this.record(req, req.model, started, usage, err);
      throw err;
    }
  }

  private async record(meta: CallMeta, model: string, started: number, usage: Usage | null, err?: unknown) {
    if (usage && !this.prices.has(model)) {
      this.log.warn({ model }, "no price configured for model; logging cost 0 (set LLM_PRICES_JSON)");
    }
    try {
      await this.db.insert(llmCalls).values({
        purpose: meta.purpose,
        model,
        promptVersion: meta.promptVersion ?? null,
        inputTokens: usage?.inputTokens ?? 0,
        cachedInputTokens: usage?.cachedInputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: String(usage ? this.prices.cost(model, usage) : 0),
        latencyMs: Date.now() - started,
        eventId: meta.eventId ?? null,
        documentId: meta.documentId ?? null,
        ok: !err,
        error: err ? String(err instanceof Error ? err.message : err).slice(0, 2000) : null,
      });
    } catch (logErr) {
      // Cost logging must never take down the call it describes.
      this.log.error({ err: logErr }, "failed to write llm_calls row");
    }
  }
}
