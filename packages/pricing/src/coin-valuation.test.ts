/**
 * Coin-value module (#240, ADR 0017).
 *
 * The single deep module answering, for one coin position: its coin value — the
 * GREATER of metal and numismatic, falling back to purchase price, then 0 — plus
 * the freshness of each candidate, under ONE staleness config. These tests drive
 * that interface: each fallback rung of the decision, and a stale-candidate case
 * for each of the two clocks (metal spot daily; numismatic estimate 30-day).
 */
import { describe, expect, it } from "vitest";
import type { CoinValuationInput } from "./coin-valuation";
import { COIN_VALUE_TTL_DAYS, coinValuation, isNumismaticStale } from "./coin-valuation";

const NOW = "2026-06-15T12:00:00.000Z";
const STALE_NUMISMATIC = "2026-05-01T12:00:00.000Z"; // 45 days before NOW → past 30d

/** A silver-eagle position: precious metal, weight + fineness, priced at a grade. */
function input(overrides: Partial<CoinValuationInput> = {}): CoinValuationInput {
  return {
    metal: "silver",
    finenessMillis: 999,
    weightGrams: 31.103,
    quantity: 1,
    grade: "unc",
    spotPerOzEur: 28,
    prices: [{ grade: "unc", price: 75.585 }],
    numismaticFetchedAt: NOW,
    purchasePriceMinor: null,
    lastMetalValueMinor: null,
    lastNumismaticValueMinor: null,
    nowIso: NOW,
    ...overrides,
  };
}

describe("COIN_VALUE_TTL_DAYS — one discoverable staleness config", () => {
  it("carries the metal-spot daily cadence and the numismatic 30-day cadence", () => {
    expect(COIN_VALUE_TTL_DAYS).toEqual({ metalSpot: 1, numismaticEstimate: 30 });
  });
});

describe("coinValuation — candidates + the max/purchase/zero decision (ADR 0017)", () => {
  it("takes the metal value when it beats the numismatic estimate", () => {
    // metal: 31.103 × .999 / 31.1035 × €28 = 2797; numismatic: 12 → 1200
    const v = coinValuation(input({ prices: [{ grade: "unc", price: 12 }] }));
    expect(v.metal.minor).toBe(2797);
    expect(v.numismatic.minor).toBe(1200);
    expect(v.value).toEqual({ minor: 2797, basis: "metal" });
  });

  it("takes the numismatic estimate when it beats the metal value", () => {
    // metal: 2797; numismatic: 75.585 → 7558
    const v = coinValuation(input());
    expect(v.value).toEqual({ minor: 7558, basis: "numismatic" });
  });

  it("a tie resolves to metal (the bullion floor)", () => {
    // numismatic 27.97 → 2797, equal to the metal candidate
    const v = coinValuation(input({ prices: [{ grade: "unc", price: 27.97 }] }));
    expect(v.metal.minor).toBe(2797);
    expect(v.numismatic.minor).toBe(2797);
    expect(v.value).toEqual({ minor: 2797, basis: "metal" });
  });

  it("falls back to the purchase price when neither candidate is known", () => {
    const v = coinValuation(
      input({
        metal: null, // base-metal coin → no melt value
        prices: [], // Numista has no estimate at the grade
        purchasePriceMinor: 4050,
      }),
    );
    expect(v.metal.minor).toBeNull();
    expect(v.numismatic.minor).toBeNull();
    expect(v.value).toEqual({ minor: 4050, basis: "purchase" });
  });

  it("is 0 when neither candidate is known and there is no purchase price", () => {
    const v = coinValuation(input({ metal: null, prices: [], purchasePriceMinor: null }));
    expect(v.value).toEqual({ minor: 0, basis: "zero" });
  });

  it("scales both candidates by quantity", () => {
    // metal: 25 × .900 / 31.1035 × €28 × 2 = 4051; numismatic: 12 → 1200 × 2 = 2400
    const v = coinValuation(
      input({
        finenessMillis: 900,
        weightGrams: 25,
        quantity: 2,
        prices: [{ grade: "vf", price: 12 }],
        grade: "vf",
      }),
    );
    expect(v.metal.minor).toBe(4051);
    expect(v.numismatic.minor).toBe(2400);
  });
});

describe("coinValuation — metal-spot freshness (the shared daily clock)", () => {
  it("marks the metal candidate fresh and recomputes from a live spot", () => {
    const v = coinValuation(input({ spotPerOzEur: 28, lastMetalValueMinor: 1 }));
    expect(v.metal.fresh).toBe(true);
    expect(v.metal.minor).toBe(2797);
  });

  it("marks the metal candidate stale and keeps the last-known value on a spot outage", () => {
    const v = coinValuation(input({ spotPerOzEur: null, lastMetalValueMinor: 2750 }));
    expect(v.metal.fresh).toBe(false);
    expect(v.metal.minor).toBe(2750); // outage must not zero/null the figure
  });
});

describe("coinValuation — numismatic freshness (the 30-day clock)", () => {
  it("marks the numismatic candidate fresh while within the TTL", () => {
    const v = coinValuation(input({ numismaticFetchedAt: NOW }));
    expect(v.numismatic.fresh).toBe(true);
    expect(v.numismatic.fetchedAt).toBe(NOW);
  });

  it("marks the numismatic candidate stale once past the 30-day TTL", () => {
    const v = coinValuation(input({ numismaticFetchedAt: STALE_NUMISMATIC }));
    expect(v.numismatic.fresh).toBe(false);
  });

  it("marks the numismatic candidate stale when it was never fetched", () => {
    const v = coinValuation(input({ numismaticFetchedAt: null }));
    expect(v.numismatic.fresh).toBe(false);
  });
});

describe("isNumismaticStale — the 30-day clock decision", () => {
  it("is stale past the TTL, when never fetched, and fresh within it", () => {
    expect(isNumismaticStale(STALE_NUMISMATIC, NOW)).toBe(true);
    expect(isNumismaticStale(null, NOW)).toBe(true);
    expect(isNumismaticStale(NOW, NOW)).toBe(false);
  });
});
