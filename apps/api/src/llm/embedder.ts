import { createHash } from "node:crypto";
import type { LlmGateway } from "./gateway";

export const EMBEDDING_DIMENSIONS = 1536;

/** Turns text into vectors for pgvector. One model for corpus and questions, or retrieval breaks (§17). */
export interface Embedder {
  /** Stored on every chunk so a model change is detectable (§17). */
  readonly model: string;
  embed(texts: string[], meta?: { eventId?: string; documentId?: string }): Promise<number[][]>;
}

export class GatewayEmbedder implements Embedder {
  constructor(
    private readonly gateway: LlmGateway,
    readonly model: string,
  ) {}

  embed(texts: string[], meta?: { eventId?: string; documentId?: string }): Promise<number[][]> {
    return this.gateway.embed(this.model, texts, meta);
  }
}

/**
 * Deterministic bag-of-words embedder for tests and offline runs: shared words give
 * shared dimensions, so cosine similarity tracks word overlap. Not for production retrieval.
 */
export class HashEmbedder implements Embedder {
  readonly model = "test-hash-embedder";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      for (const word of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        if (word.length < 3) continue;
        const h = createHash("sha1").update(word).digest();
        v[h.readUInt32BE(0) % EMBEDDING_DIMENSIONS]! += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}
