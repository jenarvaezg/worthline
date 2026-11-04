import { describe, expect, it } from "vitest";

import {
  addDecimals,
  canonicalDecimal,
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
  roundDecimal,
  subtractDecimal,
} from "./decimal";

describe("roundDecimal", () => {
  it("rounds half away from zero to the given decimals", () => {
    expect(roundDecimal("7.835", 2)).toBe("7.84");
    expect(roundDecimal("-7.835", 2)).toBe("-7.84");
    expect(roundDecimal("7.834", 2)).toBe("7.83");
    expect(roundDecimal("9", 3)).toBe("9");
    expect(roundDecimal("0.3", 0)).toBe("0");
  });
});

describe("divideDecimal", () => {
  it("divides to the given decimals, rounding the last one", () => {
    expect(divideDecimal("10", "3", 3)).toBe("3.333");
    expect(divideDecimal("2", "3", 2)).toBe("0.67");
    expect(divideDecimal("-1", "8", 2)).toBe("-0.13");
    expect(divideDecimal("163.41", "22.0613", 3)).toBe("7.407");
  });

  it("refuses to divide by zero", () => {
    expect(() => divideDecimal("1", "0", 2)).toThrow(/cero/);
  });
});

describe("subtractDecimal and compareDecimal", () => {
  it("subtract exactly and compare by value", () => {
    expect(subtractDecimal("10", "2.25")).toBe("7.75");
    expect(compareDecimal("1.50", "1.5")).toBe(0);
    expect(compareDecimal("-1", "0.001")).toBe(-1);
    expect(compareDecimal("2", "1.999")).toBe(1);
  });
});

describe("canonicalDecimal", () => {
  it("drops trailing zeros and a bare point", () => {
    expect(canonicalDecimal("318.4000")).toBe("318.4");
    expect(canonicalDecimal("0.50")).toBe("0.5");
    expect(canonicalDecimal("007.10")).toBe("7.1");
  });

  it("has a single zero, without sign", () => {
    expect(canonicalDecimal("-0.000")).toBe("0");
    expect(canonicalDecimal("0")).toBe("0");
  });

  it("keeps the sign of a negative value", () => {
    expect(canonicalDecimal("-3.500")).toBe("-3.5");
  });

  it("refuses what is not a plain decimal literal", () => {
    expect(() => canonicalDecimal("1e-7")).toThrow(/decimal/);
    expect(() => canonicalDecimal("abc")).toThrow(/decimal/);
  });
});

describe("multiplyDecimal", () => {
  it("is exact, with no binary floating point", () => {
    expect(multiplyDecimal("0.1", "3")).toBe("0.3");
    expect(multiplyDecimal("208.0000", "1.234")).toBe("256.672");
    expect(multiplyDecimal("6.183", "0.917")).toBe("5.669811");
  });

  it("handles signs and zero", () => {
    expect(multiplyDecimal("-3.5", "2")).toBe("-7");
    expect(multiplyDecimal("0", "1.5")).toBe("0");
  });
});

describe("addDecimals", () => {
  it("sums exactly", () => {
    expect(addDecimals(["0.1", "0.2"])).toBe("0.3");
    expect(addDecimals(["10", "-2.25", "0.005"])).toBe("7.755");
  });

  it("adds nothing to zero", () => {
    expect(addDecimals([])).toBe("0");
  });

  it("keeps a sum of scaled values equal to the scaled sum", () => {
    const parts = ["318.427", "6.183", "0.001"];
    const factor = "1.337";
    expect(addDecimals(parts.map((part) => multiplyDecimal(part, factor)))).toBe(
      multiplyDecimal(addDecimals(parts), factor),
    );
  });
});
