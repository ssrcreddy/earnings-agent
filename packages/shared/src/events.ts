import { z } from "zod";

export const EventStatus = z.enum([
  "discovered",
  "ingested",
  "parsed",
  "extracted",
  "compared",
  "briefed",
  "needs_review",
  "failed",
]);
export type EventStatus = z.infer<typeof EventStatus>;

export const DocumentType = z.enum(["press_release", "filing_10q", "filing_10k", "transcript"]);
export type DocumentType = z.infer<typeof DocumentType>;

// Fix 9: per-document progress; the event advances only when every expected document has.
export const DocumentStatus = z.enum([
  "ingested",
  "parsed",
  "extracted",
  "unavailable",
  "needs_review",
  "failed",
]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const ChunkSection = z.enum([
  "headline_table",
  "release_body",
  "mda",
  "risk",
  "prepared_remarks",
  "qa",
  "other",
]);
export type ChunkSection = z.infer<typeof ChunkSection>;
