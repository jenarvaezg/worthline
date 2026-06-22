import { describe, expect, it } from "vitest";

import { goalFundedRatioBps, goalReservedMinor } from "./goals";

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
