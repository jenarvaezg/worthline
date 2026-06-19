/**
 * Module-home test (ADR 0028, #320). The position-revalue ripples (coin
 * acquisition + connected value) live in their own module, importing their seam
 * from the core. This asserts the move landed here (behaviour is covered by
 * historical-snapshot.test.ts).
 */
import { describe, expect, test } from "vitest";

import {
  recalculateSnapshotForCoinAcquisition,
  recalculateSnapshotForConnectedValue,
} from "./historical-snapshot-position-ripple";

describe("historical-snapshot-position-ripple module", () => {
  test("exports recalculateSnapshotForCoinAcquisition", () => {
    expect(typeof recalculateSnapshotForCoinAcquisition).toBe("function");
  });

  test("exports recalculateSnapshotForConnectedValue", () => {
    expect(typeof recalculateSnapshotForConnectedValue).toBe("function");
  });
});
