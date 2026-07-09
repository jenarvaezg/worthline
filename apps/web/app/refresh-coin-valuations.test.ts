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
    revalue: vi.fn(async () => [
      {
        id: "pos-1",
        metalValueMinor: 3000,
        numismaticValueMinor: 7558,
        numismaticFetchedAt: NOW,
      },
    ]),
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

  it("keeps last-known and marks stale on outage (no throw), reporting the error", async () => {
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
