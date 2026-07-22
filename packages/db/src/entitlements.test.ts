import { describe, expect, it } from "vitest";

import {
  deriveEffectivePlan,
  TRIAL_DURATION_DAYS,
  trialEndsAtFrom,
  type WorkspaceEntitlement,
} from "./entitlements";

const NOW = "2026-07-22T12:00:00.000Z";

function row(
  overrides: Partial<Pick<WorkspaceEntitlement, "plan" | "premiumUntil" | "trialEndsAt">>,
): Pick<WorkspaceEntitlement, "plan" | "premiumUntil" | "trialEndsAt"> {
  return { plan: "free", premiumUntil: null, trialEndsAt: null, ...overrides };
}

describe("deriveEffectivePlan", () => {
  it("a missing row is free — the migration story for pre-#1161 workspaces", () => {
    expect(deriveEffectivePlan(null, NOW)).toBe("free");
  });

  it("a bare free row is free", () => {
    expect(deriveEffectivePlan(row({}), NOW)).toBe("free");
  });

  it("a live trial window is trial", () => {
    const e = row({ plan: "trial", trialEndsAt: "2026-07-23T12:00:00.000Z" });
    expect(deriveEffectivePlan(e, NOW)).toBe("trial");
  });

  it("an expired trial falls back to free — no expiry job, pure derivation", () => {
    const e = row({ plan: "trial", trialEndsAt: "2026-07-22T11:59:59.000Z" });
    expect(deriveEffectivePlan(e, NOW)).toBe("free");
  });

  it("the trial boundary instant itself is already free (strictly-after keeps premium)", () => {
    expect(deriveEffectivePlan(row({ plan: "trial", trialEndsAt: NOW }), NOW)).toBe(
      "free",
    );
  });

  it("an indefinite premium plan (manual lifetime/beta grant) is premium", () => {
    expect(deriveEffectivePlan(row({ plan: "premium" }), NOW)).toBe("premium");
  });

  it("a dated premium grant holds until its date…", () => {
    const e = row({ plan: "premium", premiumUntil: "2026-08-01T00:00:00.000Z" });
    expect(deriveEffectivePlan(e, NOW)).toBe("premium");
  });

  it("…and falls back to free after it", () => {
    const e = row({ plan: "premium", premiumUntil: "2026-07-01T00:00:00.000Z" });
    expect(deriveEffectivePlan(e, NOW)).toBe("free");
  });

  it("end-of-period after cancel: plan already flipped, the paid window still counts", () => {
    const e = row({ plan: "free", premiumUntil: "2026-08-01T00:00:00.000Z" });
    expect(deriveEffectivePlan(e, NOW)).toBe("premium");
  });

  it("a stale premiumUntil never blocks a live trial window", () => {
    const e = row({
      plan: "trial",
      premiumUntil: "2026-07-01T00:00:00.000Z",
      trialEndsAt: "2026-07-23T00:00:00.000Z",
    });
    expect(deriveEffectivePlan(e, NOW)).toBe("trial");
  });
});

describe("trialEndsAtFrom", () => {
  it(`closes exactly ${TRIAL_DURATION_DAYS} days after the start`, () => {
    expect(trialEndsAtFrom(NOW)).toBe("2026-07-25T12:00:00.000Z");
  });
});
