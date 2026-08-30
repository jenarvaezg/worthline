import { memberGradient } from "@web/patrimonio/_board/portfolio-block";
import type { UnifiedHolding } from "@worthline/domain";
import { describe, expect, test } from "vitest";

function member(
  id: string,
  valueMinor: number,
  tier: UnifiedHolding["tier"],
): UnifiedHolding {
  return {
    direction: "asset",
    id,
    instrument: "fund",
    name: id,
    ownership: { shares: [], totalShareBps: 10_000 },
    priceFetchedAt: null,
    priceSource: null,
    tier,
    tierLabel: tier,
    valueIsDerived: true,
    valueMinor,
  };
}

describe("memberGradient (#1548, #1608)", () => {
  test("cuts the bar by member, each in ITS OWN rung colour", () => {
    const gradient = memberGradient(
      [member("a", 75_00, "market"), member("b", 25_00, "cash")],
      100_00,
    );

    expect(gradient).toBe(
      "linear-gradient(90deg, var(--tier-market) 0% 75%, var(--panel) 75% 75.6%, var(--tier-cash) 75.6% 100%)",
    );
  });

  test("no hairline before the first member — a cut needs two sides", () => {
    expect(memberGradient([member("only", 10_00, "market")], 10_00)).toBe(
      "linear-gradient(90deg, var(--tier-market) 0% 100%)",
    );
  });

  test("the hairline never eats the member it separates", () => {
    // A sliver worth 0,1 % of the block: the 0,6 % separator would run past it,
    // so it is clamped to the member's own end instead of inverting the stop.
    const gradient = memberGradient(
      [member("whale", 999_90, "market"), member("dust", 10, "cash")],
      1_000_00,
    );

    expect(gradient).toContain("var(--panel) 99.99% 100%");
    expect(gradient).toContain("var(--tier-cash) 100% 100%");
  });

  test("a block worth nothing degrades to the dominant colour, never NaN stops", () => {
    expect(memberGradient([member("a", 0, "market")], 0)).toBe("var(--tier-market)");
    expect(memberGradient([], 100_00)).toBe("var(--tier-market)");
  });
});
