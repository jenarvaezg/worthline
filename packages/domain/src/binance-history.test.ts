/**
 * Binance monthly value history — the pure builder (PRD #245, S5, ADR 0021).
 *
 * The value on any date = Σ over tokens of (the token's balance held at that
 * date's *month-end* — a step function within the month) × (that token's EUR
 * price on that *exact day*). This pins the step-within-month × that-day-price
 * rule, the unpriceable-→-0 contract (never throws), the curve-start date, and
 * the completed-month-end enumeration that excludes the current partial month.
 */
import { describe, expect, it } from "vitest";

import {
  binanceCurveStartDate,
  binanceValueAtDate,
  completedMonthEndDates,
} from "./binance-history";
import type { BinanceHistoryCurve } from "./binance-history";

/** Tiny curve builder so the tests read as data, not Map ceremony. */
function curve(input: {
  monthEndBalances?: Record<string, Record<string, string>>;
  dailyPriceBySymbol?: Record<string, Record<string, string>>;
}): BinanceHistoryCurve {
  const toNestedMap = (rec: Record<string, Record<string, string>> = {}) =>
    new Map(Object.entries(rec).map(([k, inner]) => [k, new Map(Object.entries(inner))]));
  return {
    monthEndBalances: toNestedMap(input.monthEndBalances),
    dailyPriceBySymbol: toNestedMap(input.dailyPriceBySymbol),
  };
}

describe("binanceValueAtDate — balance(month) × price(day), summed across symbols", () => {
  it("values one symbol as month-end balance × that-day price (half-up minor)", () => {
    const c = curve({
      monthEndBalances: { BTC: { "2026-03": "0.5" } },
      dailyPriceBySymbol: { BTC: { "2026-03-31": "50000" } },
    });
    // 0.5 × 50000 = 25000 EUR = 2_500_000 minor.
    expect(binanceValueAtDate(c, "2026-03-31")).toBe(2_500_000);
  });

  it("uses the month-end balance for any mid-month day (step function within the month)", () => {
    const c = curve({
      monthEndBalances: { BTC: { "2026-03": "0.5" } },
      dailyPriceBySymbol: { BTC: { "2026-03-10": "40000" } },
    });
    // mid-month day 2026-03-10 still reads the month's end balance (0.5) × that day's price.
    expect(binanceValueAtDate(c, "2026-03-10")).toBe(2_000_000); // 0.5 × 40000
  });

  it("rounds half-up through multiplyToMinor", () => {
    const c = curve({
      monthEndBalances: { BTC: { "2026-03": "1" } },
      dailyPriceBySymbol: { BTC: { "2026-03-15": "0.005" } },
    });
    // 1 × 0.005 EUR = 0.5 minor → half-up → 1 minor.
    expect(binanceValueAtDate(c, "2026-03-15")).toBe(1);
  });

  it("sums across multiple symbols", () => {
    const c = curve({
      monthEndBalances: { BTC: { "2026-03": "0.5" }, ETH: { "2026-03": "2" } },
      dailyPriceBySymbol: {
        BTC: { "2026-03-31": "50000" },
        ETH: { "2026-03-31": "2000" },
      },
    });
    // BTC 0.5×50000 = 25000; ETH 2×2000 = 4000; total 29000 EUR = 2_900_000 minor.
    expect(binanceValueAtDate(c, "2026-03-31")).toBe(2_900_000);
  });

  it("a symbol with no balance that month contributes 0", () => {
    const c = curve({
      monthEndBalances: { BTC: { "2026-03": "0.5" }, ETH: { "2026-02": "10" } },
      dailyPriceBySymbol: {
        BTC: { "2026-03-31": "50000" },
        ETH: { "2026-03-31": "2000" },
      },
    });
    // ETH has no 2026-03 balance → contributes 0; only BTC counts.
    expect(binanceValueAtDate(c, "2026-03-31")).toBe(2_500_000);
  });

  it("a symbol with a balance but NO price that day contributes 0 (unpriceable → 0, never throws)", () => {
    const c = curve({
      monthEndBalances: { BTC: { "2026-03": "0.5" }, WAGMI: { "2026-03": "100" } },
      dailyPriceBySymbol: { BTC: { "2026-03-31": "50000" } }, // WAGMI has no price series at all
    });
    expect(binanceValueAtDate(c, "2026-03-31")).toBe(2_500_000);
  });

  it("a priced symbol missing THAT day's price contributes 0 (no carry-forward)", () => {
    const c = curve({
      monthEndBalances: { BTC: { "2026-03": "0.5" } },
      dailyPriceBySymbol: { BTC: { "2026-03-30": "50000" } }, // priced 03-30, not 03-31
    });
    expect(binanceValueAtDate(c, "2026-03-31")).toBe(0);
  });

  it("an empty curve values to 0", () => {
    expect(binanceValueAtDate(curve({}), "2026-03-31")).toBe(0);
  });
});

describe("binanceCurveStartDate — earliest date the curve can value", () => {
  it("is the earliest dateKey with both a month balance and a price for some symbol", () => {
    const c = curve({
      monthEndBalances: { BTC: { "2026-02": "0.5", "2026-03": "0.5" } },
      dailyPriceBySymbol: {
        BTC: { "2026-02-28": "45000", "2026-03-31": "50000" },
      },
    });
    expect(binanceCurveStartDate(c)).toBe("2026-02-28");
  });

  it("ignores priced days whose month has no balance for that symbol", () => {
    const c = curve({
      monthEndBalances: { BTC: { "2026-03": "0.5" } },
      // a stray 2026-01 price for a month with no balance must NOT become the start.
      dailyPriceBySymbol: { BTC: { "2026-01-15": "30000", "2026-03-31": "50000" } },
    });
    expect(binanceCurveStartDate(c)).toBe("2026-03-31");
  });

  it("takes the earliest valuable day across symbols", () => {
    const c = curve({
      monthEndBalances: { BTC: { "2026-03": "0.5" }, ETH: { "2026-01": "2" } },
      dailyPriceBySymbol: {
        BTC: { "2026-03-31": "50000" },
        ETH: { "2026-01-31": "2000" },
      },
    });
    expect(binanceCurveStartDate(c)).toBe("2026-01-31");
  });

  it("is null for an empty curve", () => {
    expect(binanceCurveStartDate(curve({}))).toBeNull();
  });

  it("is null when prices never overlap a month with a balance", () => {
    const c = curve({
      monthEndBalances: { BTC: { "2026-03": "0.5" } },
      dailyPriceBySymbol: { BTC: { "2026-01-15": "30000" } },
    });
    expect(binanceCurveStartDate(c)).toBeNull();
  });
});

describe("completedMonthEndDates — last-day-of-each-covered-month strictly before today's month", () => {
  it("returns each covered month's last calendar day, ascending, excluding the current month", () => {
    const c = curve({
      monthEndBalances: {
        BTC: { "2026-01": "1", "2026-02": "1", "2026-03": "1" },
      },
    });
    // today is in 2026-03 → the current (partial) month is excluded.
    expect(completedMonthEndDates(c, "2026-03-16")).toEqual(["2026-01-31", "2026-02-28"]);
  });

  it("handles leap-February and 30-day months via a last-day helper", () => {
    const c = curve({
      monthEndBalances: { BTC: { "2024-02": "1", "2024-04": "1" } },
    });
    expect(completedMonthEndDates(c, "2026-01-01")).toEqual(["2024-02-29", "2024-04-30"]);
  });

  it("unions month keys across symbols and dedupes", () => {
    const c = curve({
      monthEndBalances: {
        BTC: { "2026-01": "1", "2026-02": "1" },
        ETH: { "2026-02": "2", "2026-03": "2" },
      },
    });
    expect(completedMonthEndDates(c, "2026-04-10")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
  });

  it("excludes the current month even when it is the only covered month", () => {
    const c = curve({ monthEndBalances: { BTC: { "2026-06": "1" } } });
    expect(completedMonthEndDates(c, "2026-06-16")).toEqual([]);
  });

  it("is empty for an empty curve", () => {
    expect(completedMonthEndDates(curve({}), "2026-06-16")).toEqual([]);
  });
});
