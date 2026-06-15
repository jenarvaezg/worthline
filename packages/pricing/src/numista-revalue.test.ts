/**
 * Coin valuation refresh (PRD #160 / #166, ADR 0017).
 *
 * The decoupled counterpart of the on-demand position sync: given the positions
 * already stored (with their indefinite coin detail), re-derive the two candidate
 * values from fresh inputs — metal spot (free, daily) recomputed every pass, the
 * numismatic estimate (Numista-capped) only refetched past its long TTL. Pure +
 * injected, so the cap discipline and outage behaviour are tested without I/O.
 */
import { describe, expect, it, vi } from "vitest";

import { NUMISMATIC_TTL_DAYS, refreshCoinValuations } from "./numista-revalue";
import type { RevaluePosition } from "./numista-revalue";

const NOW = "2026-06-15T12:00:00.000Z";

/** A silver-eagle position whose detail (metal/fineness/weight) is already stored. */
function silverEagle(overrides: Partial<RevaluePosition> = {}): RevaluePosition {
  return {
    id: "pos-eagle",
    typeId: 1493,
    issueId: 32723,
    grade: "unc",
    quantity: 1,
    metal: "silver",
    finenessMillis: 999,
    weightGrams: 31.103,
    metalValueMinor: 1, // stale prior value, must be overwritten
    numismaticValueMinor: 7558,
    numismaticFetchedAt: NOW, // fresh → numismatic not refetched this pass
    ...overrides,
  };
}

function deps(overrides: Partial<Parameters<typeof refreshCoinValuations>[1]> = {}) {
  return {
    prices: vi.fn(async () => ({
      currency: "EUR",
      prices: [{ grade: "unc", price: 75.585 }],
    })),
    spotPerOzEur: vi.fn(async () => 28),
    ...overrides,
  };
}

describe("refreshCoinValuations — metal value rides the daily spot", () => {
  it("recomputes metal value from stored detail × fresh spot", async () => {
    const result = await refreshCoinValuations([silverEagle()], deps(), { nowIso: NOW });

    expect(result).toHaveLength(1);
    // 31.103g × .999 / 31.1035 × €28 → 2797 minor (same basis as the sync path)
    expect(result[0]).toMatchObject({ id: "pos-eagle", metalValueMinor: 2797 });
  });

  it("keeps the last-known metal value when spot is unavailable (outage)", async () => {
    const result = await refreshCoinValuations(
      [silverEagle({ metalValueMinor: 2750 })],
      deps({ spotPerOzEur: vi.fn(async () => null) }),
      { nowIso: NOW },
    );

    // Spot outage must not zero or null the figure — the holding keeps its value.
    expect(result[0]!.metalValueMinor).toBe(2750);
  });

  it("dedupes the spot lookup across positions of the same metal", async () => {
    const d = deps();
    await refreshCoinValuations([silverEagle({ id: "a" }), silverEagle({ id: "b" })], d, {
      nowIso: NOW,
    });

    expect(d.spotPerOzEur).toHaveBeenCalledTimes(1); // silver spot fetched once
  });
});

describe("refreshCoinValuations — numismatic estimate rides the long TTL", () => {
  const STALE = "2026-05-01T12:00:00.000Z"; // 45 days before NOW → past the 30d TTL

  it("refetches and restamps when the estimate is past its long TTL", async () => {
    const d = deps();
    const result = await refreshCoinValuations(
      [silverEagle({ numismaticFetchedAt: STALE, numismaticValueMinor: 1 })],
      d,
      { nowIso: NOW },
    );

    expect(d.prices).toHaveBeenCalledWith(1493, 32723);
    expect(result[0]).toMatchObject({
      numismaticValueMinor: 7558, // 75.585 → 7558 minor, × qty 1
      numismaticFetchedAt: NOW,
    });
  });

  it("refetches when never fetched before (fetched-at null)", async () => {
    const d = deps();
    await refreshCoinValuations([silverEagle({ numismaticFetchedAt: null })], d, {
      nowIso: NOW,
    });

    expect(d.prices).toHaveBeenCalledTimes(1);
  });

  it("skips the refetch (no Numista call) while the estimate is still fresh", async () => {
    const d = deps();
    const result = await refreshCoinValuations(
      [silverEagle({ numismaticFetchedAt: NOW, numismaticValueMinor: 9999 })],
      d,
      { nowIso: NOW },
    );

    expect(d.prices).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({
      numismaticValueMinor: 9999, // last-known, untouched
      numismaticFetchedAt: NOW,
    });
  });

  it("keeps last-known numismatic and leaves fetched-at when the fetch fails", async () => {
    const result = await refreshCoinValuations(
      [silverEagle({ numismaticFetchedAt: STALE, numismaticValueMinor: 7558 })],
      deps({ prices: vi.fn(async () => null) }), // Numista outage / unavailable
      { nowIso: NOW },
    );

    // Value survives; fetched-at is NOT advanced, so the next pass retries.
    expect(result[0]).toMatchObject({
      numismaticValueMinor: 7558,
      numismaticFetchedAt: STALE,
    });
  });

  it("clears the estimate (stamping now) when the fetch succeeds but has no grade", async () => {
    const result = await refreshCoinValuations(
      [
        silverEagle({
          grade: "ms70",
          numismaticFetchedAt: STALE,
          numismaticValueMinor: 7558,
        }),
      ],
      deps(), // prices return only an "unc" grade → no match for "ms70"
      { nowIso: NOW },
    );

    // A successful read that finds no estimate at the grade is authoritative:
    // value becomes null (no fabrication) and fetched-at advances.
    expect(result[0]).toMatchObject({
      numismaticValueMinor: null,
      numismaticFetchedAt: NOW,
    });
  });

  it("dedupes the prices lookup across positions sharing (type, issue)", async () => {
    const d = deps();
    await refreshCoinValuations(
      [
        silverEagle({ id: "a", numismaticFetchedAt: STALE }),
        silverEagle({ id: "b", numismaticFetchedAt: STALE }),
      ],
      d,
      { nowIso: NOW },
    );

    expect(d.prices).toHaveBeenCalledTimes(1); // same (type, issue) → one estimate fetch
  });
});

describe("NUMISMATIC_TTL_DAYS", () => {
  it("is a long TTL (30 days) per ADR 0017", () => {
    expect(NUMISMATIC_TTL_DAYS).toBe(30);
  });
});
