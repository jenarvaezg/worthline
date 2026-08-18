import { describe, expect, it } from "vitest";
import { splitFireCapital } from "./fire-capital-split";

describe("splitFireCapital", () => {
  it("splits the eligible pool into sellable and immobilized sides", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 100_000, housing: 300_000 },
      debtByTierMinor: {},
    });

    expect(split.sellable.amountMinor).toBe(100_000);
    expect(split.immobilized.amountMinor).toBe(300_000);
  });

  it("groups cash, market and term-locked as sellable; illiquid and housing as immobilized", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: {
        cash: 1_000,
        market: 2_000,
        "term-locked": 4_000,
        illiquid: 8_000,
        housing: 16_000,
      },
      debtByTierMinor: {},
    });

    expect(split.sellable.grossMinor).toBe(7_000);
    expect(split.immobilized.grossMinor).toBe(24_000);
    expect(split.sellable.tiers).toEqual(["cash", "market", "term-locked"]);
    expect(split.immobilized.tiers).toEqual(["illiquid", "housing"]);
  });

  it("lists only the tiers that actually carry capital, ladder-ordered", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { "term-locked": 10_556, market: 143_370, housing: 370_000 },
      debtByTierMinor: {},
    });

    expect(split.sellable.tiers).toEqual(["market", "term-locked"]);
    expect(split.immobilized.tiers).toEqual(["housing"]);
  });

  // ── The rule this module exists for: a mortgage cannot eat the market cash.
  it("nets a housing-secured debt inside the immobilized side, leaving the sellable side untouched", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 143_370, "term-locked": 10_556, housing: 370_000 },
      debtByTierMinor: { housing: 68_628 },
    });

    expect(split.sellable.amountMinor).toBe(153_926);
    expect(split.sellable.debtMinor).toBe(0);
    expect(split.immobilized.amountMinor).toBe(301_372);
    expect(split.immobilized.debtMinor).toBe(68_628);
  });

  it("nets an unassociated debt against the sellable side (it lands on the cash rung)", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 100_000, housing: 200_000 },
      debtByTierMinor: { cash: 30_000 },
    });

    expect(split.sellable.amountMinor).toBe(70_000);
    expect(split.immobilized.amountMinor).toBe(200_000);
  });

  // ── Underwater: a debt bigger than its own side really does eat the other one.
  it("spills an underwater side onto the other rather than reporting negative capital", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 100_000, housing: 50_000 },
      debtByTierMinor: { housing: 80_000 },
    });

    expect(split.immobilized.amountMinor).toBe(0);
    expect(split.sellable.amountMinor).toBe(70_000);
  });

  it("clamps both sides to zero when the whole scope is underwater", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 50_000 },
      debtByTierMinor: { cash: 200_000 },
    });

    expect(split.sellable.amountMinor).toBe(0);
    expect(split.immobilized.amountMinor).toBe(0);
  });

  // ── Goal reservation: a dated goal is paid by selling, so it comes off the
  //    sellable side first — the split must still add up to what the page shows.
  it("takes the goal reservation off the sellable side first", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 100_000, housing: 300_000 },
      debtByTierMinor: {},
      reservedForGoalsMinor: 40_000,
    });

    expect(split.sellable.amountMinor).toBe(60_000);
    expect(split.sellable.reservedMinor).toBe(40_000);
    expect(split.immobilized.amountMinor).toBe(300_000);
    expect(split.immobilized.reservedMinor).toBe(0);
  });

  it("spills a reservation bigger than the sellable side onto the immobilized side", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 20_000, housing: 300_000 },
      debtByTierMinor: {},
      reservedForGoalsMinor: 50_000,
    });

    expect(split.sellable.amountMinor).toBe(0);
    expect(split.sellable.reservedMinor).toBe(20_000);
    expect(split.immobilized.amountMinor).toBe(270_000);
    expect(split.immobilized.reservedMinor).toBe(30_000);
  });

  it("never reserves more than the pool holds", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 20_000 },
      debtByTierMinor: {},
      reservedForGoalsMinor: 999_000,
    });

    expect(split.sellable.amountMinor).toBe(0);
    expect(split.immobilized.amountMinor).toBe(0);
    expect(split.sellable.reservedMinor).toBe(20_000);
  });

  it("is empty-safe", () => {
    const split = splitFireCapital({ eligibleByTierMinor: {}, debtByTierMinor: {} });

    expect(split.sellable).toEqual({
      amountMinor: 0,
      grossMinor: 0,
      debtMinor: 0,
      reservedMinor: 0,
      tiers: [],
    });
    expect(split.immobilized.tiers).toEqual([]);
  });
});
