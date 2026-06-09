/**
 * Legacy test file kept for historical reference.
 * The selectStalePrices tests now live in prices.test.ts (issue #67).
 *
 * This file re-imports from the canonical location to ensure the re-export
 * shim in price-staleness.ts still works for any consumers not yet migrated.
 */
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

describe("selectStalePrices (via price-staleness re-export shim)", () => {
  test("re-export still works: stale entry is selected", () => {
    const entry = makeEntry({ fetchedAt: "2026-06-07T00:00:00Z" });
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([entry]);
  });

  test("re-export still works: manual entry is never selected", () => {
    const entry = makeEntry({
      fetchedAt: "2020-01-01T00:00:00Z",
      freshnessState: "manual",
      source: "manual",
    });
    expect(selectStalePrices([entry], "2026-06-09T10:00:00Z")).toEqual([]);
  });
});
