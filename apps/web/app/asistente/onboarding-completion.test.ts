import { describe, expect, it } from "vitest";

import { shouldNotifyApplied } from "./onboarding-completion";

/**
 * The fire-once decision behind onboarding completion (#1169): the per-card hook
 * and the session-wide provider both stamp `onboarded_at` at most once, and only
 * on the `applied` transition. The effect wrapper is thin; this pins the logic.
 */
describe("shouldNotifyApplied (#1169)", () => {
  it("notifies on the first applied transition", () => {
    expect(shouldNotifyApplied("applied", false)).toBe(true);
  });

  it("never notifies twice for the same guard", () => {
    expect(shouldNotifyApplied("applied", true)).toBe(false);
  });

  it("stays silent for every non-applied status", () => {
    for (const status of ["discarded", "error", "blocked", undefined]) {
      expect(shouldNotifyApplied(status, false)).toBe(false);
    }
  });
});
