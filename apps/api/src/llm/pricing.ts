// One price table for cost logging (§9, §23). USD per 1M tokens.
// Chat-model prices change and depend on which models you pick, so they come from config
// (LLM_PRICES_JSON) rather than being hard-coded here; an unpriced model logs cost 0 with a warning.

export interface ModelPrice {
  inputPerM: number;
  cachedInputPerM?: number;
  outputPerM: number;
}

const BUILT_IN: Record<string, ModelPrice> = {
  "text-embedding-3-small": { inputPerM: 0.02, outputPerM: 0 },
  "text-embedding-3-large": { inputPerM: 0.13, outputPerM: 0 },
};

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export class PriceTable {
  private readonly prices: Record<string, ModelPrice>;

  constructor(overridesJson = "") {
    const overrides = overridesJson.trim() ? (JSON.parse(overridesJson) as Record<string, ModelPrice>) : {};
    this.prices = { ...BUILT_IN, ...overrides };
  }

  has(model: string): boolean {
    return model in this.prices;
  }

  cost(model: string, u: Usage): number {
    const p = this.prices[model];
    if (!p) return 0;
    const cached = Math.min(u.cachedInputTokens, u.inputTokens);
    const uncached = u.inputTokens - cached;
    return (
      (uncached * p.inputPerM + cached * (p.cachedInputPerM ?? p.inputPerM) + u.outputTokens * p.outputPerM) / 1_000_000
    );
  }
}
