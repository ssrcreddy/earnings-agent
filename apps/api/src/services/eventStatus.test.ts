import { describe, expect, it } from "vitest";
import { eventStatusFromDocuments } from "./eventStatus";

describe("eventStatusFromDocuments", () => {
  it("is discovered with no documents yet", () => {
    expect(eventStatusFromDocuments([])).toBe("discovered");
  });

  it("follows the least-advanced document", () => {
    expect(eventStatusFromDocuments(["parsed", "ingested"])).toBe("ingested");
    expect(eventStatusFromDocuments(["extracted", "parsed"])).toBe("parsed");
    expect(eventStatusFromDocuments(["extracted", "extracted"])).toBe("extracted");
  });

  it("ignores documents marked unavailable", () => {
    expect(eventStatusFromDocuments(["extracted", "unavailable"])).toBe("extracted");
  });

  it("pins the event on review or failure", () => {
    expect(eventStatusFromDocuments(["extracted", "needs_review"])).toBe("needs_review");
    expect(eventStatusFromDocuments(["needs_review", "failed"])).toBe("failed");
  });

  it("cannot advance when every document is unavailable", () => {
    expect(eventStatusFromDocuments(["unavailable"])).toBeNull();
  });
});
