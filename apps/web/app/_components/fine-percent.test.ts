import { describe, expect, test } from "vitest";

import { formatFinePercent } from "./fine-percent";

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
