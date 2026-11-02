import { llmCalls, type Db } from "@eia/db";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
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
    create(body: Record<string, unknown> & { stream?: false }): Promise<ResponseObject>;
  };
}

export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
}

/** The parts of a non-streamed Responses API result the gateway reads. */
export interface ResponseObject {
  status?: string;
  output_text: string;
  output?: { type: string; content?: { type: string; refusal?: string }[] }[];
  incomplete_details?: { reason?: string } | null;
  usage?: ResponseUsage | null;
}

export interface StructuredRequest<T extends z.ZodType> extends CallMeta {
  model: string;
  instructions: string;
  input: string;
  schema: T;
  schemaName: string;
  maxOutputTokens?: number;
}

/** The model declined, or its output didn't parse: a failed attempt, never a silent empty result. */
export class StructuredOutputError extends Error {
  override name = "StructuredOutputError";
  constructor(
    message: string,
    readonly reason: "refusal" | "incomplete" | "invalid_json" | "schema",
  ) {
    super(message);
  }
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

  /**
   * One structured-output call (§18 step 3): the response is constrained to `schema` by the API,
   * then parsed with it again here - the API format is a request, the Zod parse is the guarantee.
   */
  async generateStructured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const started = Date.now();
    let usage: Usage | null = null;
    try {
      const res = await this.client.responses.create({
        model: req.model,
        instructions: req.instructions,
        input: req.input,
        store: false,
        text: { format: zodTextFormat(req.schema, req.schemaName) },
        ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
        ...(supportsTemperature(req.model) ? { temperature: 0 } : {}),
      });
      if (res.usage) {
        usage = {
          inputTokens: res.usage.input_tokens,
          cachedInputTokens: res.usage.input_tokens_details?.cached_tokens ?? 0,
          outputTokens: res.usage.output_tokens,
        };
      }
      const refusal = res.output?.flatMap((o) => o.content ?? []).find((c) => c.type === "refusal");
      if (refusal) throw new StructuredOutputError(`model refused: ${refusal.refusal ?? ""}`.trim(), "refusal");
      if (res.status === "incomplete") {
        throw new StructuredOutputError(`response incomplete: ${res.incomplete_details?.reason ?? "unknown"}`, "incomplete");
      }
      let json: unknown;
      try {
        json = JSON.parse(res.output_text);
      } catch {
        throw new StructuredOutputError("response was not valid JSON", "invalid_json");
      }
      const parsed = req.schema.safeParse(json);
      if (!parsed.success) throw new StructuredOutputError(`response failed schema: ${parsed.error.message}`, "schema");
      await this.record(req, req.model, started, usage);
      return parsed.data;
    } catch (err) {
      await this.record(req, req.model, started, usage, err);
      throw err;
    }
  }

  /** One plain-text call (brief drafting). A refusal or truncated output is an error, never a partial text. */
  async generateText(req: StreamTextRequest): Promise<string> {
    const started = Date.now();
    let usage: Usage | null = null;
    try {
      const res = await this.client.responses.create({
        model: req.model,
        instructions: req.instructions,
        input: req.input,
        store: false,
        ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
        ...(supportsTemperature(req.model) ? { temperature: 0 } : {}),
      });
      if (res.usage) {
        usage = {
          inputTokens: res.usage.input_tokens,
          cachedInputTokens: res.usage.input_tokens_details?.cached_tokens ?? 0,
          outputTokens: res.usage.output_tokens,
        };
      }
      const refusal = res.output?.flatMap((o) => o.content ?? []).find((c) => c.type === "refusal");
      if (refusal) throw new StructuredOutputError(`model refused: ${refusal.refusal ?? ""}`.trim(), "refusal");
      if (res.status === "incomplete") {
        throw new StructuredOutputError(`response incomplete: ${res.incomplete_details?.reason ?? "unknown"}`, "incomplete");
      }
      await this.record(req, req.model, started, usage);
      return res.output_text;
    } catch (err) {
      await this.record(req, req.model, started, usage, err);
      throw err;
    }
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
