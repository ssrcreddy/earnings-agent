import Bottleneck from "bottleneck";
import { HttpError } from "../errors";

/** The one way sources reach the network; tests swap in a fixture-backed fetcher. */
export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export const defaultFetcher: Fetcher = (url, init) => fetch(url, init);

/** Token bucket: at most `perInterval` requests every `intervalMs`, shared by everything using it. */
export function createRateLimiter(perInterval: number, intervalMs: number): Bottleneck {
  return new Bottleneck({
    reservoir: perInterval,
    reservoirRefreshAmount: perInterval,
    reservoirRefreshInterval: intervalMs,
    maxConcurrent: perInterval,
  });
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Attempts for transient failures (429 / 5xx / network); the queue's own retries sit on top. */
  attempts?: number;
}

/** Rate-limited GET with short in-process retries for transient errors. Throws HttpError otherwise. */
export async function limitedGet(
  limiter: Bottleneck,
  fetcher: Fetcher,
  url: string,
  opts: RequestOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await limiter.schedule(() => fetcher(url, { headers: opts.headers }));
      if (res.ok) return res;
      const err = new HttpError(res.status, url);
      if (!err.transient) throw err;
      lastError = err;
    } catch (err) {
      if (err instanceof HttpError && !err.transient) throw err;
      lastError = err;
    }
    if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
