import type { DocumentStatus, EventStatus } from "@eia/shared";

const STAGE: Partial<Record<DocumentStatus, EventStatus>> = {
  ingested: "ingested",
  parsed: "parsed",
  extracted: "extracted",
};
const ORDER: EventStatus[] = ["discovered", "ingested", "parsed", "extracted"];

/**
 * Fix 9: an event's pipeline stage is the least-advanced stage among its live documents.
 * `unavailable` documents don't hold it back; any document needing review or failed pins the event there.
 * Returns null when documents can't move the event (it stays where it is, e.g. compared/briefed).
 */
export function eventStatusFromDocuments(statuses: DocumentStatus[]): EventStatus | null {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("needs_review")) return "needs_review";
  const stages = statuses.map((s) => STAGE[s]).filter((s): s is EventStatus => s !== undefined);
  if (stages.length === 0) return statuses.length === 0 ? "discovered" : null;
  return stages.reduce((min, s) => (ORDER.indexOf(s) < ORDER.indexOf(min) ? s : min));
}
