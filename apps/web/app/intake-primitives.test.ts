import type { Member } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  formatDecimalAsPercentField,
  ISO_DATE,
  normalizeDecimalString,
  normalizeNonNegativeDecimalString,
  parseIsoDateField,
  parseMoneyMinor,
  parsePercentToDecimal,
  resolveOwnershipSplit,
} from "./intake-primitives";

describe("parseIsoDateField", () => {
  const TODAY = "2026-06-12";

  test("accepts a well-formed ISO date with the future guard off", () => {
    expect(
      parseIsoDateField("2024-01-01", {
        invalidMessage: "mala",
        rejectFuture: false,
      }),
    ).toEqual({ ok: true, date: "2024-01-01" });
  });

  test("accepts a well-formed past ISO date with the future guard on", () => {
    expect(
      parseIsoDateField("2024-01-01", {
        invalidMessage: "mala",
        rejectFuture: true,
        today: TODAY,
        futureMessage: "futura",
      }),
    ).toEqual({ ok: true, date: "2024-01-01" });
  });

  test("accepts today's date as non-future when the guard is on", () => {
    expect(
      parseIsoDateField(TODAY, {
        invalidMessage: "mala",
        rejectFuture: true,
        today: TODAY,
        futureMessage: "futura",
      }),
    ).toEqual({ ok: true, date: TODAY });
  });

  test("rejects a malformed date with the caller's invalid message", () => {
    expect(
      parseIsoDateField("01/01/2024", {
        invalidMessage: "La fecha no es válida.",
        rejectFuture: false,
      }),
    ).toEqual({ ok: false, error: "La fecha no es válida." });
  });

  test("rejects a future date with the caller's future message when the guard is on", () => {
    expect(
      parseIsoDateField("2026-12-31", {
        invalidMessage: "mala",
        rejectFuture: true,
        today: TODAY,
        futureMessage: "La fecha no puede ser futura.",
      }),
    ).toEqual({ ok: false, error: "La fecha no puede ser futura." });
  });

  test("permits a future date when the guard is off", () => {
    expect(
      parseIsoDateField("2099-12-31", {
        invalidMessage: "mala",
        rejectFuture: false,
      }),
    ).toEqual({ ok: true, date: "2099-12-31" });
  });

  test("ISO_DATE matches only YYYY-MM-DD", () => {
    expect(ISO_DATE.test("2024-01-01")).toBe(true);
    expect(ISO_DATE.test("2024-1-1")).toBe(false);
    expect(ISO_DATE.test("01/01/2024")).toBe(false);
    expect(ISO_DATE.test("")).toBe(false);
  });
});

describe("parsePercentToDecimal", () => {
  test("converts a whole percent to a clean decimal string", () => {
    expect(parsePercentToDecimal("3")).toBe("0.03");
  });

  test("converts a fractional es-ES percent to a clean decimal string", () => {
    expect(parsePercentToDecimal("2,5")).toBe("0.025");
  });

  test("returns null for a blank value", () => {
    expect(parsePercentToDecimal("")).toBeNull();
    expect(parsePercentToDecimal("   ")).toBeNull();
  });

  test("returns null for a non-numeric value", () => {
    expect(parsePercentToDecimal("abc")).toBeNull();
  });

  test("returns null for a negative value", () => {
    expect(parsePercentToDecimal("-1")).toBeNull();
  });

  test("trims surrounding whitespace before parsing", () => {
    expect(parsePercentToDecimal("  3  ")).toBe("0.03");
  });

  test("normalizes zero to a clean string", () => {
    expect(parsePercentToDecimal("0")).toBe("0");
  });
});

describe("formatDecimalAsPercentField", () => {
  test("renders a stored fraction as a clean percent, free of float dust", () => {
    // 0.07 * 100 is 7.000000000000001 in binary float — the dust must never
    // reach the form field (the bug this helper fixes).
    expect(formatDecimalAsPercentField(0.07)).toBe("7");
    expect(formatDecimalAsPercentField(0.04)).toBe("4");
  });

  test("keeps a legitimate fractional rate intact", () => {
    expect(formatDecimalAsPercentField(0.035)).toBe("3.5");
    expect(formatDecimalAsPercentField(0.0425)).toBe("4.25");
  });

  test("renders zero as a clean string", () => {
    expect(formatDecimalAsPercentField(0)).toBe("0");
  });

  test("round-trips with parsePercentToDecimal", () => {
    const stored = parsePercentToDecimal("7");
    expect(stored).toBe("0.07");
    expect(formatDecimalAsPercentField(Number(stored))).toBe("7");
  });
});

describe("parseMoneyMinor", () => {
  test("parses a plain amount to minor units", () => {
    expect(parseMoneyMinor("1500")).toBe(150_000);
  });

  test("parses an es-ES amount with thousands and decimal separators", () => {
    expect(parseMoneyMinor("1.234,56")).toBe(123_456);
    expect(parseMoneyMinor("120.000,50")).toBe(120_000_50);
  });

  test("returns null for blank or unparseable input", () => {
    expect(parseMoneyMinor("")).toBeNull();
    expect(parseMoneyMinor("abc")).toBeNull();
  });
});

describe("normalizeDecimalString", () => {
  test("normalizes an es-ES decimal to a canonical decimal string", () => {
    expect(
      normalizeDecimalString("1.234,56", { allowNegative: true, fallback: "0" }),
    ).toBe("1234.56");
    expect(normalizeDecimalString("2,5", { allowNegative: false, fallback: "0" })).toBe(
      "2.5",
    );
  });

  test("passes through a plain decimal unchanged", () => {
    expect(normalizeDecimalString("100", { allowNegative: true, fallback: "0" })).toBe(
      "100",
    );
  });

  test("returns the fallback for non-numeric input", () => {
    expect(normalizeDecimalString("abc", { allowNegative: true, fallback: "0" })).toBe(
      "0",
    );
  });

  test("honors a leading minus only when allowNegative is true", () => {
    expect(normalizeDecimalString("-5", { allowNegative: true, fallback: "0" })).toBe(
      "-5",
    );
    expect(normalizeDecimalString("-5", { allowNegative: false, fallback: "0" })).toBe(
      "0",
    );
  });
});

describe("normalizeNonNegativeDecimalString", () => {
  test("preserves entered precision for a valid es-ES decimal", () => {
    expect(normalizeNonNegativeDecimalString("12,50")).toBe("12.50");
    expect(normalizeNonNegativeDecimalString("15,00")).toBe("15.00");
    expect(normalizeNonNegativeDecimalString("10")).toBe("10");
  });

  test("returns null for non-numeric input", () => {
    expect(normalizeNonNegativeDecimalString("abc")).toBeNull();
  });

  test("returns null for a negative value", () => {
    expect(normalizeNonNegativeDecimalString("-5")).toBeNull();
  });

  test("normalizes a value of zero to the string '0'", () => {
    expect(normalizeNonNegativeDecimalString("0")).toBe("0");
  });
});

describe("resolveOwnershipSplit — explicit shortfall completion", () => {
  const ana: Member = { id: "member_ana", name: "Ana" };
  const jose: Member = { id: "member_jose", name: "Jose" };
  const total = (shares: { shareBps: number }[]) =>
    shares.reduce((sum, share) => sum + share.shareBps, 0);

  test("complete-to-full-ownership auto-distributes the remainder to unset members", () => {
    const split = resolveOwnershipSplit({
      activeMembers: [ana, jose],
      preset: "custom",
      customBps: { member_ana: 3_000 },
      shortfall: "complete-to-full-ownership",
    });
    expect(total(split)).toBe(10_000);
    expect(split.find((s) => s.memberId === "member_jose")?.shareBps).toBe(7_000);
  });

  test("leave-as-entered preserves an explicit split below 100%", () => {
    const split = resolveOwnershipSplit({
      activeMembers: [ana, jose],
      preset: "custom",
      customBps: { member_ana: 3_000 },
      shortfall: "leave-as-entered",
    });
    expect(split).toEqual([{ memberId: "member_ana", shareBps: 3_000 }]);
  });

  test("a single active member always owns 100% (shortfall irrelevant)", () => {
    expect(
      resolveOwnershipSplit({
        activeMembers: [jose],
        preset: "even",
        shortfall: "leave-as-entered",
      }),
    ).toEqual([{ memberId: "member_jose", shareBps: 10_000 }]);
  });

  test("the even preset splits equally regardless of shortfall choice", () => {
    expect(
      resolveOwnershipSplit({
        activeMembers: [ana, jose],
        preset: "even",
        shortfall: "complete-to-full-ownership",
      }),
    ).toEqual([
      { memberId: "member_ana", shareBps: 5_000 },
      { memberId: "member_jose", shareBps: 5_000 },
    ]);
  });

  test("an empty custom split falls back to the scope member at 100%", () => {
    expect(
      resolveOwnershipSplit({
        activeMembers: [ana, jose],
        scopeMemberId: "member_jose",
        preset: "custom",
        customBps: {},
        shortfall: "complete-to-full-ownership",
      }),
    ).toEqual([{ memberId: "member_jose", shareBps: 10_000 }]);
  });
});
