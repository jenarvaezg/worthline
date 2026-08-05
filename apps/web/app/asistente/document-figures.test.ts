import { describe, expect, it } from "vitest";

import {
  formatDocumentMoney,
  formatDocumentUnitPrice,
  formatDocumentUnits,
} from "./document-figures";

/** es-ES puts NBSP/narrow-NBSP before the symbol; compare in plain spaces. */
function plain(value: string): string {
  return value.replace(/[\u00a0\u202f]/g, " ");
}

describe("formatDocumentMoney", () => {
  it("keeps the cents a document printed and adds none where there are none", () => {
    expect(plain(formatDocumentMoney(12_500))).toBe("125 €");
    expect(plain(formatDocumentMoney(12_550))).toBe("125,50 €");
  });

  it("prints a non-EUR amount in its own currency, never converted", () => {
    expect(plain(formatDocumentMoney(90_000, "USD"))).toContain("900");
    expect(plain(formatDocumentMoney(90_000, "USD"))).not.toContain("€");
  });
});

describe("formatDocumentUnits / formatDocumentUnitPrice", () => {
  it("reads participaciones at six decimals and a NAV at four", () => {
    expect(formatDocumentUnits(5.92)).toBe("5,92");
    // Decimal strings are what the plan carries: read, not re-punctuated.
    expect(formatDocumentUnits("262.012")).toBe("262,012");
    expect(formatDocumentUnitPrice(21.114864864864865)).toBe("21,1149");
  });

  it("shows a figure it cannot read raw instead of NaN", () => {
    expect(formatDocumentUnits("no-es-un-número")).toBe("no-es-un-número");
    expect(formatDocumentUnitPrice("—")).toBe("—");
  });
});
