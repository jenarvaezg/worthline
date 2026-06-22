import { describe, expect, it } from "vitest";

import { parseFireConfigFormStrict } from "./fire";

/** A FIRE form with all required fields valid; override per test. */
function fireForm(overrides: Record<string, string> = {}): FormData {
  const base: Record<string, string> = {
    monthlySpending: "2000",
    safeWithdrawalRate: "4",
    expectedRealReturn: "7",
  };
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    form.set(key, value);
  }
  return form;
}

describe("parseFireConfigFormStrict — monthlySavingsCapacity (#425)", () => {
  it("parses a positive monthly savings capacity into minor units", () => {
    const result = parseFireConfigFormStrict(
      fireForm({ monthlySavingsCapacity: "1200" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.monthlySavingsCapacityMinor).toBe(120_000);
    }
  });

  it("accepts zero (you are simply not saving right now)", () => {
    const result = parseFireConfigFormStrict(fireForm({ monthlySavingsCapacity: "0" }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.monthlySavingsCapacityMinor).toBe(0);
    }
  });

  it("omits the field when left blank, so a suggestion can fill it later", () => {
    const result = parseFireConfigFormStrict(fireForm());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.monthlySavingsCapacityMinor).toBeUndefined();
    }
  });

  it("ignores garbage input instead of failing the whole config", () => {
    const result = parseFireConfigFormStrict(
      fireForm({ monthlySavingsCapacity: "no es un número" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.monthlySavingsCapacityMinor).toBeUndefined();
    }
  });
});
