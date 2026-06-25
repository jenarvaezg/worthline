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

describe("parseFireConfigFormStrict — leanMultiplier/fatMultiplier (#513)", () => {
  it("blank inputs leave multipliers undefined (defaults used)", () => {
    const result = parseFireConfigFormStrict(fireForm());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.leanMultiplier).toBeUndefined();
      expect(result.command.fatMultiplier).toBeUndefined();
    }
  });

  it("parses valid lean/fat pair", () => {
    const result = parseFireConfigFormStrict(
      fireForm({ leanMultiplier: "0.6", fatMultiplier: "2.0" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.leanMultiplier).toBeCloseTo(0.6);
      expect(result.command.fatMultiplier).toBeCloseTo(2.0);
    }
  });

  it("rejects lean >= fat (out-of-order)", () => {
    const result = parseFireConfigFormStrict(
      fireForm({ leanMultiplier: "2.0", fatMultiplier: "0.5" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Lean.*Fat|Fat.*Lean/i);
    }
  });

  it("rejects lean == fat", () => {
    const result = parseFireConfigFormStrict(
      fireForm({ leanMultiplier: "1.0", fatMultiplier: "1.0" }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects fat > 10 (unreasonable)", () => {
    const result = parseFireConfigFormStrict(
      fireForm({ leanMultiplier: "0.7", fatMultiplier: "11" }),
    );
    expect(result.ok).toBe(false);
  });

  it("garbage lean input → treated as absent, fat alone triggers validation with default lean", () => {
    // fat=0.5 with lean defaulting to 0.7 → 0.5 < 0.7, so lean >= fat → error
    const result = parseFireConfigFormStrict(
      fireForm({ leanMultiplier: "not-a-number", fatMultiplier: "0.5" }),
    );
    expect(result.ok).toBe(false);
  });
});
