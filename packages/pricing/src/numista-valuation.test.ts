/**
 * Numista valuation consolidation (ADR 0043).
 *
 * The full sync and revalue paths share candidate-value construction: the melt
 * value a coin gets on sync is byte-identical to the melt value it gets on revalue,
 * given the same detail + spot. Also asserts request-budget dedup and TTL.
 */

import type { NumistaCollectedItem, NumistaPrices } from "@pricing/numista";
import { describe, expect, it, vi } from "vitest";
import type { RevaluePosition, SyncedCoin } from "./numista-valuation";
import {
  NUMISMATIC_TTL_DAYS,
  refreshCoinValuations,
  syncNumistaCollection,
} from "./numista-valuation";

const NOW = "2026-06-15T12:00:00.000Z";

const SILVER_EAGLE: NumistaCollectedItem = {
  id: 1,
  quantity: 1,
  type: { id: 1493, title: "1 Dollar American Silver Eagle" },
  issue: { id: 32723 },
  grade: "unc",
};

function syncDeps() {
  return {
    listItems: vi.fn(async () => [SILVER_EAGLE]),
    typeDetail: vi.fn(async () => ({
      title: "Silver Eagle",
      compositionText: "Plata 999",
      weightGrams: 31.103,
      obverseThumbUrl: null,
    })),
    prices: vi.fn(async () => ({
      currency: "EUR",
      prices: [{ grade: "unc", price: 75.585 }],
    })),
    spotPerOzEur: vi.fn(async () => 28),
  };
}

function storedEagle(): RevaluePosition {
  return {
    id: "pos-eagle",
    typeId: 1493,
    issueId: 32723,
    grade: "unc",
    quantity: 1,
    metal: "silver",
    finenessMillis: 999,
    weightGrams: 31.103,
    metalValueMinor: 1,
    numismaticValueMinor: 1,
    numismaticFetchedAt: null, // never fetched → revalue refetches this pass
  };
}

describe("numista-valuation — sync + revalue share one module", () => {
  it("exposes both modes from a single module", () => {
    expect(typeof syncNumistaCollection).toBe("function");
    expect(typeof refreshCoinValuations).toBe("function");
  });

  it("the melt + numismatic values are byte-identical across sync and revalue", async () => {
    const drafts = await syncNumistaCollection(syncDeps(), NOW);
    const synced = drafts[0]!;

    const revalued = await refreshCoinValuations(
      [storedEagle()],
      {
        prices: vi.fn(async () => ({
          currency: "EUR",
          prices: [{ grade: "unc", price: 75.585 }],
        })),
        spotPerOzEur: vi.fn(async () => 28),
      },
      { nowIso: NOW },
    );
    const re = revalued[0]!;

    // The shared candidate-row construction must produce the same numbers from the
    // same detail + spot + estimate, whichever mode resolved them.
    expect(re.metalValueMinor).toBe(synced.metalValueMinor);
    expect(re.numismaticValueMinor).toBe(synced.numismaticValueMinor);
  });
});

describe("numista-valuation — request budget preserved by both modes", () => {
  it("sync dedupes type-detail + spot per metal (one lookup each)", async () => {
    const d = syncDeps();
    d.listItems = vi.fn(async () => [SILVER_EAGLE, SILVER_EAGLE]);

    await syncNumistaCollection(d, NOW);

    expect(d.typeDetail).toHaveBeenCalledTimes(1);
    expect(d.spotPerOzEur).toHaveBeenCalledTimes(1);
  });

  it("revalue dedupes spot per metal and estimate per (type, issue)", async () => {
    const prices = vi.fn(async () => ({
      currency: "EUR",
      prices: [{ grade: "unc", price: 75.585 }],
    }));
    const spotPerOzEur = vi.fn(async () => 28);

    await refreshCoinValuations(
      [
        { ...storedEagle(), id: "a" },
        { ...storedEagle(), id: "b" },
      ],
      { prices, spotPerOzEur },
      { nowIso: NOW },
    );

    expect(spotPerOzEur).toHaveBeenCalledTimes(1);
    expect(prices).toHaveBeenCalledTimes(1);
  });
});

describe("numista-valuation — numismatic TTL preserved", () => {
  it("is the long 30-day TTL from the single coin-value config (ADR 0017)", () => {
    expect(NUMISMATIC_TTL_DAYS).toBe(30);
  });

  it("revalue skips the Numista call while the estimate is still fresh", async () => {
    const prices = vi.fn(async () => ({
      currency: "EUR",
      prices: [{ grade: "unc", price: 75.585 }],
    }));

    await refreshCoinValuations(
      [{ ...storedEagle(), numismaticFetchedAt: NOW }],
      { prices, spotPerOzEur: vi.fn(async () => 28) },
      { nowIso: NOW },
    );

    expect(prices).not.toHaveBeenCalled();
  });
});

describe("numista-valuation — the stamp advances only on an answer (#1740)", () => {
  const STALE = "2026-05-01T12:00:00.000Z"; // 45 days before NOW → past the TTL

  /** What an earlier pass persisted for this coin: valued, but with a lapsed
   *  stamp, so both modes are due to ask Numista again. */
  function persistedEagle(): SyncedCoin {
    return {
      externalId: "1",
      catalogueId: "1493",
      issueId: 32723,
      grade: "unc",
      quantity: 1,
      metal: "silver",
      finenessMillis: 999,
      weightGrams: 31.103,
      obverseThumbUrl: null,
      numismaticValueMinor: 7558,
      numismaticFetchedAt: STALE,
    };
  }

  /** One pass over that coin, in the vocabulary both modes share: which
   *  numismatic figure it ends up with, and under which stamp. */
  type FetchPrices = () => Promise<NumistaPrices | null>;
  interface PassOutcome {
    fetchedAt: string | null;
    valueMinor: number | null;
  }

  // The TWO paths that value the same coin. The stamping criterion is asserted
  // over both from ONE table, so they cannot diverge again (#1740).
  const MODES: { name: string; run: (prices: FetchPrices) => Promise<PassOutcome> }[] = [
    {
      name: "sync",
      run: async (prices) => {
        const drafts = await syncNumistaCollection(
          { ...syncDeps(), prices: vi.fn(prices) },
          NOW,
          [persistedEagle()],
        );
        const draft = drafts[0]!;
        return {
          fetchedAt: draft.numismaticFetchedAt,
          valueMinor: draft.numismaticValueMinor,
        };
      },
    },
    {
      name: "revalue",
      run: async (prices) => {
        const revalued = await refreshCoinValuations(
          [{ ...storedEagle(), numismaticFetchedAt: STALE, numismaticValueMinor: 7558 }],
          { prices: vi.fn(prices), spotPerOzEur: vi.fn(async () => 28) },
          { nowIso: NOW },
        );
        const position = revalued[0]!;
        return {
          fetchedAt: position.numismaticFetchedAt,
          valueMinor: position.numismaticValueMinor,
        };
      },
    },
  ];

  it.each(
    MODES,
  )("$name: a provider that does not answer stamps nothing and keeps the figure", async ({
    run,
  }) => {
    // Numista 500s, or the abort signal cuts in: stamping this as "valued
    // today" would fabricate freshness and hide the failure for 30 days.
    expect(await run(async () => null)).toEqual({
      fetchedAt: STALE,
      valueMinor: 7558,
    });
  });

  it.each(MODES)("$name: an answer does stamp, with the pass's clock", async ({
    run,
  }) => {
    expect(
      await run(async () => ({ currency: "EUR", prices: [{ grade: "unc", price: 80 }] })),
    ).toEqual({ fetchedAt: NOW, valueMinor: 8000 });
  });
});
