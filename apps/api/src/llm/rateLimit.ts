// Tokens-per-minute pacing for model calls. OpenAI counts a request's input tokens plus its
// max_output_tokens against the per-minute limit, so a request is reserved before it is sent.

export class RequestTooLargeError extends Error {
  override name = "RequestTooLargeError";
}

/** A sliding one-minute budget of tokens, per model. A limit of 0 disables pacing. */
export class TokenRateLimiter {
  private readonly used = new Map<string, { at: number; tokens: number }[]>();

  constructor(
    private readonly limitPerMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get enabled(): boolean {
    return this.limitPerMinute > 0;
  }

  /** Waits until `tokens` fit in the last minute's budget for `model`, then records them. */
  async reserve(model: string, tokens: number): Promise<void> {
    if (!this.enabled) return;
    if (tokens > this.limitPerMinute) {
      throw new RequestTooLargeError(
        `request needs about ${tokens} tokens, but ${model} allows ${this.limitPerMinute} per minute; reduce the input or LLM output size`,
      );
    }
    const log = this.used.get(model) ?? [];
    this.used.set(model, log);
    for (;;) {
      const cutoff = this.now() - 60_000;
      while (log.length && log[0]!.at <= cutoff) log.shift();
      const inUse = log.reduce((n, e) => n + e.tokens, 0);
      if (inUse + tokens <= this.limitPerMinute) {
        log.push({ at: this.now(), tokens });
        return;
      }
      // Wait for the oldest reservation to leave the window, then check again.
      await this.sleep(log[0]!.at - cutoff + 50);
    }
  }
}
