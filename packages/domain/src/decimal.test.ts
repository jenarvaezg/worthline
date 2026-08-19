import { describe, expect, test } from "vitest";

import {
  addUnits,
  averageUnitCost,
  compareUnits,
  formatPrice,
  formatUnits,
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

describe("reading voices", () => {
  test("formatUnits uses es-ES separators at six decimals", () => {
    expect(formatUnits("3.409963")).toBe("3,409963");
    expect(formatUnits("6")).toBe("6");
  });

  test("formatPrice uses es-ES separators at eight decimals, with no padding (#1467)", () => {
    expect(formatPrice("52.09166666666666667")).toBe("52,09166667");
    expect(formatPrice("65.045")).toBe("65,045");
    expect(formatPrice("6")).toBe("6");
  });

  test("a malformed figure is shown raw rather than as NaN", () => {
    expect(formatUnits("nope")).toBe("nope");
    expect(formatPrice("nope")).toBe("nope");
  });
});

describe("exact .5 rounding boundary", () => {
  test("multiplyToMinor rounds exact .5 up (not down or even)", () => {
    // 0.5 * 1 * 100 = 50 exactly — half-up must give 50
    // But the interesting case is when the minor result sits on .5:
    // 1 * 0.005 * 100 = 0.5 → round half-up → 1
    expect(multiplyToMinor("1", "0.005")).toBe(1);
    // 3 * 0.005 * 100 = 1.5 → round half-up → 2
    expect(multiplyToMinor("3", "0.005")).toBe(2);
    // 1 * 0.015 * 100 = 1.5 → round half-up → 2
    expect(multiplyToMinor("1", "0.015")).toBe(2);
  });

  test("proportionMinor rounds exact .5 up", () => {
    // 5 * 1 / 2 = 2.5 → round half-up → 3
    expect(proportionMinor(5, "1", "2")).toBe(3);
    // 15 * 1 / 2 = 7.5 → round half-up → 8
    expect(proportionMinor(15, "1", "2")).toBe(8);
    // 1 * 1 / 2 = 0.5 → round half-up → 1
    expect(proportionMinor(1, "1", "2")).toBe(1);
  });
});
