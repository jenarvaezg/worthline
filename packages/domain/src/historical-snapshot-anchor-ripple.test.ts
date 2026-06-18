/**
 * Module-home test (ADR 0028, #321). The anchor ripples (housing valuation
 * anchors + liability balance anchors / amortization plans) live in their own
 * module, importing their seam from the core. This asserts the move landed here
 * (the byte-for-byte behaviour is covered by historical-snapshot.test.ts).
 */
import { describe, expect, test } from "vitest";

import {
  recalculateSnapshotForHousing,
  recalculateSnapshotForLiability,
} from "./historical-snapshot-anchor-ripple";

describe("historical-snapshot-anchor-ripple module", () => {
  test("exports recalculateSnapshotForHousing", () => {
    expect(typeof recalculateSnapshotForHousing).toBe("function");
  });

  test("exports recalculateSnapshotForLiability", () => {
    expect(typeof recalculateSnapshotForLiability).toBe("function");
  });
});
