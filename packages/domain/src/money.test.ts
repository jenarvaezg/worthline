import { describe, expect, test } from "vitest";

import {
  addMoney,
  allocateByBps,
  assertMinorInteger,
  formatMoneyInput,
  formatMoneyMinor,
  money,
  moneySign,
  parseDecimal,
  parseDecimalStrict,
  parseDecimalToMinor,
  parseDecimalToMinorStrict,
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

describe("parseDecimalStrict and parseDecimalToMinorStrict", () => {
  test("parseDecimalStrict returns null for unparseable input", () => {
    expect(parseDecimalStrict("abc")).toBeNull();
    expect(parseDecimalStrict("1,2,3")).toBeNull();
    expect(parseDecimalStrict("")).toBeNull();
  });

  test("parseDecimalStrict parses valid es-ES and plain decimals", () => {
    expect(parseDecimalStrict("1.234,56")).toBeCloseTo(1234.56, 5);
    expect(parseDecimalStrict("0")).toBe(0);
  });

  test("parseDecimalToMinorStrict returns null for invalid input", () => {
    expect(parseDecimalToMinorStrict("abc")).toBeNull();
  });

  test("parseDecimalToMinorStrict converts valid input to integer minor units", () => {
    expect(parseDecimalToMinorStrict("1.234,56")).toBe(123_456);
  });
});

describe("moneySign", () => {
  test("classifies positive, negative, and zero amounts", () => {
    expect(moneySign(money(1, "EUR"))).toBe("pos");
    expect(moneySign(money(12_345, "EUR"))).toBe("pos");
    expect(moneySign(money(-1, "EUR"))).toBe("neg");
    expect(moneySign(money(0, "EUR"))).toBe("zero");
  });
});

describe("negative amount parsing", () => {
  test("parseDecimal handles negative es-ES input", () => {
    expect(parseDecimal("-1.234,56")).toBeCloseTo(-1234.56, 5);
    expect(parseDecimal("-100")).toBeCloseTo(-100, 5);
  });

  test("parseDecimalStrict handles negative input", () => {
    expect(parseDecimalStrict("-1.234,56")).toBeCloseTo(-1234.56, 5);
    expect(parseDecimalStrict("-100")).toBe(-100);
    expect(parseDecimalStrict("-0.5")).toBe(-0.5);
  });

  test("parseDecimalToMinorStrict handles negative input", () => {
    expect(parseDecimalToMinorStrict("-100")).toBe(-10_000);
    expect(parseDecimalToMinorStrict("-1.234,56")).toBe(-123_456);
  });

  test("formatMoneyInput handles negative amounts", () => {
    expect(formatMoneyInput(-10_000)).toBe("-100,00");
    expect(formatMoneyInput(-123_456)).toBe("-1234,56");
  });
});

describe("dot-only ambiguity in es-ES parsing", () => {
  test("parseDecimal treats '1.234' (no comma) as 1.234, not 1234", () => {
    // Without a comma, dots are NOT treated as thousands separators.
    // "1.234" is parsed as the plain decimal 1.234.
    expect(parseDecimal("1.234")).toBeCloseTo(1.234, 5);
  });

  test("parseDecimal treats '1.234.567' (no comma) as NaN → 0", () => {
    // Multiple dots without comma produce an invalid Number → 0.
    expect(parseDecimal("1.234.567")).toBe(0);
  });

  test("parseDecimalStrict rejects '1.234' with no comma as plain decimal", () => {
    // The strict parser normalises only when comma is present.
    // "1.234" without comma passes the regex as a plain decimal.
    expect(parseDecimalStrict("1.234")).toBeCloseTo(1.234, 5);
  });
});
