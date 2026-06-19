import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetPrice } from "@worthline/domain";
import { afterEach, describe, expect, test } from "vitest";

import { createWorthlineStore } from "@db/index";
import type { WorthlineStore } from "@db/index";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function createTestStore(): WorthlineStore {
  const dataDir = mkdtempSync(join(tmpdir(), "worthline-prices-"));
  tempDirs.push(dataDir);

  return createWorthlineStore({ databasePath: join(dataDir, "worthline.sqlite") });
}

function seedWorkspaceAndAsset(store: WorthlineStore, assetId: string): void {
  store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Alice" }],
    mode: "individual",
  });
  store.assets.createInvestmentAsset({
    currency: "EUR",
    id: assetId,
    name: "Test Asset",
    ownership: [{ memberId: "m1", shareBps: 10000 }],
  });
}

describe("price cache persistence", () => {
  test("upsertPrice then readPriceCache round-trips AssetPrice", () => {
    const store = createTestStore();
    seedWorkspaceAndAsset(store, "asset_1");

    const price: AssetPrice = {
      assetId: "asset_1",
      currency: "EUR",
      fetchedAt: "2026-06-08T10:00:00Z",
      freshnessState: "fresh",
      price: "123.45",
      source: "stooq",
    };

    store.operations.upsertPrice(price);
    const result = store.operations.readPriceCache("asset_1");

    expect(result).not.toBeNull();
    expect(result!.assetId).toBe("asset_1");
    expect(result!.currency).toBe("EUR");
    expect(result!.price).toBe("123.45");
    expect(result!.source).toBe("stooq");
    expect(result!.fetchedAt).toBe("2026-06-08T10:00:00Z");
    expect(result!.freshnessState).toBe("fresh");

    store.close();
  });

  test("readPriceCache returns null for unknown assetId", () => {
    const store = createTestStore();
    seedWorkspaceAndAsset(store, "asset_1");

    expect(store.operations.readPriceCache("nonexistent")).toBeNull();

    store.close();
  });

  test("upsertPrice overwrites existing entry", () => {
    const store = createTestStore();
    seedWorkspaceAndAsset(store, "asset_1");

    const first: AssetPrice = {
      assetId: "asset_1",
      currency: "EUR",
      fetchedAt: "2026-06-01T00:00:00Z",
      freshnessState: "fresh",
      price: "100.00",
      source: "stooq",
    };
    const second: AssetPrice = {
      assetId: "asset_1",
      currency: "EUR",
      fetchedAt: "2026-06-08T10:00:00Z",
      freshnessState: "stale",
      price: "200.00",
      source: "stooq",
    };

    store.operations.upsertPrice(first);
    store.operations.upsertPrice(second);

    const result = store.operations.readPriceCache("asset_1");
    expect(result!.price).toBe("200.00");
    expect(result!.freshnessState).toBe("stale");
    expect(result!.fetchedAt).toBe("2026-06-08T10:00:00Z");

    store.close();
  });

  test("clearPriceCache removes an asset's cached price", () => {
    const store = createTestStore();
    seedWorkspaceAndAsset(store, "asset_1");

    store.operations.upsertPrice({
      assetId: "asset_1",
      currency: "EUR",
      fetchedAt: "2026-06-08T10:00:00Z",
      freshnessState: "fresh",
      price: "123.45",
      source: "yahoo",
    });

    expect(store.operations.clearPriceCache("asset_1")).toBe(1);
    expect(store.operations.readPriceCache("asset_1")).toBeNull();

    store.close();
  });
});

describe("investment price provider metadata", () => {
  test("readInvestmentAssetsWithMeta applies provider defaults and preserves overrides", () => {
    const store = createTestStore();
    store.workspace.initializeWorkspace({
      members: [{ id: "m1", name: "Alice" }],
      mode: "individual",
    });

    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_market",
      liquidityTier: "market",
      name: "Market ETF",
      ownership: [{ memberId: "m1", shareBps: 10000 }],
      providerSymbol: "VUSA.L",
    });
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_pension",
      liquidityTier: "term-locked",
      name: "Pension Plan",
      ownership: [{ memberId: "m1", shareBps: 10000 }],
      providerSymbol: "N5394",
    });
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_stooq",
      liquidityTier: "market",
      name: "Stooq ETF",
      ownership: [{ memberId: "m1", shareBps: 10000 }],
      priceProvider: "stooq",
      providerSymbol: "VUSA.L",
    });

    const byId = new Map(
      store.assets.readInvestmentAssetsWithMeta().map((asset) => [asset.id, asset]),
    );

    expect(byId.get("asset_market")).toMatchObject({
      liquidityTier: "market",
      priceProvider: "yahoo",
    });
    expect(byId.get("asset_pension")).toMatchObject({
      liquidityTier: "term-locked",
      priceProvider: "finect",
    });
    expect(byId.get("asset_stooq")).toMatchObject({
      liquidityTier: "market",
      priceProvider: "stooq",
    });

    store.close();
  });
});
