import { describe, expect, test } from "vitest";
import { createFxRateSnapshot, createMoneyConverter, type FxRateSnapshot } from "./fx";
import { money } from "./money";

/**
 * A snapshot with a handful of dated USD and GBP observations (EUR-per-unit).
 * ECB publishes business days only, so weekend/holiday gaps are absent and the
 * carry-forward window fills them from the previous business day.
 */
function fixtureSnapshot(): FxRateSnapshot {
  return createFxRateSnapshot({
    // Fri 2026-07-10 .. Mon 2026-07-13 (Sat/Sun 11-12 absent).
    USD: [
      { dateKey: "2026-07-10", eurPerUnit: 0.9 },
      { dateKey: "2026-07-13", eurPerUnit: 0.92 },
    ],
    GBP: [{ dateKey: "2026-07-13", eurPerUnit: 1.15 }],
  });
}

describe("createMoneyConverter", () => {
  test("EUR→EUR is identity and needs no rate", () => {
    const converter = createMoneyConverter(createFxRateSnapshot({}));
    const result = converter.convert(money(12_345, "EUR"), "EUR", "2026-07-13");
    expect(result).toEqual({ ok: true, value: money(12_345, "EUR") });
  });

  test("same-currency conversion is identity even for a non-EUR currency", () => {
    const converter = createMoneyConverter(createFxRateSnapshot({}));
    const result = converter.convert(money(500, "USD"), "USD", "2026-07-13");
    expect(result).toEqual({ ok: true, value: money(500, "USD") });
  });

  test("converts a non-EUR figure to EUR using the DATED rate of its asOf", () => {
    const converter = createMoneyConverter(fixtureSnapshot());
    // 100.00 USD × 0.90 EUR/USD (the 2026-07-10 observation) = 90.00 EUR.
    const result = converter.convert(money(10_000, "USD"), "EUR", "2026-07-10");
    expect(result).toEqual({ ok: true, value: money(9_000, "EUR") });
  });

  test("uses the latest observation as the SPOT rate for a present-day asOf", () => {
    const converter = createMoneyConverter(fixtureSnapshot());
    // asOf beyond the last observation → spot = the latest (2026-07-13) rate 0.92.
    const result = converter.convert(money(10_000, "USD"), "EUR", "2026-07-20");
    expect(result).toEqual({ ok: true, value: money(9_200, "EUR") });
  });

  test("carries the previous business day's rate forward across a weekend", () => {
    const converter = createMoneyConverter(fixtureSnapshot());
    // Sun 2026-07-12 has no observation → carry forward Fri 2026-07-10 (0.90).
    const result = converter.convert(money(10_000, "USD"), "EUR", "2026-07-12");
    expect(result).toEqual({ ok: true, value: money(9_000, "EUR") });
  });

  test("absent pair (no observations for the currency) is {ok:false}, never 1:1", () => {
    const converter = createMoneyConverter(fixtureSnapshot());
    const result = converter.convert(money(10_000, "CHF"), "EUR", "2026-07-13");
    expect(result).toEqual({ ok: false, reason: "missing-rate" });
  });

  test("asOf before any observation is {ok:false}, never 1:1", () => {
    const converter = createMoneyConverter(fixtureSnapshot());
    const result = converter.convert(money(10_000, "USD"), "EUR", "2026-01-01");
    expect(result).toEqual({ ok: false, reason: "missing-rate" });
  });

  test("a gap wider than the carry-forward window is {ok:false}, never 1:1", () => {
    const converter = createMoneyConverter(
      createFxRateSnapshot({ USD: [{ dateKey: "2026-07-01", eurPerUnit: 0.9 }] }),
    );
    // 2026-07-13 is 12 days after the only observation (> 7-day window).
    const result = converter.convert(money(10_000, "USD"), "EUR", "2026-07-13");
    expect(result).toEqual({ ok: false, reason: "missing-rate" });
  });

  test("converts a cross pair (USD→GBP) through the EUR pivot", () => {
    const converter = createMoneyConverter(fixtureSnapshot());
    // 100.00 USD × 0.92 / 1.15 = 80.00 GBP at 2026-07-13.
    const result = converter.convert(money(10_000, "USD"), "GBP", "2026-07-13");
    expect(result).toEqual({ ok: true, value: money(8_000, "GBP") });
  });

  test("a cross pair is {ok:false} when EITHER leg's rate is missing", () => {
    const converter = createMoneyConverter(fixtureSnapshot());
    // GBP has no observation on/before 2026-07-10 → the `to` leg is missing.
    const result = converter.convert(money(10_000, "USD"), "GBP", "2026-07-10");
    expect(result).toEqual({ ok: false, reason: "missing-rate" });
  });

  test("rounds the converted amount to an integer minor unit", () => {
    const converter = createMoneyConverter(
      createFxRateSnapshot({ USD: [{ dateKey: "2026-07-13", eurPerUnit: 0.917 }] }),
    );
    // 33.33 USD × 0.917 = 30.56361 EUR → rounds to 3056 minor.
    const result = converter.convert(money(3_333, "USD"), "EUR", "2026-07-13");
    expect(result).toEqual({ ok: true, value: money(3_056, "EUR") });
  });
});

describe("createFxRateSnapshot.eurPerUnit", () => {
  test("EUR is always 1 without any observation", () => {
    const snapshot = createFxRateSnapshot({});
    expect(snapshot.eurPerUnit("EUR", "2026-07-13")).toBe(1);
  });

  test("returns null for an unknown currency (never invents a rate)", () => {
    const snapshot = fixtureSnapshot();
    expect(snapshot.eurPerUnit("JPY", "2026-07-13")).toBeNull();
  });

  test("returns the on-or-before observation within the carry-forward window", () => {
    const snapshot = fixtureSnapshot();
    expect(snapshot.eurPerUnit("USD", "2026-07-10")).toBe(0.9);
    expect(snapshot.eurPerUnit("USD", "2026-07-12")).toBe(0.9);
    expect(snapshot.eurPerUnit("USD", "2026-07-13")).toBe(0.92);
  });
});
