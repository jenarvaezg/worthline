/**
 * Connected-source persistence (PRD #160 / #163, ADR 0016/0017).
 *
 * Integration tests against a real in-memory store: `connect` materializes a
 * derived coin-collection holding, `syncPositions` replaces positions and
 * re-rolls the holding's value from its positions (never hand-set), token round
 * trips, and the v19 migration creates the two tables.
 */

import type { WorthlineStore } from "@db/index";
import { createInMemoryStore, openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import {
  type BinanceHistoryCurve,
  type CoinPosition,
  type DecimalString,
  isValueUpdateEligible,
  type ManualAsset,
  parseWorkspaceExport,
  type SourcePosition,
  valuationMethodOfAsset,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

const asCoin = (p: SourcePosition): CoinPosition => {
  if (p.kind !== "coin") throw new Error("expected coin");
  return p;
};

const MEMBER_ID = "mJ";

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
}

/** A position to sync, with sensible defaults the test can override. */
function position(
  overrides: Partial<Omit<CoinPosition, "id" | "sourceId">> = {},
): Omit<CoinPosition, "id" | "sourceId"> {
  return {
    kind: "coin",
    catalogueId: "n123",
    currency: "EUR",
    externalId: overrides.catalogueId ?? "n123",
    finenessMillis: null,
    grade: "VF",
    issueId: null,
    liquidityTier: "illiquid",
    metal: "silver",
    metalValueMinor: null,
    name: "8 reales",
    numismaticFetchedAt: null,
    numismaticValueMinor: null,
    obverseThumbUrl: null,
    purchaseDate: "2024-01-01",
    purchasePriceMinor: 5_000,
    quantity: 1,
    weightGrams: null,
    year: null,
    ...overrides,
  };
}

const ownerAll = [{ memberId: MEMBER_ID, shareBps: 10_000 }];

async function connectNumista(
  store: WorthlineStore,
): Promise<{ sourceId: string; assetId: string }> {
  return await store.connectedSources.connect({
    adapter: "numista",
    credentialsJson: JSON.stringify({ apiKey: "secret" }),
    label: "Colección Numista",
    ownership: ownerAll,
  });
}

async function holding(store: WorthlineStore, assetId: string): Promise<ManualAsset> {
  const asset = (await store.assets.readAssets()).find((a) => a.id === assetId);
  expect(asset).toBeDefined();
  return asset!;
}

async function connectBinance(
  store: WorthlineStore,
): Promise<{ sourceId: string; assetId: string }> {
  return await store.connectedSources.connect({
    adapter: "binance",
    label: "Binance",
    credentialsJson: JSON.stringify({ apiKey: "k", apiSecret: "s" }),
    ownership: ownerAll,
  });
}

/** A Binance token-position draft to sync, with sensible market-spot defaults. */
const tk = (o: Partial<SourcePosition> & { kind?: "token" }) => ({
  kind: "token" as const,
  externalId: "BTC:spot",
  name: "BTC",
  symbol: "BTC",
  balance: "0.5",
  wallet: "spot",
  liquidityTier: "market" as const,
  unitPrice: "50000",
  imageUrl: null as string | null,
  currency: "EUR" as const,
  ...o,
});

/** A Binance history curve from per-month BTC balances + per-date BTC prices —
 *  enough to freeze a monthly-close snapshot row at a completed past month. */
function btcCurve(input: {
  monthEndBalances: Record<string, DecimalString>;
  dailyPrices: Record<string, DecimalString>;
}): BinanceHistoryCurve {
  return {
    monthEndBalances: new Map([["BTC", new Map(Object.entries(input.monthEndBalances))]]),
    dailyPriceBySymbol: new Map([["BTC", new Map(Object.entries(input.dailyPrices))]]),
  };
}

describe("connected-source store — connect", () => {
  test("materializes a derived, illiquid coin collection valued at 0, owned 100%", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const { sourceId, assetId } = await connectNumista(store);

    const asset = await holding(store, assetId);
    expect(asset.instrument).toBe("coin_collection");
    expect(asset.liquidityTier).toBe("illiquid");
    expect(asset.currentValue.amountMinor).toBe(0);
    expect(asset.ownership).toEqual(ownerAll);

    // A connected-source holding is derived from its positions — excluded from
    // the manual value-update pass (ADR 0014/0016).
    expect(valuationMethodOfAsset(asset)).toBe("derived");
    expect(isValueUpdateEligible(asset)).toBe(false);

    const source = await store.connectedSources.readSource(sourceId);
    expect(source).toMatchObject({
      adapter: "numista",
      assetId,
      label: "Colección Numista",
      lastSyncAt: null,
      tokenJson: null,
    });
    expect(await store.connectedSources.listSources()).toHaveLength(1);
  });
});

describe("connected-source store — syncPositions", () => {
  test("persists positions and rolls the holding value to the sum of prices", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectNumista(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        position({
          catalogueId: "n1",
          externalId: "ext-1",
          name: "Coin A",
          purchasePriceMinor: 5_000,
          obverseThumbUrl: "https://en.numista.com/catalogue/photos/x/n1-180.jpg",
        }),
        position({
          catalogueId: "n2",
          externalId: "ext-2",
          name: "Coin B",
          purchasePriceMinor: 7_500,
        }),
      ],
      "2024-06-01T10:00:00.000Z",
    );

    expect((await holding(store, assetId)).currentValue.amountMinor).toBe(12_500);

    const stored = (await store.connectedSources.readPositions(sourceId)).map(asCoin);
    expect(stored).toHaveLength(2);
    expect(stored.map((p) => p.catalogueId).sort()).toEqual(["n1", "n2"]);
    // The Numista collected-item id round-trips — the cross-sync trade key (#167).
    expect(stored.find((p) => p.catalogueId === "n1")?.externalId).toBe("ext-1");
    expect(stored.find((p) => p.catalogueId === "n1")).toMatchObject({
      catalogueId: "n1",
      currency: "EUR",
      externalId: "ext-1",
      grade: "VF",
      liquidityTier: "illiquid",
      metal: "silver",
      name: "Coin A",
      purchaseDate: "2024-01-01",
      purchasePriceMinor: 5_000,
      quantity: 1,
      sourceId,
      // The obverse photo round-trips through the store so the gallery can render it (#272).
      obverseThumbUrl: "https://en.numista.com/catalogue/photos/x/n1-180.jpg",
    });
  });

  test("re-sync replaces positions and re-rolls the value", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectNumista(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        position({ catalogueId: "keep", purchasePriceMinor: 5_000 }),
        position({ catalogueId: "drop", purchasePriceMinor: 9_000 }),
      ],
      "2024-06-01T10:00:00.000Z",
    );
    expect((await holding(store, assetId)).currentValue.amountMinor).toBe(14_000);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        position({ catalogueId: "keep", purchasePriceMinor: 5_000 }),
        position({ catalogueId: "new", purchasePriceMinor: 3_000 }),
      ],
      "2024-07-01T10:00:00.000Z",
    );

    const stored = (await store.connectedSources.readPositions(sourceId)).map(asCoin);
    expect(stored.map((p) => p.catalogueId).sort()).toEqual(["keep", "new"]);
    expect(stored.some((p) => p.catalogueId === "drop")).toBe(false);
    expect((await holding(store, assetId)).currentValue.amountMinor).toBe(8_000);
  });

  test("persists and round-trips the indefinite detail + numismatic fetched-at", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId } = await connectNumista(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        position({
          catalogueId: "1493",
          issueId: 32723,
          finenessMillis: 999,
          weightGrams: 31.103,
          metalValueMinor: 2797,
          numismaticValueMinor: 7558,
          numismaticFetchedAt: "2026-06-15T12:00:00.000Z",
        }),
      ],
      "2026-06-15T12:00:00.000Z",
    );

    const stored = await store.connectedSources.readPositions(sourceId);
    expect(stored[0]).toMatchObject({
      issueId: 32723,
      finenessMillis: 999,
      weightGrams: 31.103,
      numismaticFetchedAt: "2026-06-15T12:00:00.000Z",
    });
  });

  test("a null purchase price contributes 0 but is still stored", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectNumista(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        position({ catalogueId: "priced", purchasePriceMinor: 4_000 }),
        position({ catalogueId: "unpriced", purchasePriceMinor: null }),
      ],
      "2024-06-01T10:00:00.000Z",
    );

    expect((await holding(store, assetId)).currentValue.amountMinor).toBe(4_000);

    const stored = (await store.connectedSources.readPositions(sourceId)).map(asCoin);
    expect(stored).toHaveLength(2);
    const unpriced = stored.find((p) => p.catalogueId === "unpriced");
    expect(unpriced?.purchasePriceMinor).toBeNull();
  });
});

describe("connected-source store — revaluePositions", () => {
  test("updates candidates in place, re-rolls the holding, stamps freshness", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectNumista(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        position({
          catalogueId: "1493",
          metalValueMinor: 2797,
          numismaticValueMinor: 7558,
          purchasePriceMinor: null,
        }),
        position({
          catalogueId: "5678",
          metalValueMinor: 4051,
          numismaticValueMinor: 2400,
          purchasePriceMinor: null,
        }),
      ],
      "2026-06-15T12:00:00.000Z",
    );
    // value = Σ max(metal, numismatic): 7558 + 4051 = 11609
    expect((await holding(store, assetId)).currentValue.amountMinor).toBe(11609);

    const stored = (await store.connectedSources.readPositions(sourceId)).map(asCoin);
    const eagle = stored.find((p) => p.catalogueId === "1493")!;
    const pesetas = stored.find((p) => p.catalogueId === "5678")!;

    await store.connectedSources.revaluePositions(
      sourceId,
      [
        {
          id: eagle.id,
          metalValueMinor: 3000,
          numismaticValueMinor: 7558,
          numismaticFetchedAt: "2026-07-15T12:00:00.000Z",
        },
        {
          id: pesetas.id,
          metalValueMinor: 4500,
          numismaticValueMinor: 2400,
          numismaticFetchedAt: "2026-07-15T12:00:00.000Z",
        },
      ],
      { fetchedAt: "2026-07-15T12:00:00.000Z", freshnessState: "fresh" },
    );

    // eagle max(3000, 7558)=7558; pesetas max(4500, 2400)=4500 → 12058
    expect((await holding(store, assetId)).currentValue.amountMinor).toBe(12058);

    const reread = (await store.connectedSources.readPositions(sourceId)).map(asCoin);
    expect(reread.find((p) => p.catalogueId === "1493")).toMatchObject({
      metalValueMinor: 3000,
      numismaticFetchedAt: "2026-07-15T12:00:00.000Z",
    });

    // The freshness row is the staleness indicator + the daily refresh trigger.
    expect(await store.operations.readPriceCache(assetId)).toMatchObject({
      source: "numista",
      freshnessState: "fresh",
      fetchedAt: "2026-07-15T12:00:00.000Z",
    });
  });

  test("an outage freshness (stale + reason) keeps the last-known value", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectNumista(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        position({
          catalogueId: "1493",
          numismaticValueMinor: 7558,
          purchasePriceMinor: null,
        }),
      ],
      "2026-06-15T12:00:00.000Z",
    );
    const eagle = asCoin((await store.connectedSources.readPositions(sourceId))[0]!);

    // Outage: keep last-known candidate values, mark the row stale with a reason.
    await store.connectedSources.revaluePositions(
      sourceId,
      [
        {
          id: eagle.id,
          metalValueMinor: eagle.metalValueMinor,
          numismaticValueMinor: 7558,
          numismaticFetchedAt: eagle.numismaticFetchedAt,
        },
      ],
      {
        fetchedAt: "2026-06-15T12:00:00.000Z",
        freshnessState: "stale",
        staleReason: "Numista no disponible",
      },
    );

    expect((await holding(store, assetId)).currentValue.amountMinor).toBe(7558);
    expect(await store.operations.readPriceCache(assetId)).toMatchObject({
      freshnessState: "stale",
      staleReason: "Numista no disponible",
    });
  });
});

describe("connected-source store — freezeIntoStoredHolding", () => {
  test("drops the source + positions, keeps the asset as a hand-valued precious_metal holding", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectNumista(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        position({ catalogueId: "n1", externalId: "ext-1", purchasePriceMinor: 5_000 }),
        position({ catalogueId: "n2", externalId: "ext-2", purchasePriceMinor: 7_500 }),
      ],
      "2024-06-01T10:00:00.000Z",
    );
    // A connected source carries a valuation-freshness price-cache row.
    await store.connectedSources.revaluePositions(
      sourceId,
      (await store.connectedSources.readPositions(sourceId)).map(asCoin).map((p) => ({
        id: p.id,
        metalValueMinor: p.metalValueMinor,
        numismaticValueMinor: p.numismaticValueMinor,
        numismaticFetchedAt: p.numismaticFetchedAt,
      })),
      { fetchedAt: "2024-06-01T10:00:00.000Z", freshnessState: "fresh" },
    );
    expect((await holding(store, assetId)).currentValue.amountMinor).toBe(12_500);
    expect(await store.operations.readPriceCache(assetId)).not.toBeNull();

    const result = await store.connectedSources.freezeIntoStoredHolding(sourceId);
    expect(result).toEqual({ assetId });

    // The source + its positions are gone; frozen snapshots are untouched.
    expect(await store.connectedSources.listSources()).toHaveLength(0);
    expect(await store.connectedSources.readSource(sourceId)).toBeNull();
    expect(await store.connectedSources.readPositions(sourceId)).toHaveLength(0);

    // The asset survives as a plain, hand-maintained precious-metal holding: same
    // frozen value, name and ownership, now valued by hand (stored) and eligible
    // for the manual value-update pass.
    const frozen = await holding(store, assetId);
    expect(frozen.instrument).toBe("precious_metal");
    expect(frozen.liquidityTier).toBe("illiquid");
    expect(frozen.currentValue.amountMinor).toBe(12_500);
    expect(frozen.name).toBe("Colección Numista");
    expect(frozen.ownership).toEqual(ownerAll);
    expect(valuationMethodOfAsset(frozen)).toBe("stored");
    expect(isValueUpdateEligible(frozen)).toBe(true);

    // The orphaned connected-source price-cache row is cleared.
    expect(await store.operations.readPriceCache(assetId)).toBeNull();

    // The asset no longer references the (now deleted) source — a fully detached,
    // plain holding with no dangling connected_source_id (S6 #251).
    expect(await store.connectedSources.readSourceIdForAsset(assetId)).toBeNull();
  });

  test("returns null for an unknown source and changes nothing", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { assetId } = await connectNumista(store);

    expect(await store.connectedSources.freezeIntoStoredHolding("missing")).toBeNull();
    expect(await store.connectedSources.listSources()).toHaveLength(1);
    expect((await holding(store, assetId)).instrument).toBe("coin_collection");
  });
});

describe("connected-source store — freezeIntoStoredHolding (Binance, multi-rung)", () => {
  test("freezes EVERY rung into a hand-valued `other` holding, keeping value/name/ownership/rung, fully detached", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectBinance(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        tk({}), // 0.5 BTC × 50 000 = 25 000 € on market
        tk({
          externalId: "ETH:locked-earn",
          name: "ETH",
          symbol: "ETH",
          balance: "3",
          unitPrice: "2000",
          wallet: "locked-earn",
          liquidityTier: "term-locked",
        }), // 3 ETH × 2 000 = 6 000 € on term-locked
      ],
      "2026-06-16T10:00:00.000Z",
    );
    // A live-valued source carries a `binance` valuation-freshness price-cache row.
    await store.connectedSources.revaluePositions(sourceId, [], {
      fetchedAt: "2026-06-16T10:00:00.000Z",
      freshnessState: "fresh",
    });

    const assetIdsBefore = await store.connectedSources.listSourceAssetIds(sourceId);
    expect(assetIdsBefore).toHaveLength(2);
    const termLockedId = assetIdsBefore.find((id) => id !== assetId)!;
    expect(await store.operations.readPriceCache(assetId)).not.toBeNull();

    const result = await store.connectedSources.freezeIntoStoredHolding(sourceId);
    // Returns the primary (market) asset id, like the Numista freeze.
    expect(result).toEqual({ assetId });

    // The source + ALL its positions are gone; frozen snapshots are untouched.
    expect(await store.connectedSources.listSources()).toHaveLength(0);
    expect(await store.connectedSources.readPositions(sourceId)).toHaveLength(0);

    // BOTH rung assets survive as plain hand-valued `other` holdings, keeping
    // their value, name, ownership AND rung — now editable by hand (stored).
    const market = await holding(store, assetId);
    expect(market.instrument).toBe("other");
    expect(market.liquidityTier).toBe("market");
    expect(market.currentValue.amountMinor).toBe(2_500_000);
    expect(market.ownership).toEqual(ownerAll);
    expect(valuationMethodOfAsset(market)).toBe("stored");
    expect(isValueUpdateEligible(market)).toBe(true);

    const termLocked = await holding(store, termLockedId);
    expect(termLocked.instrument).toBe("other");
    expect(termLocked.liquidityTier).toBe("term-locked");
    expect(termLocked.currentValue.amountMinor).toBe(600_000);
    expect(valuationMethodOfAsset(termLocked)).toBe("stored");

    // Fully detached: neither asset references the deleted source any more.
    expect(await store.connectedSources.readSourceIdForAsset(assetId)).toBeNull();
    expect(await store.connectedSources.readSourceIdForAsset(termLockedId)).toBeNull();

    // The orphaned valuation-freshness row is cleared.
    expect(await store.operations.readPriceCache(assetId)).toBeNull();
  });

  test("leaves frozen snapshots intact — a disconnect freeze never rewrites history (#251)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectBinance(store);
    await store.connectedSources.syncPositions(
      sourceId,
      [tk({})], // 0.5 BTC spot, market rung
      "2026-06-16T10:00:00.000Z",
    );
    // Freeze a monthly-close snapshot row for a completed past month (ADR 0008).
    await store.applyBinanceHistoryAndRipple({
      sourceId,
      curve: btcCurve({
        monthEndBalances: { "2026-03": "0.5" },
        dailyPrices: { "2026-03-31": "40000" },
      }),
      today: "2026-06-16",
    });
    const before = await store.snapshots.readSnapshotHoldings({ holdingId: assetId });
    expect(before.length).toBeGreaterThan(0);

    await store.connectedSources.freezeIntoStoredHolding(sourceId);

    // The frozen rows are byte-identical — history is never touched by a disconnect.
    expect(await store.snapshots.readSnapshotHoldings({ holdingId: assetId })).toEqual(
      before,
    );
  });

  test("a frozen source round-trips through export/import as a hand-valued (stored) holding (#251)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectBinance(store);
    await store.connectedSources.syncPositions(
      sourceId,
      [tk({})],
      "2026-06-16T10:00:00.000Z",
    );
    await store.connectedSources.freezeIntoStoredHolding(sourceId);

    const doc = await store.workspace.exportWorkspace();
    // No connected source survives the freeze — it became a plain holding.
    expect(doc.connectedSources).toHaveLength(0);

    const parsed = parseWorkspaceExport(doc);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const fresh = await createInMemoryStore();
    await fresh.workspace.importWorkspace(parsed.value);

    // The INSTRUMENT (not the type-derived exported method column) governs the
    // effective method across a round-trip: still hand-valued + editable.
    const restored = (await fresh.assets.readAssets()).find((a) => a.id === assetId)!;
    expect(restored.instrument).toBe("other");
    expect(valuationMethodOfAsset(restored)).toBe("stored");
    expect(isValueUpdateEligible(restored)).toBe(true);
  });
});

describe("connected-source store — removeSourceHoldings (Binance, multi-rung)", () => {
  test("drops BOTH rung assets + the source + positions, but frozen snapshots survive (#251)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectBinance(store);
    await store.connectedSources.syncPositions(
      sourceId,
      [
        tk({}), // market
        tk({
          externalId: "ETH:locked-earn",
          name: "ETH",
          symbol: "ETH",
          balance: "3",
          unitPrice: "2000",
          wallet: "locked-earn",
          liquidityTier: "term-locked",
        }), // term-locked
      ],
      "2026-06-16T10:00:00.000Z",
    );
    // Freeze a past month-end row so we can prove the REMOVE path keeps history too.
    await store.applyBinanceHistoryAndRipple({
      sourceId,
      curve: btcCurve({
        monthEndBalances: { "2026-03": "0.5" },
        dailyPrices: { "2026-03-31": "40000" },
      }),
      today: "2026-06-16",
    });
    const frozenBefore = await store.snapshots.readSnapshotHoldings({
      holdingId: assetId,
    });
    expect(frozenBefore.length).toBeGreaterThan(0);
    expect(await store.connectedSources.listSourceAssetIds(sourceId)).toHaveLength(2);

    const { removed } = await store.connectedSources.removeSourceHoldings(sourceId);

    // Both rung assets, the source and all positions are gone…
    expect(removed).toBe(2);
    expect(await store.connectedSources.listSources()).toHaveLength(0);
    expect(await store.connectedSources.readPositions(sourceId)).toHaveLength(0);
    expect((await store.assets.readAssets()).some((a) => a.instrument === "crypto")).toBe(
      false,
    );

    // …but the frozen snapshot rows survive untouched (a hard delete never touches
    // history — ADR 0008/0016).
    expect(await store.snapshots.readSnapshotHoldings({ holdingId: assetId })).toEqual(
      frozenBefore,
    );
  });
});

describe("connected-source store — export/import round-trip", () => {
  test("carries the source + positions through export→parse→import, without secrets", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectNumista(store);
    // A minted token + the pasted API key are the local-only secrets.
    await store.connectedSources.saveToken(
      sourceId,
      JSON.stringify({ accessToken: "secret-token", expiresAtMs: 999, userId: 1 }),
    );
    await store.connectedSources.syncPositions(
      sourceId,
      [
        position({ catalogueId: "n1", externalId: "ext-1", purchasePriceMinor: 5_000 }),
        position({ catalogueId: "n2", externalId: "ext-2", purchasePriceMinor: 7_500 }),
      ],
      "2024-06-01T10:00:00.000Z",
    );

    const doc = await store.workspace.exportWorkspace();

    // The export carries the source + its positions…
    expect(doc.connectedSources).toHaveLength(1);
    const exported = doc.connectedSources[0]!;
    expect(exported).toMatchObject({
      id: sourceId,
      adapter: "numista",
      assetId,
      label: "Colección Numista",
      lastSyncAt: "2024-06-01T10:00:00.000Z",
    });
    expect(exported.positions).toHaveLength(2);
    // …but NEVER the secrets (apiKey "secret" + the minted "secret-token").
    expect(JSON.stringify(doc)).not.toContain("secret");
    expect(exported).not.toHaveProperty("credentialsJson");
    expect(exported).not.toHaveProperty("tokenJson");

    // The untrusted document validates (the coin_collection asset + the new
    // connected-sources section both pass the parser gate)…
    const parsed = parseWorkspaceExport(doc);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));

    // …and restores into a fresh store: holding + source + positions are back.
    const fresh = await createInMemoryStore();
    await fresh.workspace.importWorkspace(parsed.value);

    const restored = await fresh.connectedSources.listSources();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: sourceId,
      adapter: "numista",
      assetId,
      label: "Colección Numista",
      lastSyncAt: "2024-06-01T10:00:00.000Z",
      tokenJson: null,
    });
    // The restored source has no usable credentials — a re-sync needs the API
    // key re-entered (ADR 0016).
    expect(
      (JSON.parse(restored[0]!.credentialsJson) as { apiKey?: string }).apiKey,
    ).toBeUndefined();

    const restoredPositions = await fresh.connectedSources.readPositions(sourceId);
    expect(restoredPositions).toHaveLength(2);
    expect(restoredPositions.map((p) => p.externalId).sort()).toEqual(["ext-1", "ext-2"]);

    // The projected holding round-trips as a coin_collection with its rolled value.
    const restoredHolding = (await fresh.assets.readAssets()).find(
      (a) => a.id === assetId,
    );
    expect(restoredHolding?.instrument).toBe("coin_collection");
    expect(restoredHolding?.currentValue.amountMinor).toBe(12_500);
  });

  test("round-trips a multi-rung Binance source (token positions across both rungs), without credentials (S6 #251)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await store.connectedSources.connect({
      adapter: "binance",
      label: "Binance",
      // Distinctive sentinels for BOTH secrets (key + signing secret are both
      // local-only, ADR 0015/0021) so the "no secrets in the export" assertion bites.
      credentialsJson: JSON.stringify({
        apiKey: "topsecretkeyvalue",
        apiSecret: "topsecretvalue",
      }),
      ownership: ownerAll,
    });

    // Spot (market) + locked-earn (term-locked) → two materialized crypto assets,
    // each with a live token position carrying balance/wallet/unitPrice.
    await store.connectedSources.syncPositions(
      sourceId,
      [
        {
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
        },
        {
          kind: "token",
          externalId: "ETH:locked-earn",
          name: "ETH",
          symbol: "ETH",
          balance: "3",
          wallet: "locked-earn",
          liquidityTier: "term-locked",
          unitPrice: "2000",
          imageUrl: null,
          currency: "EUR",
        },
      ],
      "2026-06-16T10:00:00.000Z",
    );
    const termLockedId = (await store.connectedSources.listSourceAssetIds(sourceId)).find(
      (id) => id !== assetId,
    )!;
    // Position identities to preserve across the round-trip (#251).
    const positionIdsBefore = (await store.connectedSources.readPositions(sourceId))
      .map((p) => p.id)
      .sort();

    const doc = await store.workspace.exportWorkspace();

    // The export carries the source with its TOKEN positions, and BOTH rung assets
    // carry the connected_source_id back-link (the source row names only the
    // primary, #248) — but NEVER either secret (key or signing secret).
    expect(doc.connectedSources).toHaveLength(1);
    const exported = doc.connectedSources[0]!;
    expect(exported).toMatchObject({ id: sourceId, adapter: "binance", assetId });
    expect(exported.positions).toHaveLength(2);
    expect(JSON.stringify(doc)).not.toContain("topsecretvalue");
    expect(JSON.stringify(doc)).not.toContain("topsecretkeyvalue");
    const exportedRungAssets = doc.assets.filter((a) => a.connectedSourceId === sourceId);
    expect(exportedRungAssets.map((a) => a.id).sort()).toEqual(
      [assetId, termLockedId].sort(),
    );

    // Validates and restores all-or-nothing into a fresh store.
    const parsed = parseWorkspaceExport(doc);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const fresh = await createInMemoryStore();
    await fresh.workspace.importWorkspace(parsed.value);

    // The source is back, credentials unusable (a re-sync needs the key re-entered).
    const restored = await fresh.connectedSources.listSources();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: sourceId, adapter: "binance", assetId });
    const restoredCreds = JSON.parse(restored[0]!.credentialsJson) as {
      apiKey?: string;
      apiSecret?: string;
    };
    expect(restoredCreds.apiKey).toBeUndefined();
    expect(restoredCreds.apiSecret).toBeUndefined();

    // Both rung assets re-attach to the source (identities preserved), and the
    // token positions round-trip faithfully (balance/wallet/unitPrice intact) —
    // including their own ids (preserving identities, ADR 0015).
    expect((await fresh.connectedSources.listSourceAssetIds(sourceId)).sort()).toEqual(
      [assetId, termLockedId].sort(),
    );
    const restoredPositions = await fresh.connectedSources.readPositions(sourceId);
    expect(restoredPositions).toHaveLength(2);
    expect(restoredPositions.map((p) => p.id).sort()).toEqual(positionIdsBefore);
    const btc = restoredPositions.find((p) => p.kind === "token" && p.symbol === "BTC");
    expect(btc).toMatchObject({
      kind: "token",
      balance: "0.5",
      wallet: "spot",
      unitPrice: "50000",
    });

    // Both projected holdings round-trip as crypto with their live-rolled values.
    const freshAssets = await fresh.assets.readAssets();
    const market = freshAssets.find((a) => a.id === assetId);
    expect(market?.instrument).toBe("crypto");
    expect(market?.currentValue.amountMinor).toBe(2_500_000);
    const termLocked = freshAssets.find((a) => a.id === termLockedId);
    expect(termLocked?.instrument).toBe("crypto");
    expect(termLocked?.liquidityTier).toBe("term-locked");
    expect(termLocked?.currentValue.amountMinor).toBe(600_000);
  });
});

describe("connected-source store — import replaces existing sources", () => {
  test("a full-replace import wipes a pre-existing source + positions", async () => {
    const target = await createInMemoryStore();
    await seed(target);
    const { sourceId } = await connectNumista(target);
    await target.connectedSources.syncPositions(
      sourceId,
      [position({ catalogueId: "old", externalId: "old-1" })],
      "2024-01-01T00:00:00.000Z",
    );
    expect(await target.connectedSources.listSources()).toHaveLength(1);

    // A document with NO connected sources must leave none behind after import.
    const empty = await createInMemoryStore();
    await seed(empty);
    const doc = await empty.workspace.exportWorkspace();
    expect(doc.connectedSources).toHaveLength(0);

    await target.workspace.importWorkspace(doc);

    expect(await target.connectedSources.listSources()).toHaveLength(0);
    expect(await target.connectedSources.readPositions(sourceId)).toHaveLength(0);
  });
});

describe("connected-source store — token + last sync", () => {
  test("saveToken round-trips and a sync stamps lastSyncAt", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId } = await connectNumista(store);

    const tokenJson = JSON.stringify({ accessToken: "abc", expiresAt: 123 });
    await store.connectedSources.saveToken(sourceId, tokenJson);
    expect((await store.connectedSources.readSource(sourceId))?.tokenJson).toBe(
      tokenJson,
    );
    expect((await store.connectedSources.readSource(sourceId))?.lastSyncAt).toBeNull();

    await store.connectedSources.syncPositions(
      sourceId,
      [position()],
      "2024-08-15T09:00:00.000Z",
    );
    expect((await store.connectedSources.readSource(sourceId))?.lastSyncAt).toBe(
      "2024-08-15T09:00:00.000Z",
    );
    // The token is untouched by a sync.
    expect((await store.connectedSources.readSource(sourceId))?.tokenJson).toBe(
      tokenJson,
    );
  });
});

describe("connected-source store — migration", () => {
  // Fresh-DB table-existence + version assertion: a raw libSQL client run
  // through `migrate` lands at SCHEMA_VERSION with both tables present, and the
  // positions table carries the v21 external_id column (the cross-sync trade key,
  // #167) added by the ladder after the v19 CREATE TABLE.
  test("migrate creates connected_sources + positions and adds external_id", async () => {
    const client = openLibsqlClient(":memory:");
    await migrate(client);

    const tableNames = (
      (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'"))
        .rows as unknown as {
        name: string;
      }[]
    ).map((row) => row.name);

    expect(tableNames).toContain("connected_sources");
    expect(tableNames).toContain("positions");

    const positionColumns = (
      (await client.execute("PRAGMA table_info(positions)")).rows as unknown as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(positionColumns).toContain("external_id");
    // The v22 mint-year column (#215).
    expect(positionColumns).toContain("year");

    expect(
      Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(22);

    client.close();
  });

  // The v20 decoupled-valuation columns (PRD #166): present on a fresh DB and,
  // crucially, idempotent — the v20 ALTERs are guarded so a fresh DB (which gets
  // them from schema-sql) does not double-add and throw.
  test("positions carries the v20 valuation-refresh columns", async () => {
    const client = openLibsqlClient(":memory:");
    await migrate(client);

    const columns = (
      (await client.execute("PRAGMA table_info(positions)")).rows as unknown as {
        name: string;
      }[]
    ).map((row) => row.name);

    expect(columns).toEqual(
      expect.arrayContaining([
        "issue_id",
        "fineness_millis",
        "weight_grams",
        "numismatic_fetched_at",
      ]),
    );

    client.close();
  });

  // An existing v19 DB (connected_sources/positions present, old positions shape)
  // upgrades cleanly to v20: the ALTERs add the four columns to real data.
  test("upgrades a v19 database to v20 by adding the columns", async () => {
    const client = openLibsqlClient(":memory:");
    // Stand up the v19 positions shape, then mark the DB as v19 so migrate runs
    // only the v20 step against it (the real upgrade path, not the fresh-DB path).
    await client.executeMultiple(`CREATE TABLE positions (
      id TEXT PRIMARY KEY NOT NULL,
      source_id TEXT NOT NULL,
      catalogue_id TEXT NOT NULL,
      name TEXT NOT NULL,
      grade TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      liquidity_tier TEXT NOT NULL,
      metal TEXT,
      purchase_date TEXT,
      purchase_price_minor INTEGER,
      metal_value_minor INTEGER,
      numismatic_value_minor INTEGER,
      currency TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );`);
    await client.execute("PRAGMA user_version = 19");

    await migrate(client);

    const columns = (
      (await client.execute("PRAGMA table_info(positions)")).rows as unknown as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "issue_id",
        "fineness_millis",
        "weight_grams",
        "numismatic_fetched_at",
      ]),
    );
    expect(
      Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version),
    ).toBe(SCHEMA_VERSION);

    client.close();
  });
});
