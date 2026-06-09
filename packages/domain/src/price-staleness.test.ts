import { describe, expect, test } from "vitest";

import type { AssetPrice } from "./prices";
import { selectStalePrices } from "./price-staleness";

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

describe("selectStalePrices", () => {
  test("empty cache returns empty list", () => {
    expect(selectStalePrices([], "2026-06-09T10:00:00Z")).toEqual([]);
  });

  test("fresh entry (< 24h old) is not selected", () => {
    const entry = makeEntry({ fetchedAt: "2026-06-09T08:00:00Z" });
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([]);
  });

  test("entry exactly 24h old is considered stale", () => {
    const entry = makeEntry({ fetchedAt: "2026-06-08T10:00:00Z" });
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([entry]);
  });

  test("entry older than 24h is selected", () => {
    const entry = makeEntry({ fetchedAt: "2026-06-07T00:00:00Z" });
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([entry]);
  });

  test("manual source entries are never selected (manual quotes stay forever)", () => {
    const entry = makeEntry({
      fetchedAt: "2020-01-01T00:00:00Z",
      freshnessState: "manual",
      source: "manual",
    });
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
    const stale = makeEntry({
      assetId: "asset-stale",
      fetchedAt: "2026-06-07T00:00:00Z",
    });
    const fresh = makeEntry({
      assetId: "asset-fresh",
      fetchedAt: "2026-06-09T09:00:00Z",
    });
    const manual = makeEntry({
      assetId: "asset-manual",
      fetchedAt: "2020-01-01T00:00:00Z",
      freshnessState: "manual",
      source: "manual",
    });
    const failed = makeEntry({
      assetId: "asset-failed",
      fetchedAt: "2020-01-01T00:00:00Z",
      freshnessState: "failed",
    });

    expect(selectStalePrices([stale, fresh, manual, failed], "2026-06-09T10:00:00Z")).toEqual([
      stale,
    ]);
  });

  test("entry just under 24h old is not selected", () => {
    // 23h59m59s old — still fresh
    const entry = makeEntry({ fetchedAt: "2026-06-08T10:00:01Z" });
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([]);
  });
});
