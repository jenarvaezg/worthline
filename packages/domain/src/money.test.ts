import { describe, expect, test } from "vitest";

import {
  addMoney,
  allocateByBps,
  assertMinorInteger,
  formatMoneyInput,
  formatMoneyMinor,
  money,
  parseDecimal,
  parseDecimalToMinor,
  subtractMoney,
} from "./money";

describe("money construction and assertions", () => {
  test("money wraps an integer minor amount with its currency", () => {
    expect(money(123_456, "EUR")).toEqual({ amountMinor: 123_456, currency: "EUR" });
  });

  test("assertMinorInteger rejects non-integer minor units", () => {
    expect(() => assertMinorInteger(10.5)).toThrow("integer minor units");
    expect(() => assertMinorInteger(10)).not.toThrow();
  });
});

describe("currency-guarded arithmetic", () => {
  test("addMoney sums amounts in the same currency", () => {
    expect(addMoney(money(10, "EUR"), money(20, "EUR"))).toEqual(money(30, "EUR"));
  });

  test("subtractMoney subtracts amounts in the same currency", () => {
    expect(subtractMoney(money(50, "EUR"), money(20, "EUR"))).toEqual(money(30, "EUR"));
  });

  test("addMoney throws on currency mismatch", () => {
    expect(() => addMoney(money(10, "EUR"), money(20, "USD"))).toThrow(
      "different currencies",
    );
  });

  test("subtractMoney throws on currency mismatch", () => {
    expect(() => subtractMoney(money(10, "EUR"), money(20, "USD"))).toThrow(
      "different currencies",
    );
  });
});

describe("allocateByBps half-up rounding", () => {
  test("a full 10000 bps share returns the whole amount", () => {
    expect(allocateByBps(123_456, 10_000)).toBe(123_456);
    expect(allocateByBps(1, 10_000)).toBe(1);
  });

  test("rounds half up at the boundary", () => {
    expect(allocateByBps(1, 5_000)).toBe(1); // 0.5 -> 1
    expect(allocateByBps(1, 4_999)).toBe(0); // 0.4999 -> 0
    expect(allocateByBps(1, 5_001)).toBe(1); // 0.5001 -> 1
  });

  test("does not drift on large integer minor units", () => {
    expect(allocateByBps(30_000_000, 5_000)).toBe(15_000_000);
  });

  test("a zero share allocates nothing", () => {
    expect(allocateByBps(123_456, 0)).toBe(0);
    expect(allocateByBps(0, 5_000)).toBe(0);
  });

  // The domain only ever allocates non-negative asset values and liability
  // balances, but the BigInt arithmetic is total. Rounding is half up toward
  // positive infinity for every sign, and a full 10000 bps share must always
  // round-trip the whole amount — including negatives.
  test("rounds negative amounts half up toward positive infinity", () => {
    expect(allocateByBps(-1, 5_000)).toBe(0); // -0.5 -> 0
    expect(allocateByBps(-3, 5_000)).toBe(-1); // -1.5 -> -1
    expect(allocateByBps(-1, 5_001)).toBe(-1); // -0.5001 -> -1
  });

  test("a full share round-trips the whole amount for any sign", () => {
    expect(allocateByBps(-123_456, 10_000)).toBe(-123_456);
    expect(allocateByBps(-1, 10_000)).toBe(-1);
  });
});

describe("es-ES localized parsing and formatting", () => {
  test("parseDecimal reads Spanish thousands and decimal separators", () => {
    expect(parseDecimal("1.234,56")).toBeCloseTo(1234.56, 5);
    expect(parseDecimal("1234.56")).toBeCloseTo(1234.56, 5);
    expect(parseDecimal("")).toBe(0);
    expect(parseDecimal("nope")).toBe(0);
  });

  test("parseDecimalToMinor converts a localized amount to integer minor units", () => {
    expect(parseDecimalToMinor("1.234,56")).toBe(123_456);
    expect(parseDecimalToMinor("0")).toBe(0);
  });

  test("parse and formatMoneyInput round-trip through minor units", () => {
    const minor = parseDecimalToMinor("1.234,56");
    expect(formatMoneyInput(minor)).toBe("1234,56");
    expect(parseDecimalToMinor(formatMoneyInput(minor))).toBe(minor);
  });

  test("formatMoneyMinor renders euros with no decimal cents", () => {
    expect(formatMoneyMinor(money(100_000, "EUR"))).toContain("1000");
    // 1234.56 rounds to whole euros: no comma cents are shown.
    const rounded = formatMoneyMinor(money(123_456, "EUR"));
    expect(rounded).toContain("€");
    expect(rounded).not.toContain(",");
    expect(rounded).not.toContain("34");
  });
});
