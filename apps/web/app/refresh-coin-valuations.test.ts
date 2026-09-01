/**
 * Coin-valuation refresh orchestration (PRD #160 / #166, ADR 0017).
 *
 * The decoupled valuation pass that rides the dashboard's stale-price refresh:
 * for each connected coin source whose freshness has lapsed, re-derive its coin
 * values and persist them; on a Numista outage keep the last-known value and mark
 * the source stale (it retries next pass) instead of throwing. Every effect is
 * injected, so the staleness gate and outage handling are tested without I/O.
 */
import type { ValuationFreshness } from "@worthline/db";
import type { AssetPrice, CoinPosition } from "@worthline/domain";
import { isPriceStale } from "@worthline/domain";
import type { RevaluedPosition } from "@worthline/pricing";
import { refreshCoinValuations } from "@worthline/pricing";
import { describe, expect, it, vi } from "vitest";
import type { CoinSourceRef } from "./refresh-coin-valuations";
import { refreshStaleCoinValuations } from "./refresh-coin-valuations";

const NOW = "2026-06-15T12:00:00.000Z";

function freshness(overrides: Partial<AssetPrice> = {}): AssetPrice {
  return {
    assetId: "coin-asset",
    currency: "EUR",
    fetchedAt: NOW,
    freshnessState: "fresh",
    price: "10000",
    source: "numista",
    ...overrides,
  };
}

function position(): CoinPosition {
  return {
    kind: "coin",
    catalogueId: "1493",
    currency: "EUR",
    externalId: "ext-1493",
    finenessMillis: 999,
    grade: "unc",
    id: "pos-1",
    issueId: 32723,
    liquidityTier: "illiquid",
    metal: "silver",
    metalValueMinor: 2797,
    name: "Silver Eagle",
    numismaticFetchedAt: NOW,
    numismaticValueMinor: 7558,
    obverseThumbUrl: null,
    purchaseDate: null,
    purchasePriceMinor: null,
    quantity: 1,
    sourceId: "src-1",
    weightGrams: 31.103,
    year: 2021,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    nowIso: NOW,
    sources: [{ sourceId: "src-1", freshness: freshness() }],
    readPositions: vi.fn(() => [position()]),
    revalue: vi.fn(async () => ({
      error: null,
      updates: [
        {
          id: "pos-1",
          metalValueMinor: 3000,
          numismaticValueMinor: 7558,
          numismaticFetchedAt: NOW,
        },
      ],
    })),
    persist: vi.fn(),
    ...overrides,
  };
}

describe("refreshStaleCoinValuations", () => {
  it("revalues and persists a fresh outcome when the source is stale", async () => {
    const twoDaysAgo = "2026-06-13T12:00:00.000Z";
    const d = deps({
      sources: [
        {
          sourceId: "src-1",
          freshness: freshness({ fetchedAt: twoDaysAgo }),
        },
      ] satisfies CoinSourceRef[],
    });

    const result = await refreshStaleCoinValuations(d);

    expect(d.revalue).toHaveBeenCalledTimes(1);
    expect(d.persist).toHaveBeenCalledWith(
      "src-1",
      [
        {
          id: "pos-1",
          metalValueMinor: 3000,
          numismaticValueMinor: 7558,
          numismaticFetchedAt: NOW,
        },
      ],
      { fetchedAt: NOW, freshnessState: "fresh" },
    );
    expect(result.errors).toEqual([]);
  });

  it("treats a never-valued source (no freshness row) as stale", async () => {
    const d = deps({
      sources: [{ sourceId: "src-1", freshness: null }] satisfies CoinSourceRef[],
    });

    await refreshStaleCoinValuations(d);

    expect(d.revalue).toHaveBeenCalledTimes(1);
  });

  it("skips a source whose valuation is still fresh", async () => {
    const d = deps(); // freshness fetchedAt = NOW → within the daily TTL

    await refreshStaleCoinValuations(d);

    expect(d.revalue).not.toHaveBeenCalled();
    expect(d.persist).not.toHaveBeenCalled();
  });

  it("hands the pass a checkpoint that banks coins while leaving the source due", async () => {
    // #1739: a pass can be killed with no exception to catch (~80 sequential Numista
    // calls), so what it resolved must already be written when that happens — and
    // the source must still read due, since the pass never finished.
    const twoDaysAgo = "2026-06-13T12:00:00.000Z";
    const banked = {
      id: "pos-1",
      metalValueMinor: 3000,
      numismaticValueMinor: 7558,
      numismaticFetchedAt: NOW,
    };
    const d = deps({
      sources: [
        { sourceId: "src-1", freshness: freshness({ fetchedAt: twoDaysAgo }) },
      ] satisfies CoinSourceRef[],
      revalue: vi.fn(
        async (
          _sourceId: string,
          _positions: unknown,
          _nowIso: string,
          checkpoint: (updates: unknown[]) => Promise<void>,
        ) => {
          await checkpoint([banked]);
          return { error: null, updates: [banked] };
        },
      ),
    });

    await refreshStaleCoinValuations(d);

    // The row is left ALONE mid-pass (null): the gate reads its `fetchedAt` and
    // ignores `freshnessState`, so any stamp here would read as valued today.
    expect(d.persist).toHaveBeenNthCalledWith(1, "src-1", [banked], null);
    // The final write is the fresh one, once the pass came back clean.
    expect(d.persist).toHaveBeenNthCalledWith(2, "src-1", [banked], {
      fetchedAt: NOW,
      freshnessState: "fresh",
    });
  });

  it("persists what the pass already resolved when it dies midway", async () => {
    // #1739: the coins the pass had already bought from Numista must survive the
    // failure, or the retry (the source stays stale) buys the collection again.
    const twoDaysAgo = "2026-06-13T12:00:00.000Z";
    const partial = {
      id: "pos-1",
      metalValueMinor: 3000,
      numismaticValueMinor: 7558,
      numismaticFetchedAt: NOW,
    };
    const d = deps({
      sources: [
        { sourceId: "src-1", freshness: freshness({ fetchedAt: twoDaysAgo }) },
      ] satisfies CoinSourceRef[],
      revalue: vi.fn(async () => ({
        error: new Error("Numista 500"),
        updates: [partial],
      })),
    });

    const result = await refreshStaleCoinValuations(d);

    expect(d.persist).toHaveBeenCalledWith(
      "src-1",
      [partial],
      expect.objectContaining({
        fetchedAt: twoDaysAgo, // prior stamp kept → the source stays stale
        freshnessState: "stale",
        staleReason: expect.any(String),
      }),
    );
    expect(result.errors).toEqual(["Numista 500"]);
  });

  it("falls back to the stale branch when the fresh write itself fails", async () => {
    // A failed write is a failed refresh: it must be reported and leave the source
    // stale, never escape into the dashboard render that awaits this pass.
    const persist = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("write failed");
      })
      .mockImplementation(() => {});
    const d = deps({
      persist,
      sources: [
        {
          sourceId: "src-1",
          freshness: freshness({ fetchedAt: "2026-06-13T12:00:00.000Z" }),
        },
      ] satisfies CoinSourceRef[],
    });

    const result = await refreshStaleCoinValuations(d);

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]?.[2]).toMatchObject({ freshnessState: "stale" });
    expect(result.errors).toEqual(["write failed"]);
  });

  it("reports a store that fails both writes instead of stopping the other sources", async () => {
    const persist = vi.fn(() => {
      throw new Error("store down");
    });
    const d = deps({
      persist,
      sources: [
        {
          sourceId: "src-1",
          freshness: freshness({ fetchedAt: "2026-06-13T12:00:00.000Z" }),
        },
        {
          sourceId: "src-2",
          freshness: freshness({ fetchedAt: "2026-06-13T12:00:00.000Z" }),
        },
      ] satisfies CoinSourceRef[],
    });

    const result = await refreshStaleCoinValuations(d);

    // Both sources were attempted (2 writes each: the fresh one, then the stale
    // retry), and nothing escaped into the dashboard render that awaits this.
    expect(persist).toHaveBeenCalledTimes(4);
    expect(result.errors).toEqual([
      "store down",
      "store down",
      "store down",
      "store down",
    ]);
  });

  it("keeps last-known and marks stale when the pass throws before valuing anything", async () => {
    const twoDaysAgo = "2026-06-13T12:00:00.000Z";
    const d = deps({
      sources: [
        {
          sourceId: "src-1",
          freshness: freshness({ fetchedAt: twoDaysAgo }),
        },
      ] satisfies CoinSourceRef[],
      revalue: vi.fn(async () => {
        throw new Error("Numista unreachable");
      }),
    });

    const result = await refreshStaleCoinValuations(d);

    // No position changes (keep last-known); freshness row marked stale w/ reason.
    expect(d.persist).toHaveBeenCalledWith(
      "src-1",
      [],
      expect.objectContaining({
        freshnessState: "stale",
        staleReason: expect.any(String),
      }),
    );
    expect(result.errors.length).toBe(1);
  });
});

/**
 * The two passes end to end (#1739), across the real seam: the store the failed
 * pass wrote to is the store the NEXT pass reads from. The unit tests above stub
 * `revalue`; this one runs the real `refreshCoinValuations` against an in-memory
 * store, which is the only way to show that what a half-finished pass banked is
 * what stops the retry from buying those coins again.
 */
describe("refreshStaleCoinValuations + refreshCoinValuations, two passes", () => {
  const STALE_STAMP = "2026-05-01T12:00:00.000Z"; // 45 days before NOW → past the TTL
  const TWO_DAYS_AGO = "2026-06-13T12:00:00.000Z";

  function coinPrices() {
    return { currency: "EUR", prices: [{ grade: "unc", price: 75.585 }] };
  }

  it("leaves a never-valued source still due while a tranche is banked", async () => {
    // A freshly connected 78-coin collection has no freshness row at all, and that
    // is the priciest pass there is: every coin still to buy. If a tranche stamped
    // a row with "now", the gate (which reads `fetchedAt` only, ignoring
    // `freshnessState`) would call the collection fresh with most coins unbought,
    // and a death right there would park them for a whole day.
    const stored: CoinPosition[] = [1, 2].map((n) => ({
      ...position(),
      id: `pos-${n}`,
      issueId: 32720 + n,
      metalValueMinor: 2797,
      numismaticFetchedAt: null, // never fetched
      numismaticValueMinor: null,
    }));
    let row: AssetPrice | null = null; // never valued
    let checkedMidPass = false;

    const persist = (
      _sourceId: string,
      updates: RevaluedPosition[],
      next: ValuationFreshness | null,
    ): void => {
      for (const update of updates) {
        const coin = stored.find((candidate) => candidate.id === update.id);
        if (coin) {
          coin.numismaticFetchedAt = update.numismaticFetchedAt;
        }
      }
      if (next !== null) {
        row = freshness({
          fetchedAt: next.fetchedAt,
          freshnessState: next.freshnessState,
        });
      }
    };

    const banked = {
      id: "pos-1",
      metalValueMinor: 2797,
      numismaticValueMinor: 7558,
      numismaticFetchedAt: NOW,
    };

    await refreshStaleCoinValuations({
      nowIso: NOW,
      persist,
      readPositions: () => stored.map((coin) => ({ ...coin })),
      sources: [{ sourceId: "src-1", freshness: row }],
      revalue: async (_sourceId, _positions, _now, checkpoint) => {
        await checkpoint([banked]);

        // This is the instant the process goes away — nothing below it would run
        // in that scenario, so the state HERE is what the next pass would find.
        expect(stored[0]?.numismaticFetchedAt).toBe(NOW); // coin 1 is banked
        expect(isPriceStale(row, NOW)).toBe(true); // and the source is still due
        checkedMidPass = true;

        return { error: null, updates: [banked] };
      },
    });

    expect(checkedMidPass).toBe(true);
    // Once the pass DID finish, the row is stamped fresh — as before.
    expect(isPriceStale(row, NOW)).toBe(false);
  });

  it("charges the second pass only for the coin the first never reached", async () => {
    // Three coins past their numismatic TTL, each on its own issue → one call each.
    const stored: CoinPosition[] = [1, 2, 3].map((n) => ({
      ...position(),
      id: `pos-${n}`,
      issueId: 32720 + n,
      metalValueMinor: 2797, // already at the fresh spot → only the estimate moves
      numismaticFetchedAt: STALE_STAMP,
      numismaticValueMinor: 1,
    }));
    let row: AssetPrice = freshness({ fetchedAt: TWO_DAYS_AGO });

    // The store: apply each update by id, and stamp the freshness row.
    const persist = (
      _sourceId: string,
      updates: RevaluedPosition[],
      next: ValuationFreshness | null,
    ): void => {
      for (const update of updates) {
        const coin = stored.find((candidate) => candidate.id === update.id);
        if (coin) {
          coin.metalValueMinor = update.metalValueMinor;
          coin.numismaticValueMinor = update.numismaticValueMinor;
          coin.numismaticFetchedAt = update.numismaticFetchedAt;
        }
      }
      if (next !== null) {
        row = { ...row, fetchedAt: next.fetchedAt, freshnessState: next.freshnessState };
      }
    };

    const pass = (prices: (typeId: number, issueId: number) => Promise<unknown>) =>
      refreshStaleCoinValuations({
        nowIso: NOW,
        persist,
        readPositions: () => stored.map((coin) => ({ ...coin })),
        sources: [{ sourceId: "src-1", freshness: row }],
        revalue: (_sourceId, positions, now, checkpoint) =>
          refreshCoinValuations(
            positions,
            {
              prices: prices as never,
              spotPerOzEur: async () => 28,
            },
            { checkpoint: { every: 1, persist: checkpoint }, nowIso: now },
          ),
      });

    // Pass 1: Numista answers the first two coins, then goes down.
    const first = await pass(async (_typeId, issueId) => {
      if (issueId === 32723) {
        throw new Error("Numista 500");
      }
      return coinPrices();
    });

    expect(first.errors).toEqual(["Numista 500"]);
    // What it paid for is IN THE STORE, and the source still reads due.
    expect(stored.map((coin) => coin.numismaticFetchedAt)).toEqual([
      NOW,
      NOW,
      STALE_STAMP,
    ]);
    expect(row).toMatchObject({ fetchedAt: TWO_DAYS_AGO, freshnessState: "stale" });

    // Pass 2, immediately after, with Numista back.
    const prices = vi.fn(async () => coinPrices());
    const second = await pass(prices);

    expect(second.errors).toEqual([]);
    expect(prices).toHaveBeenCalledTimes(1); // ONE coin, not three
    expect(prices).toHaveBeenCalledWith(1493, 32723);
    expect(stored.every((coin) => coin.numismaticFetchedAt === NOW)).toBe(true);
    expect(row).toMatchObject({ fetchedAt: NOW, freshnessState: "fresh" });
  });
});
