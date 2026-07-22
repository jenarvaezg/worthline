import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorthlineStore } from "@db/index";
import { createWorthlineStoreUnsafe } from "@db/unsafe-store";
import type { AssetPrice } from "@worthline/domain";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

async function createTestStore(): Promise<WorthlineStore> {
  const dataDir = mkdtempSync(join(tmpdir(), "worthline-prices-"));
  tempDirs.push(dataDir);

  return createWorthlineStoreUnsafe({ databasePath: join(dataDir, "worthline.sqlite") });
}

async function seedWorkspaceAndAsset(
  store: WorthlineStore,
  assetId: string,
): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Alice" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: assetId,
    name: "Test Asset",
    ownership: [{ memberId: "m1", shareBps: 10000 }],
  });
}

describe("price cache persistence", () => {
  test("upsertPrice then readPriceCache round-trips AssetPrice", async () => {
    const store = await createTestStore();
    await seedWorkspaceAndAsset(store, "asset_1");

    const price: AssetPrice = {
      assetId: "asset_1",
      currency: "EUR",
      fetchedAt: "2026-06-08T10:00:00Z",
      freshnessState: "fresh",
      price: "123.45",
      source: "stooq",
    };

    await store.operations.upsertPrice(price);
    const result = await store.operations.readPriceCache("asset_1");

    expect(result).not.toBeNull();
    expect(result!.assetId).toBe("asset_1");
    expect(result!.currency).toBe("EUR");
    expect(result!.price).toBe("123.45");
    expect(result!.source).toBe("stooq");
    expect(result!.fetchedAt).toBe("2026-06-08T10:00:00Z");
    expect(result!.freshnessState).toBe("fresh");

    store.close();
  });

  test("readPriceCache returns null for unknown assetId", async () => {
    const store = await createTestStore();
    await seedWorkspaceAndAsset(store, "asset_1");

    expect(await store.operations.readPriceCache("nonexistent")).toBeNull();

    store.close();
  });

  test("upsertPrice overwrites existing entry", async () => {
    const store = await createTestStore();
    await seedWorkspaceAndAsset(store, "asset_1");

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

    await store.operations.upsertPrice(first);
    await store.operations.upsertPrice(second);

    const result = await store.operations.readPriceCache("asset_1");
    expect(result!.price).toBe("200.00");
    expect(result!.freshnessState).toBe("stale");
    expect(result!.fetchedAt).toBe("2026-06-08T10:00:00Z");

    store.close();
  });

  test("upsertPrices batch round-trips multiple assets", async () => {
    const store = await createTestStore();
    await seedWorkspaceAndAsset(store, "asset_1");
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_2",
      name: "Second Asset",
      ownership: [{ memberId: "m1", shareBps: 10000 }],
    });

    await store.operations.upsertPrices([
      {
        assetId: "asset_1",
        currency: "EUR",
        fetchedAt: "2026-06-08T10:00:00Z",
        freshnessState: "fresh",
        price: "100.00",
        source: "stooq",
      },
      {
        assetId: "asset_2",
        currency: "EUR",
        fetchedAt: "2026-06-08T11:00:00Z",
        freshnessState: "fresh",
        price: "200.00",
        source: "yahoo",
      },
    ]);

    expect((await store.operations.readPriceCache("asset_1"))!.price).toBe("100.00");
    expect((await store.operations.readPriceCache("asset_2"))!.price).toBe("200.00");

    store.close();
  });

  test("clearPriceCache removes an asset's cached price", async () => {
    const store = await createTestStore();
    await seedWorkspaceAndAsset(store, "asset_1");

    await store.operations.upsertPrice({
      assetId: "asset_1",
      currency: "EUR",
      fetchedAt: "2026-06-08T10:00:00Z",
      freshnessState: "fresh",
      price: "123.45",
      source: "yahoo",
    });

    expect(await store.operations.clearPriceCache("asset_1")).toBe(1);
    expect(await store.operations.readPriceCache("asset_1")).toBeNull();

    store.close();
  });
});

describe("investment price provider metadata", () => {
  test("readInvestmentAssetsWithMeta applies provider defaults and preserves overrides", async () => {
    const store = await createTestStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "m1", name: "Alice" }],
      mode: "individual",
    });

    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_market",
      liquidityTier: "market",
      name: "Market ETF",
      ownership: [{ memberId: "m1", shareBps: 10000 }],
      providerSymbol: "VUSA.L",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_pension",
      liquidityTier: "term-locked",
      name: "Pension Plan",
      ownership: [{ memberId: "m1", shareBps: 10000 }],
      providerSymbol: "N5394",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_stooq",
      liquidityTier: "market",
      name: "Stooq ETF",
      ownership: [{ memberId: "m1", shareBps: 10000 }],
      priceProvider: "stooq",
      providerSymbol: "VUSA.L",
    });

    const byId = new Map(
      (await store.assets.readInvestmentAssetsWithMeta()).map((asset) => [
        asset.id,
        asset,
      ]),
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
