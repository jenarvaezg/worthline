import { describe, expect, it } from "vitest";

import {
  assignedHoldingsValueMinor,
  goalFundedRatioBps,
  goalReservedMinor,
} from "./goals";
import type { ManualAsset, OwnershipShare } from "./workspace-types";

function asset(
  id: string,
  amountMinor: number,
  ownership: OwnershipShare[],
): ManualAsset {
  return {
    id,
    name: id,
    type: "cash",
    currency: "EUR",
    currentValue: { amountMinor, currency: "EUR" },
    liquidityTier: "cash",
    ownership,
    isPrimaryResidence: false,
  };
}

describe("goalReservedMinor", () => {
  it("reserves the assigned value when below target", () => {
    expect(goalReservedMinor(3_000_000, 2_280_000)).toBe(2_280_000);
  });

  it("caps at the target so a goal never reserves a surplus", () => {
    expect(goalReservedMinor(800_000, 1_500_000)).toBe(800_000);
  });

  it("floors at zero", () => {
    expect(goalReservedMinor(800_000, -50)).toBe(0);
  });
});

describe("goalFundedRatioBps", () => {
  it("is reserved / target in basis points", () => {
    expect(goalFundedRatioBps(3_000_000, 2_280_000)).toBe(7_600); // 76 %
  });

  it("caps at 100 % when assigned exceeds target", () => {
    expect(goalFundedRatioBps(8_000, 8_000)).toBe(10_000);
    expect(goalFundedRatioBps(8_000, 12_000)).toBe(10_000);
  });

  it("is zero for a non-positive target (avoids divide-by-zero)", () => {
    expect(goalFundedRatioBps(0, 5_000)).toBe(0);
  });
});

describe("assignedHoldingsValueMinor", () => {
  const a1 = asset("a1", 100_000, [{ memberId: "m1", shareBps: 10_000 }]);
  const a2 = asset("a2", 200_000, [
    { memberId: "m1", shareBps: 5_000 },
    { memberId: "m2", shareBps: 5_000 },
  ]);
  const byId = new Map([
    [a1.id, a1],
    [a2.id, a2],
  ]);

  it("sums each assigned holding's value allocated to the scope's members", () => {
    // scope {m1}: a1 fully (100 000) + a2 half (100 000) = 200 000
    expect(assignedHoldingsValueMinor(["a1", "a2"], byId, new Set(["m1"]))).toBe(200_000);
    // household {m1, m2}: a1 (100 000) + a2 fully (200 000) = 300 000
    expect(assignedHoldingsValueMinor(["a1", "a2"], byId, new Set(["m1", "m2"]))).toBe(
      300_000,
    );
  });

  it("skips missing/trashed asset ids", () => {
    expect(assignedHoldingsValueMinor(["a1", "ghost"], byId, new Set(["m1"]))).toBe(
      100_000,
    );
  });
});
