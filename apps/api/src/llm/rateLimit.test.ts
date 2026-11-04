import { describe, expect, it } from "vitest";
import { RequestTooLargeError, TokenRateLimiter } from "./rateLimit";

/** A fake clock: sleeping advances time instead of waiting. */
function clock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    slept,
  };
}

describe("TokenRateLimiter", () => {
  it("lets requests through while they fit in the minute's budget", async () => {
    const c = clock();
    const limiter = new TokenRateLimiter(10_000, c.now, c.sleep);
    await limiter.reserve("m", 4_000);
    await limiter.reserve("m", 5_000);
    expect(c.slept).toEqual([]);
  });

  it("waits until enough of the budget frees up", async () => {
    const c = clock();
    const limiter = new TokenRateLimiter(10_000, c.now, c.sleep);
    await limiter.reserve("m", 6_000);
    c.advance(20_000);
    await limiter.reserve("m", 6_000); // must wait for the first to leave the window
    expect(c.slept).toEqual([40_050]);
  });

  it("keeps a separate budget per model", async () => {
    const c = clock();
    const limiter = new TokenRateLimiter(10_000, c.now, c.sleep);
    await limiter.reserve("a", 9_000);
    await limiter.reserve("b", 9_000);
    expect(c.slept).toEqual([]);
  });

  it("refuses a single request larger than the limit, which could never succeed", async () => {
    const limiter = new TokenRateLimiter(10_000);
    await expect(limiter.reserve("m", 11_461)).rejects.toBeInstanceOf(RequestTooLargeError);
  });

  it("does nothing when the limit is 0", async () => {
    const c = clock();
    const limiter = new TokenRateLimiter(0, c.now, c.sleep);
    await limiter.reserve("m", 1_000_000);
    expect(c.slept).toEqual([]);
  });
});
