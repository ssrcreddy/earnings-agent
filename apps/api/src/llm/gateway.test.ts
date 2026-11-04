import { LlmExtractionResult } from "@eia/shared";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { extractionWindowTokens } from "../jobs/extract";
import { WINDOW_TOKENS } from "../services/extraction";
import { isReasoningModel, LlmGateway, type OpenAILike, type ResponseObject } from "./gateway";
import { PriceTable } from "./pricing";
import { TokenRateLimiter } from "./rateLimit";

/** A gateway whose OpenAI client records each request body; the DB is a no-op. */
function gateway(limiter?: TokenRateLimiter) {
  const bodies: Record<string, unknown>[] = [];
  const client = {
    embeddings: { create: async () => ({ data: [], usage: { prompt_tokens: 0 } }) },
    responses: {
      create: (async (body: Record<string, unknown>) => {
        bodies.push(body);
        const res: ResponseObject = {
          status: "completed",
          output_text: JSON.stringify({ metrics: [], guidance: [] }),
          output: [],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
        return res;
      }) as OpenAILike["responses"]["create"],
    },
  } as OpenAILike;
  const db = { insert: () => ({ values: async () => undefined }) } as never;
  return { gw: new LlmGateway(client, db, pino({ level: "silent" }), new PriceTable(), limiter), bodies };
}

const call = (gw: LlmGateway, model: string) =>
  gw.generateStructured({
    purpose: "extract",
    model,
    instructions: "Extract.",
    input: "Revenue was $1 billion.",
    schema: LlmExtractionResult,
    schemaName: "extraction_result",
    reasoningEffort: "low",
    maxOutputTokens: 8000,
  });

describe("reasoning models", () => {
  it("recognises o-series and GPT-5 and later, including gpt-6 names", () => {
    expect(["o3", "gpt-5", "gpt-5.5-2026-04-23", "gpt-6-sol", "gpt-6.1-terra"].every(isReasoningModel)).toBe(true);
    expect(["gpt-4.1", "gpt-4o-mini", "gpt-3.5-turbo"].some(isReasoningModel)).toBe(false);
  });

  it("sends reasoning effort, not temperature, to a reasoning model", async () => {
    const { gw, bodies } = gateway();
    await call(gw, "gpt-5.5-2026-04-23");
    expect(bodies[0]).toMatchObject({ reasoning: { effort: "low" }, max_output_tokens: 8000 });
    expect(bodies[0]).not.toHaveProperty("temperature");
  });

  it("sends temperature 0, not reasoning effort, to a standard model", async () => {
    const { gw, bodies } = gateway();
    await call(gw, "gpt-4.1");
    expect(bodies[0]).toMatchObject({ temperature: 0 });
    expect(bodies[0]).not.toHaveProperty("reasoning");
  });
});

describe("pacing", () => {
  it("refuses, before calling the API, a request that could never fit the per-minute limit", async () => {
    const { gw, bodies } = gateway(new TokenRateLimiter(500));
    await expect(call(gw, "gpt-5.5-2026-04-23")).rejects.toThrow(/allows 500 per minute/);
    expect(bodies).toHaveLength(0);
  });
});

describe("extractionWindowTokens", () => {
  it("uses the default window without a per-minute limit", () => {
    expect(extractionWindowTokens({ LLM_TPM_LIMIT: 0, LLM_OUTPUT_RESERVE: 3000 })).toBe(WINDOW_TOKENS);
  });

  it("sizes windows so a whole request fits a 10,000-token-per-minute limit", () => {
    const window = extractionWindowTokens({ LLM_TPM_LIMIT: 10_000, LLM_OUTPUT_RESERVE: 3000 });
    expect(window).toBeGreaterThan(3500);
    expect(window).toBeLessThan(6000);
  });

  it("explains when the limit leaves no room for a document", () => {
    expect(() => extractionWindowTokens({ LLM_TPM_LIMIT: 4000, LLM_OUTPUT_RESERVE: 3000 })).toThrow(/raise the limit/);
  });
});
