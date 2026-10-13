import { describe, expect, test } from "vitest";

import { formatDeclaredRatePercent, formatFinePercent } from "./fine-percent";

describe("formatFinePercent", () => {
  test("keeps two decimals, so the FIRE mix rows visibly add up", () => {
    expect(formatFinePercent(0.2793)).toBe("27,93 %");
    expect(formatFinePercent(1)).toBe("100,00 %");
  });

  test("prints a TER in its own hundredths of a percent", () => {
    expect(formatFinePercent(0.0018)).toBe("0,18 %");
    expect(formatFinePercent(0.002)).toBe("0,20 %");
  });
});

describe("formatDeclaredRatePercent", () => {
  test("reads two decimals like its sibling, padding a round rate", () => {
    expect(formatDeclaredRatePercent(0.03)).toBe("3,00 %");
    expect(formatDeclaredRatePercent(0.035)).toBe("3,50 %");
  });

  test("never rounds away a decimal the user declared", () => {
    // Euríbor plus a spread: 2,875 % is a real rate, not 2,88 %.
    expect(formatDeclaredRatePercent(0.02875)).toBe("2,875 %");
    expect(formatDeclaredRatePercent(0.031275)).toBe("3,1275 %");
  });
});
