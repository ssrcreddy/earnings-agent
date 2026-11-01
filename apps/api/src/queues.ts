import type { PgBoss } from "pg-boss";
import type { EarningsForm } from "./sources/edgarParse";

// Queue names and payloads (§14). Every job carries its natural dedupe key as singletonKey.
export const Q = {
  discover: "discover",
  ingest: "ingest",
  parse: "parse",
  extract: "extract",
  compareAndBrief: "compare-and-brief",
  evalRun: "eval-run",
} as const;
export type QueueName = (typeof Q)[keyof typeof Q];

export interface DiscoverPayload {
  /** "nightly" scans everything; "window" no-ops unless a watched print is due (§9). */
  mode: "nightly" | "window" | "manual";
  tickers?: string[];
}

export interface EdgarDocumentRef {
  source: "edgar";
  cik: string;
  ticker: string;
  form: EarningsForm;
  accession: string;
  filingDate: string;
}

export interface IngestPayload {
  eventId: string;
  ref: EdgarDocumentRef;
}

export interface DocumentPayload {
  documentId: string;
}

export interface EventPayload {
  eventId: string;
}

/**
 * `stately` = at most one queued and one active job per singletonKey, so duplicate enqueues
 * collapse instead of double-processing (§14, §23).
 */
export async function createQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(Q.discover, { policy: "stately", retryLimit: 3, retryDelay: 60, retryBackoff: true });
  await boss.createQueue(Q.ingest, { policy: "stately", retryLimit: 5, retryDelay: 30, retryBackoff: true });
  await boss.createQueue(Q.parse, { policy: "stately", retryLimit: 3, retryDelay: 30 });
  await boss.createQueue(Q.extract, { policy: "stately", retryLimit: 2, retryDelay: 30 });
  await boss.createQueue(Q.compareAndBrief, { policy: "stately", retryLimit: 3, retryDelay: 30 });
  await boss.createQueue(Q.evalRun, { policy: "stately", retryLimit: 0 });
}
