import { describe, expect, test, vi } from "vitest";
import { resolveFxRateSnapshot } from "./fx-rates";

const ASOF = "2026-07-13";

describe("resolveFxRateSnapshot", () => {
  test("builds a snapshot whose dated/spot lookups resolve the fetched ECB rates", async () => {
    const fetchDailyRates = vi.fn(async (currency: string) => {
      if (currency === "USD") {
        return new Map([
          ["2026-07-10", 0.9],
          ["2026-07-13", 0.92],
        ]);
      }
      return new Map<string, number>();
    });

    const snapshot = await resolveFxRateSnapshot(["USD"], ASOF, { fetchDailyRates });

    expect(snapshot.eurPerUnit("USD", "2026-07-10")).toBe(0.9);
    // Spot for the present-day asOf = latest observation.
    expect(snapshot.eurPerUnit("USD", "2026-07-13")).toBe(0.92);
    // Carry-forward across the weekend gap.
    expect(snapshot.eurPerUnit("USD", "2026-07-12")).toBe(0.9);
  });

  test("fetches each non-EUR currency once over the carry-forward window ending at asOf", async () => {
    const fetchDailyRates = vi.fn(
      async (_currency: string, _fromMs: number, _toMs: number) =>
        new Map<string, number>(),
    );

    await resolveFxRateSnapshot(["USD", "GBP"], ASOF, { fetchDailyRates });

    expect(fetchDailyRates).toHaveBeenCalledTimes(2);
    const [, fromMs, toMs] = fetchDailyRates.mock.calls[0]!;
    expect(new Date(toMs as number).toISOString().slice(0, 10)).toBe(ASOF);
    // The window is bounded below (carry-forward), never open-ended.
    expect(fromMs as number).toBeLessThan(toMs as number);
  });

  test("never fetches EUR (the pivot is always 1) and dedupes currencies", async () => {
    const fetchDailyRates = vi.fn(
      async (_currency: string, _fromMs: number, _toMs: number) =>
        new Map<string, number>(),
    );

    const snapshot = await resolveFxRateSnapshot(["EUR", "USD", "USD", "eur"], ASOF, {
      fetchDailyRates,
    });

    expect(snapshot.eurPerUnit("EUR", ASOF)).toBe(1);
    expect(fetchDailyRates).toHaveBeenCalledTimes(1);
    expect(fetchDailyRates.mock.calls[0]![0]).toBe("USD");
  });

  test("an absent rate stays absent — the lookup returns null, never 1:1", async () => {
    const fetchDailyRates = vi.fn(
      async (_currency: string, _fromMs: number, _toMs: number) =>
        new Map<string, number>(),
    );

    const snapshot = await resolveFxRateSnapshot(["CHF"], ASOF, { fetchDailyRates });

    expect(snapshot.eurPerUnit("CHF", ASOF)).toBeNull();
  });

  test("an empty currency list resolves without fetching", async () => {
    const fetchDailyRates = vi.fn(
      async (_currency: string, _fromMs: number, _toMs: number) =>
        new Map<string, number>(),
    );

    const snapshot = await resolveFxRateSnapshot([], ASOF, { fetchDailyRates });

    expect(fetchDailyRates).not.toHaveBeenCalled();
    expect(snapshot.eurPerUnit("EUR", ASOF)).toBe(1);
  });
});
