import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
loadDotenv({ path: path.join(repoRoot, ".env"), quiet: true });

const bool = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  EDGAR_USER_AGENT: z
    .string()
    .min(1)
    .refine((v) => /\S+@\S+/.test(v), "EDGAR_USER_AGENT must include a contact email (SEC fair-access policy)"),
  EDGAR_MAX_RPS: z.coerce.number().int().min(1).max(10).default(8),
  DATA_PROVIDER: z.enum(["finnhub"]).default("finnhub"),
  PROVIDER_API_KEY: z.string().default(""),
  TRANSCRIPTS_ENABLED: bool,
  OPENAI_API_KEY: z.string().default(""),
  STRONG_MODEL: z.string().default(""),
  SMALL_MODEL: z.string().default(""),
  EMBED_MODEL: z.string().default("text-embedding-3-small"),
  REVIEW_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  RAW_DATA_DIR: z.string().default("./data/raw"),
  CACHE_DIR: z.string().default("./data/cache"),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  WATCHLIST: z.string().default(""),
  /** First discovery for a company looks this far back, so guidance has a previous quarter to compare to. */
  DISCOVERY_LOOKBACK_DAYS: z.coerce.number().int().min(30).default(400),
});

export type Config = z.infer<typeof Env> & { repoRoot: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const c = parsed.data;
  // Relative data paths resolve against the repo root, whichever package runs the code.
  return {
    ...c,
    RAW_DATA_DIR: path.resolve(repoRoot, c.RAW_DATA_DIR),
    CACHE_DIR: path.resolve(repoRoot, c.CACHE_DIR),
    repoRoot,
  };
}
