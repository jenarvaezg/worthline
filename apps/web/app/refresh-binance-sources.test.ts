/**
 * Binance live-revalue orchestration (PRD #245 S4, issue #249, ADR 0007/0021).
 *
 * The decoupled Binance pass that rides the dashboard's stale-price refresh: for
 * each connected Binance source whose freshness has lapsed (daily TTL), re-read
 * the account's balances and re-value them live, then persist; on a Binance
 * outage keep the last-known value and mark the source stale (it retries next
 * pass) instead of throwing. Every effect is injected, so the staleness gate and
 * outage handling are tested without I/O.
 */
import type { AssetPrice } from "@worthline/domain";
import type { TokenPositionDraft } from "@worthline/pricing";
import { describe, expect, it, vi } from "vitest";

import { refreshStaleBinanceSources } from "./refresh-binance-sources";
import type { BinanceSourceRef } from "./refresh-binance-sources";

const NOW = "2026-06-16T12:00:00.000Z";
const TWO_DAYS_AGO = "2026-06-14T12:00:00.000Z";

function freshness(overrides: Partial<AssetPrice> = {}): AssetPrice {
  return {
    assetId: "binance-asset",
    currency: "EUR",
    fetchedAt: NOW,
    freshnessState: "fresh",
    price: "0",
    source: "binance",
    ...overrides,
  };
}

function draft(): TokenPositionDraft {
  return {
    kind: "token",
    externalId: "BTC:spot",
    name: "BTC",
    symbol: "BTC",
    balance: "0.5",
    wallet: "spot",
    liquidityTier: "market",
    unitPrice: "50000",
    imageUrl: null,
    currency: "EUR",
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    nowIso: NOW,
    sources: [{ sourceId: "src-1", freshness: freshness() }] satisfies BinanceSourceRef[],
    reSync: vi.fn(async () => [draft()]),
    persistFresh: vi.fn(),
    persistStale: vi.fn(),
    ...overrides,
  };
}

describe("refreshStaleBinanceSources", () => {
  it("re-syncs and persists a fresh outcome when the source is stale", async () => {
    const d = deps({
      sources: [
        {
          sourceId: "src-1",
          freshness: freshness({ fetchedAt: TWO_DAYS_AGO }),
        },
      ] satisfies BinanceSourceRef[],
    });

    const result = await refreshStaleBinanceSources(d);

    expect(d.reSync).toHaveBeenCalledTimes(1);
    expect(d.reSync).toHaveBeenCalledWith("src-1");
    expect(d.persistFresh).toHaveBeenCalledWith("src-1", [draft()]);
    expect(d.persistStale).not.toHaveBeenCalled();
    expect(result.errors).toEqual([]);
  });

  it("treats a never-valued source (no freshness row) as stale", async () => {
    const d = deps({
      sources: [{ sourceId: "src-1", freshness: null }] satisfies BinanceSourceRef[],
    });

    await refreshStaleBinanceSources(d);

    expect(d.reSync).toHaveBeenCalledTimes(1);
    expect(d.persistFresh).toHaveBeenCalledTimes(1);
  });

  it("skips a source whose valuation is still fresh", async () => {
    const d = deps(); // freshness fetchedAt = NOW → within the daily TTL

    await refreshStaleBinanceSources(d);

    expect(d.reSync).not.toHaveBeenCalled();
    expect(d.persistFresh).not.toHaveBeenCalled();
    expect(d.persistStale).not.toHaveBeenCalled();
  });

  it("keeps last-known and marks stale on outage (no throw), reporting the error", async () => {
    const d = deps({
      sources: [
        {
          sourceId: "src-1",
          freshness: freshness({ fetchedAt: TWO_DAYS_AGO }),
        },
      ] satisfies BinanceSourceRef[],
      reSync: vi.fn(async () => {
        throw new Error("Binance unreachable");
      }),
    });

    const result = await refreshStaleBinanceSources(d);

    // Last-known value kept (no fresh persist); freshness row marked stale,
    // carrying the PRIOR fetched-at so the next pass retries it.
    expect(d.persistFresh).not.toHaveBeenCalled();
    expect(d.persistStale).toHaveBeenCalledWith(
      "src-1",
      TWO_DAYS_AGO,
      expect.any(String),
    );
    expect(result.errors).toHaveLength(1);
  });

  it("passes a null prior fetched-at to persistStale when a never-valued source errors", async () => {
    const d = deps({
      sources: [{ sourceId: "src-1", freshness: null }] satisfies BinanceSourceRef[],
      reSync: vi.fn(async () => {
        throw new Error("Binance unreachable");
      }),
    });

    await refreshStaleBinanceSources(d);

    expect(d.persistStale).toHaveBeenCalledWith("src-1", null, expect.any(String));
  });

  it("a persist failure is NOT an outage: it reports a distinct error and never marks stale", async () => {
    // Binance WAS reachable (reSync resolved); a local write failure must not
    // masquerade as an outage nor mark the source stale (positions may be written).
    const d = deps({
      sources: [
        {
          sourceId: "src-1",
          freshness: freshness({ fetchedAt: TWO_DAYS_AGO }),
        },
      ] satisfies BinanceSourceRef[],
      persistFresh: vi.fn(() => {
        throw new Error("db write failed");
      }),
    });

    const result = await refreshStaleBinanceSources(d);

    expect(d.reSync).toHaveBeenCalledOnce();
    expect(d.persistStale).not.toHaveBeenCalled(); // never downgraded to a stale outage
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("guardar"); // distinct "could not save" message
  });
});
