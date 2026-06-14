import { describe, expect, test } from "vitest";

import { deriveOnboardingProgress } from "./index";

describe("deriveOnboardingProgress", () => {
  test("collapses add into a single holdings step, in a stable order", () => {
    const steps = deriveOnboardingProgress({
      activeMemberCount: 1,
      holdingCount: 0,
      hasFireConfig: false,
      snapshotCount: 0,
    });

    expect(steps.map((step) => step.id)).toEqual([
      "members",
      "holdings",
      "fire",
      "snapshot",
    ]);
    expect(steps.find((step) => step.id === "members")?.done).toBe(true);
    expect(steps.find((step) => step.id === "holdings")?.done).toBe(false);
    expect(steps.find((step) => step.id === "holdings")?.label).toBe(
      "Añade tu primer holding",
    );
  });

  test("the single holdings step is done as soon as any holding exists", () => {
    const steps = deriveOnboardingProgress({
      activeMemberCount: 2,
      holdingCount: 3,
      hasFireConfig: true,
      snapshotCount: 4,
    });

    expect(steps.every((step) => step.done)).toBe(true);
  });
});
