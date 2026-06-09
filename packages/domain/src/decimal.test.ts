import { describe, expect, test } from "vitest";

import {
  addUnits,
  averageUnitCost,
  compareUnits,
  multiplyToMinor,
  proportionMinor,
  subtractUnits,
} from "./decimal";

describe("decimal units arithmetic", () => {
  test("adds and subtracts fractional units without float drift", () => {
    expect(addUnits("0.1", "0.2")).toBe("0.3");
    expect(subtractUnits("1.5", "0.7")).toBe("0.8");
    expect(addUnits("0.00000001", "0.00000002")).toBe("0.00000003");
  });

  test("compares units as -1, 0, 1", () => {
    expect(compareUnits("1.5", "2")).toBe(-1);
    expect(compareUnits("2", "2")).toBe(0);
    expect(compareUnits("3", "2")).toBe(1);
  });
});

describe("decimal to integer minor units", () => {
  test("multiplies units by price into minor units, rounding half up", () => {
    expect(multiplyToMinor("10", "12.34")).toBe(12_340); // 123.40 EUR
    expect(multiplyToMinor("1.5", "100")).toBe(15_000); // 150.00 EUR
    expect(multiplyToMinor("0.123456", "100")).toBe(1_235); // 12.3456 EUR -> 12.35
  });

  test("removes a proportional slice of a minor total, half up, guarding zero whole", () => {
    expect(proportionMinor(10_000, "1", "4")).toBe(2_500); // 100.00 * 1/4
    expect(proportionMinor(10_000, "1", "3")).toBe(3_333); // 33.333 -> 33.33
    expect(proportionMinor(5_000, "1", "0")).toBe(0);
  });

  test("expresses cost basis per unit as a currency decimal", () => {
    expect(averageUnitCost(30_000, "2")).toBe("150"); // 300.00 / 2
    expect(averageUnitCost(10_000, "3")).toBe("33.3333"); // 100 / 3 at 4dp
    expect(averageUnitCost(0, "0")).toBe("0");
  });
});
