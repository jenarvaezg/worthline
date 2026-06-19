/**
 * Module-home test (ADR 0028, #320). The operation-ripple recalc lives in its
 * own module, importing its seam from the core. This asserts the move landed
 * here (the byte-for-byte behaviour is covered by historical-snapshot.test.ts).
 */
import { describe, expect, test } from "vitest";

import { recalculateSnapshotForAsset } from "./historical-snapshot-operation-ripple";

describe("historical-snapshot-operation-ripple module", () => {
  test("exports recalculateSnapshotForAsset", () => {
    expect(typeof recalculateSnapshotForAsset).toBe("function");
  });
});
