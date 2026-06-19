/**
 * Module-home test (ADR 0028, #321). The ownership-split ripple (the scope-axis
 * re-weight, ADR 0020) lives in its own module, importing its seam from the
 * core. This asserts the move landed here (behaviour is covered by
 * historical-snapshot.test.ts).
 */
import { describe, expect, test } from "vitest";

import { recalculateSnapshotForOwnership } from "./historical-snapshot-ownership-ripple";

describe("historical-snapshot-ownership-ripple module", () => {
  test("exports recalculateSnapshotForOwnership", () => {
    expect(typeof recalculateSnapshotForOwnership).toBe("function");
  });
});
