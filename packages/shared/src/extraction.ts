import { z } from "zod";
import { ExtractedMetric } from "./metrics";
import { ExtractedGuidance } from "./guidance";

export const ExtractionResult = z.object({
  metrics: z.array(ExtractedMetric),
  guidance: z.array(ExtractedGuidance),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;
