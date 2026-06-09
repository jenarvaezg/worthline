import { describe, expect, test } from "vitest";

import type { AssetPrice } from "./prices";
import { getPriceFreshness, PRICE_TTL_DAYS, selectStalePrices } from "./prices";

function makeEntry(overrides: Partial<AssetPrice>): AssetPrice {
  return {
    assetId: "asset-1",
    currency: "EUR",
    fetchedAt: "2026-06-08T10:00:00Z",
    freshnessState: "fresh",
    price: "100",
    source: "stooq",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// selectStalePrices — unified per-source TTL rule
// ---------------------------------------------------------------------------

describe("selectStalePrices (per-source TTL)", () => {
  test("empty cache returns empty list", () => {
    expect(selectStalePrices([], "2026-06-09T10:00:00Z")).toEqual([]);
  });

  test("stooq entry within 1-day TTL is not selected", () => {
    const entry = makeEntry({ source: "stooq", fetchedAt: "2026-06-09T08:00:00Z" });
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([]);
  });

  test("stooq entry exactly at 1-day TTL boundary is stale", () => {
    const entry = makeEntry({ source: "stooq", fetchedAt: "2026-06-08T10:00:00Z" });
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([entry]);
  });

  test("ecb entry exactly at 1-day TTL boundary is stale", () => {
    const entry = makeEntry({ source: "ecb", fetchedAt: "2026-06-08T10:00:00Z" });
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([entry]);
  });

  test("coingecko entry exactly at 1-day TTL boundary is stale", () => {
    const entry = makeEntry({ source: "coingecko", fetchedAt: "2026-06-08T10:00:00Z" });
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([entry]);
  });

  test("manual source entries are never stale (manual quotes are permanent)", () => {
    const entry = makeEntry({
      source: "manual",
      freshnessState: "manual",
      fetchedAt: "2020-01-01T00:00:00Z",
    });
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([]);
  });

  test("manual source respects its 30-day TTL tier: within 30 days is fresh", () => {
    // manual entries are excluded by freshnessState guard, but if we had a
    // non-manual freshnessState with source=manual the 30d TTL would apply
    const entry = makeEntry({
      source: "manual",
      freshnessState: "fresh",
      fetchedAt: "2026-05-20T00:00:00Z",
    });
    // 20 days old — within the 30-day manual TTL → not stale
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([]);
  });

  test("failed entries are never selected (already in error state)", () => {
    const entry = makeEntry({
      fetchedAt: "2020-01-01T00:00:00Z",
      freshnessState: "failed",
    });
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([]);
  });

  test("selects only stale entries from a mixed list", () => {
    const stale = makeEntry({ assetId: "asset-stale", source: "stooq", fetchedAt: "2026-06-07T00:00:00Z" });
    const fresh = makeEntry({ assetId: "asset-fresh", source: "stooq", fetchedAt: "2026-06-09T09:00:00Z" });
    const manual = makeEntry({ assetId: "asset-manual", source: "manual", freshnessState: "manual", fetchedAt: "2020-01-01T00:00:00Z" });
    const failed = makeEntry({ assetId: "asset-failed", fetchedAt: "2020-01-01T00:00:00Z", freshnessState: "failed" });

    expect(selectStalePrices([stale, fresh, manual, failed], "2026-06-09T10:00:00Z")).toEqual([stale]);
  });

  test("entry just under 1-day TTL is not stale", () => {
    // 23h59m59s old — still fresh for stooq (1-day TTL)
    const entry = makeEntry({ source: "stooq", fetchedAt: "2026-06-08T10:00:01Z" });
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([]);
  });

  test("PRICE_TTL_DAYS defines the per-source TTL values", () => {
    expect(PRICE_TTL_DAYS.manual).toBe(30);
    expect(PRICE_TTL_DAYS.ecb).toBe(1);
    expect(PRICE_TTL_DAYS.coingecko).toBe(1);
    expect(PRICE_TTL_DAYS.stooq).toBe(1);
  });
});

describe("getPriceFreshness", () => {
  test("manual source always returns 'manual' regardless of age", () => {
    expect(
      getPriceFreshness(
        { fetchedAt: "2025-01-01", freshnessState: "manual", source: "manual" },
        "2026-01-01",
      ),
    ).toBe("manual");
  });

  test("stooq price fetched within TTL returns 'fresh'", () => {
    expect(
      getPriceFreshness(
        { fetchedAt: "2026-06-08T10:00:00Z", freshnessState: "fresh", source: "stooq" },
        "2026-06-08T22:00:00Z",
      ),
    ).toBe("fresh");
  });

  test("stooq price older than 1 day returns 'stale'", () => {
    expect(
      getPriceFreshness(
        { fetchedAt: "2026-06-07T10:00:00Z", freshnessState: "fresh", source: "stooq" },
        "2026-06-09T10:00:00Z",
      ),
    ).toBe("stale");
  });

  test("failed state returns 'failed' regardless of source or age", () => {
    expect(
      getPriceFreshness(
        { fetchedAt: "2026-06-01", freshnessState: "failed", source: "stooq" },
        "2026-06-09",
      ),
    ).toBe("failed");
  });
});
