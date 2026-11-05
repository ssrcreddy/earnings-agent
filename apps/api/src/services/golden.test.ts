import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoldenStore, type GoldenGuidance } from "./golden";

const source = { type: "press_release", sourceUrl: "https://example.com/r.htm", rawPath: "VST/x/r.htm", bytes: Buffer.from("<html/>") };
const guide = (over: Partial<GoldenGuidance>): GoldenGuidance => ({
  metric: "fcf",
  kind: "range",
  low: 1,
  high: 2,
  targetPeriod: "2026-FY",
  quote: "a quote from the release",
  modelLow: null,
  modelHigh: null,
  documentType: "press_release",
  correctedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

describe("GoldenStore", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "eia-golden-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps a guide's hand-checked label and previous guide when a correction updates it", async () => {
    // Regression: a review correction replaced the entry whole, dropping expectedChange, so the eval
    // silently stopped gating that case.
    const store = new GoldenStore(root);
    const previous = { low: 1, high: 2, kind: "range" };
    await store.record("VST", "2026-Q2", source, { guidance: guide({ previous, expectedChange: "maintained" }) });
    await store.record("VST", "2026-Q2", source, { guidance: guide({ quote: "the reviewer's quote", modelLow: 9 }) });

    const { guidance } = await store.read("VST", "2026-Q2");
    expect(guidance).toHaveLength(1);
    expect(guidance[0]).toMatchObject({ quote: "the reviewer's quote", modelLow: 9, previous, expectedChange: "maintained" });
  });

  it("copies the source document once", async () => {
    const store = new GoldenStore(root);
    await store.record("VST", "2026-Q2", source, { guidance: guide({}) });
    await store.record("VST", "2026-Q2", source, { guidance: guide({ metric: "revenue" }) });
    const golden = await store.read("VST", "2026-Q2");
    expect(golden.documents).toHaveLength(1);
    expect(golden.guidance).toHaveLength(2);
  });
});
