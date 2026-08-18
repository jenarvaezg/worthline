import { describe, expect, it } from "vitest";
import type { FireScopeConfig } from "./fire";
import { monthlySavingsCapacityForFire } from "./fire-savings-capacity";

function config(overrides: Partial<FireScopeConfig> = {}): FireScopeConfig {
  return { monthlySpendingMinor: 2_000_00, safeWithdrawalRate: 0.04, ...overrides };
}

describe("monthlySavingsCapacityForFire", () => {
  it("returns the declared scalar", () => {
    expect(
      monthlySavingsCapacityForFire(config({ monthlySavingsCapacityMinor: 150_000 })),
    ).toBe(150_000);
  });

  it("reads an explicit zero as zero, not as absent", () => {
    expect(
      monthlySavingsCapacityForFire(config({ monthlySavingsCapacityMinor: 0 })),
    ).toBe(0);
  });

  it("reads an unset capacity as zero", () => {
    expect(monthlySavingsCapacityForFire(config())).toBe(0);
  });

  it("refuses a negative declaration instead of projecting a shrinking pot", () => {
    expect(
      monthlySavingsCapacityForFire(config({ monthlySavingsCapacityMinor: -100_000 })),
    ).toBe(0);
  });
});
