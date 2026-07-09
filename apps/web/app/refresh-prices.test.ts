/**
 * Tests for the shared price-refresh orchestration (issue #67).
 *
 * refreshAndPersistStalePrices: determine stale → fetch → persist.
 * The dashboard page (/) delegates to this via loadDashboard, which refreshes
 * prices before capturing the daily snapshot (#153 collapsed /inversiones).
 */
import { describe, expect, test, vi } from "vitest";

import type { AssetPrice } from "@worthline/domain";
import type { InvestmentAssetRef, RefreshStalePricesResult } from "@worthline/pricing";

import type { RefreshAndPersistInput } from "./refresh-prices";
import { refreshAndPersistStalePrices } from "./refresh-prices";

// ---------------------------------------------------------------------------
// Helpers / stubs
// ---------------------------------------------------------------------------

function makePrice(
  assetId: string,
  state: AssetPrice["freshnessState"] = "fresh",
): AssetPrice {
  return {
    assetId,
    currency: "EUR",
    fetchedAt: "2026-06-09T10:00:00Z",
    freshnessState: state,
    price: "100",
    source: "stooq",
  };
}

function makeAssetRef(id: string, symbol = "TEST.WA"): InvestmentAssetRef {
  return { id, currency: "EUR", providerSymbol: symbol };
}

// ---------------------------------------------------------------------------
// refreshAndPersistStalePrices
// ---------------------------------------------------------------------------

describe("refreshAndPersistStalePrices", () => {
  test("calls refreshStalePrices with cache, assets, and nowIso", async () => {
    const price = makePrice("asset-1");
    const asset = makeAssetRef("asset-1");
    const refreshResult: RefreshStalePricesResult = {
      refreshed: [price],
      updated: 1,
      failedSymbols: [],
      failures: [],
    };

    const refreshStalePrices = vi.fn().mockResolvedValue(refreshResult);
    const upsertPrices = vi.fn();
    const readCache = vi.fn().mockReturnValue([price]);

    const input: RefreshAndPersistInput = {
      cacheEntries: [makePrice("asset-1", "stale")],
      assets: [asset],
      nowIso: "2026-06-09T10:00:00Z",
      refreshStalePrices,
      upsertPrices,
      readCache,
    };

    const result = await refreshAndPersistStalePrices(input);

    expect(refreshStalePrices).toHaveBeenCalledWith(
      input.cacheEntries,
      input.assets,
      input.nowIso,
    );
    expect(upsertPrices).toHaveBeenCalledWith([price]);
    expect(readCache).toHaveBeenCalledOnce();
    expect(result.priceCache).toEqual([price]);
    expect(result.errors).toEqual([]);
  });

  test("returns empty errors and current cache when nothing is stale", async () => {
    const price = makePrice("asset-1");
    const refreshResult: RefreshStalePricesResult = {
      refreshed: [],
      updated: 0,
      failedSymbols: [],
      failures: [],
    };

    const refreshStalePrices = vi.fn().mockResolvedValue(refreshResult);
    const upsertPrices = vi.fn();
    const readCache = vi.fn().mockReturnValue([price]);

    const input: RefreshAndPersistInput = {
      cacheEntries: [price],
      assets: [makeAssetRef("asset-1")],
      nowIso: "2026-06-09T10:00:00Z",
      refreshStalePrices,
      upsertPrices,
      readCache,
    };

    const result = await refreshAndPersistStalePrices(input);

    expect(upsertPrices).not.toHaveBeenCalled();
    expect(result.priceCache).toEqual([price]);
    expect(result.errors).toEqual([]);
  });

  test("surfaces failed symbols in errors so callers can handle them", async () => {
    const failedPrice = makePrice("asset-1", "failed");
    const refreshResult: RefreshStalePricesResult = {
      refreshed: [failedPrice],
      updated: 0,
      failedSymbols: ["TEST.WA"],
      failures: [{ symbol: "TEST.WA", reason: "El proveedor no devolvió cotización" }],
    };

    const refreshStalePrices = vi.fn().mockResolvedValue(refreshResult);
    const upsertPrices = vi.fn();
    const readCache = vi.fn().mockReturnValue([failedPrice]);

    const input: RefreshAndPersistInput = {
      cacheEntries: [makePrice("asset-1", "stale")],
      assets: [makeAssetRef("asset-1")],
      nowIso: "2026-06-09T10:00:00Z",
      refreshStalePrices,
      upsertPrices,
      readCache,
    };

    const result = await refreshAndPersistStalePrices(input);

    expect(upsertPrices).toHaveBeenCalledWith([failedPrice]);
    expect(result.errors).toEqual(["TEST.WA"]);
    expect(result.priceCache).toEqual([failedPrice]);
  });

  test("silently degrades when refreshStalePrices throws — returns current cache, errors list", async () => {
    const cachedPrice = makePrice("asset-1");
    const refreshStalePrices = vi.fn().mockRejectedValue(new Error("network error"));
    const upsertPrices = vi.fn();
    const readCache = vi.fn().mockReturnValue([cachedPrice]);

    const input: RefreshAndPersistInput = {
      cacheEntries: [makePrice("asset-1", "stale")],
      assets: [makeAssetRef("asset-1")],
      nowIso: "2026-06-09T10:00:00Z",
      refreshStalePrices,
      upsertPrices,
      readCache,
    };

    const result = await refreshAndPersistStalePrices(input);

    expect(upsertPrices).not.toHaveBeenCalled();
    // cache is read regardless so pages always get current state
    expect(readCache).toHaveBeenCalledOnce();
    expect(result.priceCache).toEqual([cachedPrice]);
    // error is surfaced for future consumers (#69)
    expect(result.errors).toEqual(["network error"]);
  });

  test("does not call upsertPrices when refreshed list is empty", async () => {
    const refreshResult: RefreshStalePricesResult = {
      refreshed: [],
      updated: 0,
      failedSymbols: [],
      failures: [],
    };
    const refreshStalePrices = vi.fn().mockResolvedValue(refreshResult);
    const upsertPrices = vi.fn();
    const readCache = vi.fn().mockReturnValue([]);

    const input: RefreshAndPersistInput = {
      cacheEntries: [],
      assets: [],
      nowIso: "2026-06-09T10:00:00Z",
      refreshStalePrices,
      upsertPrices,
      readCache,
    };

    await refreshAndPersistStalePrices(input);
    expect(upsertPrices).not.toHaveBeenCalled();
  });
});
