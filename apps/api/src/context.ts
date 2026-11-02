import { createDb, createPool, type Db } from "@eia/db";
import OpenAI from "openai";
import { PgBoss } from "pg-boss";
import type pg from "pg";
import type { Config } from "./config";
import { GatewayEmbedder, type Embedder } from "./llm/embedder";
import { LlmGateway, type OpenAILike } from "./llm/gateway";
import { PriceTable } from "./llm/pricing";
import { createLogger, type Logger } from "./logger";
import { EdgarClient } from "./sources/edgar";
import type { Fetcher } from "./sources/http";
import { createProvider, type MarketDataProvider } from "./sources/provider";
import { DisabledTranscriptSource, type TranscriptSource } from "./sources/transcripts";
import { GoldenStore } from "./services/golden";
import { RawStore } from "./storage/raw";

/** Everything a route or job needs, built once per process. */
export interface AppContext {
  config: Config;
  log: Logger;
  pool: pg.Pool;
  db: Db;
  boss: PgBoss;
  edgar: EdgarClient;
  provider: MarketDataProvider;
  transcripts: TranscriptSource;
  raw: RawStore;
  golden: GoldenStore;
  /** Null when OPENAI_API_KEY is not set: parsing still runs, chunks just have no embeddings yet. */
  llm: LlmGateway | null;
  embedder: Embedder | null;
}

export interface ContextOverrides {
  log?: Logger;
  /** Replaces network access for EDGAR and the provider (tests). */
  fetcher?: Fetcher;
  /** Replaces the OpenAI client behind the gateway (tests). */
  llmClient?: OpenAILike;
  /** Replaces the embedder (tests use HashEmbedder). */
  embedder?: Embedder;
}

export function createContext(config: Config, overrides: ContextOverrides = {}): AppContext {
  const log = overrides.log ?? createLogger(config.LOG_LEVEL);
  const pool = createPool(config.DATABASE_URL);
  const boss = new PgBoss({ connectionString: config.DATABASE_URL, max: 5 });
  boss.on("error", (err) => log.error({ err }, "pg-boss error"));
  const db = createDb(pool);

  const client =
    overrides.llmClient ??
    (config.OPENAI_API_KEY ? (new OpenAI({ apiKey: config.OPENAI_API_KEY }) as unknown as OpenAILike) : null);
  const llm = client ? new LlmGateway(client, db, log, new PriceTable(config.LLM_PRICES_JSON)) : null;
  const embedder = overrides.embedder ?? (llm ? new GatewayEmbedder(llm, config.EMBED_MODEL) : null);

  return {
    config,
    log,
    pool,
    db,
    llm,
    embedder,
    boss,
    edgar: new EdgarClient({
      userAgent: config.EDGAR_USER_AGENT,
      maxRps: config.EDGAR_MAX_RPS,
      cacheDir: config.CACHE_DIR,
      fetcher: overrides.fetcher,
    }),
    provider: createProvider(config.DATA_PROVIDER, config.PROVIDER_API_KEY, overrides.fetcher),
    transcripts: new DisabledTranscriptSource(),
    raw: new RawStore(config.RAW_DATA_DIR),
    golden: new GoldenStore(config.GOLDEN_DIR),
  };
}

export async function closeContext(ctx: AppContext): Promise<void> {
  await ctx.boss.stop({ graceful: true, close: true });
  await ctx.pool.end();
}

/** What a transaction body gets: Drizzle bound to the transaction, and a pg-boss `db` on the same connection. */
export interface TxScope {
  db: Db;
  /** Pass as `{ db: tx.queue }` to boss.send so the job commits or rolls back with the writes (fix 10). */
  queue: { executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
}

export async function withTransaction<T>(ctx: AppContext, fn: (tx: TxScope) => Promise<T>): Promise<T> {
  const client = await ctx.pool.connect();
  try {
    await client.query("begin");
    const result = await fn({
      db: createDb(client),
      queue: { executeSql: (text, values) => client.query(text, values as unknown[]) },
    });
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
