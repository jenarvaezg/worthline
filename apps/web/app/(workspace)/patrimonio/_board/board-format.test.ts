import { barColor, ownershipLabel, tierVar } from "@web/patrimonio/_board/board-format";
import type { UnifiedHolding } from "@worthline/domain";
import { describe, expect, test } from "vitest";

function owned(totalShareBps: number): UnifiedHolding {
  return {
    direction: "asset",
    id: "a",
    instrument: "fund",
    name: "A",
    ownership: { shares: [], totalShareBps },
    priceFetchedAt: null,
    priceSource: null,
    tier: "market",
    tierLabel: "Mercado",
    valueIsDerived: false,
    valueMinor: 1_00,
  };
}

describe("ownershipLabel (#1608)", () => {
  test("says nothing outside a household — there is nobody to share with", () => {
    expect(ownershipLabel(owned(6_000), false)).toBeNull();
  });

  test("whole ownership reads 100 %", () => {
    expect(ownershipLabel(owned(10_000), true)).toBe("100 %");
  });

  test("a partial share reads its rounded percentage", () => {
    expect(ownershipLabel(owned(6_000), true)).toBe("60 %");
  });

  test("99,5 % never rounds up to «100 %» — that would hide the co-ownership", () => {
    expect(ownershipLabel(owned(9_950), true)).toBe("99 %");
    expect(ownershipLabel(owned(9_999), true)).toBe("99 %");
  });
});

describe("barColor (#1608)", () => {
  test("an asset paints its rung's identity colour", () => {
    expect(barColor("housing", true)).toBe(tierVar("housing"));
  });

  test("a debt speaks the debit hue, so red stays free for movement (canon §6)", () => {
    expect(barColor("housing", false)).toBe("var(--debit-rule)");
  });
});
