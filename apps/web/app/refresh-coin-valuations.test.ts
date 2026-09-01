/**
 * Coin-valuation refresh orchestration (PRD #160 / #166, ADR 0017).
 *
 * The decoupled valuation pass that rides the dashboard's stale-price refresh:
 * for each connected coin source whose freshness has lapsed, re-derive its coin
 * values and persist them; on a Numista outage keep the last-known value and mark
 * the source stale (it retries next pass) instead of throwing. Every effect is
 * injected, so the staleness gate and outage handling are tested without I/O.
 */
import type { AssetPrice, CoinPosition } from "@worthline/domain";
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
    // the source must still read stale, since the pass never finished.
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

    expect(d.persist).toHaveBeenNthCalledWith(1, "src-1", [banked], {
      fetchedAt: twoDaysAgo, // still due: the pass had not finished
      freshnessState: "stale",
    });
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
