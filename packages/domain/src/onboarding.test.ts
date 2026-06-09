import { describe, expect, test } from "vitest";

import { deriveOnboardingProgress } from "./index";

describe("deriveOnboardingProgress", () => {
  test("marks steps done from counts, in a stable order", () => {
    const steps = deriveOnboardingProgress({
      activeMemberCount: 1,
      holdingCount: 0,
      positionCount: 0,
      hasFireConfig: false,
      snapshotCount: 0,
    });

    expect(steps.map((step) => step.id)).toEqual([
      "members",
      "holdings",
      "investments",
      "fire",
      "snapshot",
    ]);
    expect(steps.find((step) => step.id === "members")?.done).toBe(true);
    expect(steps.find((step) => step.id === "holdings")?.done).toBe(false);
  });

  test("every step is done once each collection is populated", () => {
    const steps = deriveOnboardingProgress({
      activeMemberCount: 2,
      holdingCount: 3,
      positionCount: 1,
      hasFireConfig: true,
      snapshotCount: 4,
    });

    expect(steps.every((step) => step.done)).toBe(true);
  });
});
