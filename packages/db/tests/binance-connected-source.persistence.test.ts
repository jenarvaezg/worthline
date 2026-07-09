/**
 * Binance connected-source persistence (ADR 0021, S1 / #246).
 *
 * Integration tests against a real in-memory store. Connecting Binance
 * materializes a derived `crypto` holding on the MARKET rung (not Numista's
 * illiquid coin_collection); syncing token balances re-rolls its value LIVE as
 * Σ(balance × unit price). An unpriceable token is value 0 (the "value at 0"
 * case) but stays a position. These assert external behaviour — projected
 * holding, value, persisted positions — not internal wiring.
 */

import type { SourcePositionInput, WorthlineStore } from "@db/index";

import { createInMemoryStore } from "@db/index";
import { describe, expect, test } from "vitest";

const MEMBER_ID = "mJ";

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
}

async function connectBinance(
  store: WorthlineStore,
): Promise<{ sourceId: string; assetId: string }> {
  return await store.connectedSources.connect({
    adapter: "binance",
    label: "Binance",
    credentialsJson: JSON.stringify({ apiKey: "KEY", apiSecret: "SECRET" }),
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
}

function token(overrides: Partial<Extract<SourcePositionInput, { kind: "token" }>> = {}) {
  return {
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
    ...overrides,
  };
}

describe("connect (Binance) materializes a market-rung crypto holding", () => {
  test("the holding is a derived crypto asset on the market rung, valued 0 before sync", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { assetId } = await connectBinance(store);

    const asset = (await store.assets.readAssets()).find((a) => a.id === assetId)!;
    expect(asset.instrument).toBe("crypto");
    expect(asset.liquidityTier).toBe("market");
    expect(asset.currentValue.amountMinor).toBe(0);
    store.close();
  });
});

describe("syncPositions (Binance) re-rolls the holding LIVE as Σ(balance × price)", () => {
  test("spot tokens roll up to the live market value and persist their balances", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectBinance(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        token({
          externalId: "BTC:spot",
          symbol: "BTC",
          balance: "0.5",
          unitPrice: "50000",
        }),
        token({ externalId: "ETH:spot", symbol: "ETH", balance: "2", unitPrice: "2000" }),
      ],
      "2026-06-16T10:00:00.000Z",
    );

    const asset = (await store.assets.readAssets()).find((a) => a.id === assetId)!;
    expect(asset.currentValue.amountMinor).toBe(2_900_000); // 25 000 € + 4 000 €

    const positions = await store.connectedSources.readPositions(sourceId);
    expect(positions).toHaveLength(2);
    const btc = positions.find((p) => p.kind === "token" && p.symbol === "BTC");
    expect(btc).toMatchObject({
      kind: "token",
      symbol: "BTC",
      balance: "0.5",
      wallet: "spot",
      unitPrice: "50000",
    });
    store.close();
  });

  test("a token's logo URL round-trips through persistence (#482)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId } = await connectBinance(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        token({
          externalId: "BTC:spot",
          symbol: "BTC",
          imageUrl: "https://coin-images.test/btc.png",
        }),
        token({ externalId: "ETH:spot", symbol: "ETH", imageUrl: null }),
      ],
      "2026-06-16T10:00:00.000Z",
    );

    const positions = await store.connectedSources.readPositions(sourceId);
    const btc = positions.find((p) => p.kind === "token" && p.symbol === "BTC");
    const eth = positions.find((p) => p.kind === "token" && p.symbol === "ETH");
    expect(btc).toMatchObject({ imageUrl: "https://coin-images.test/btc.png" });
    expect(eth).toMatchObject({ imageUrl: null });
    store.close();
  });

  test("the SAME token on spot + funding sums into one holding value (#247)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectBinance(store);

    // BTC parked on two market wallets — distinct externalIds, one symbol.
    await store.connectedSources.syncPositions(
      sourceId,
      [
        token({
          externalId: "BTC:spot",
          wallet: "spot",
          balance: "0.5",
          unitPrice: "50000",
        }), // 25 000 €
        token({
          externalId: "BTC:funding",
          wallet: "funding",
          balance: "0.1",
          unitPrice: "50000",
        }), // 5 000 €
      ],
      "2026-06-16T10:00:00.000Z",
    );

    const asset = (await store.assets.readAssets()).find((a) => a.id === assetId)!;
    expect(asset.currentValue.amountMinor).toBe(3_000_000); // both wallets summed

    // Both positions persist with their wallet origin (#247 metadata).
    const positions = await store.connectedSources.readPositions(sourceId);
    expect(positions).toHaveLength(2);
    expect(positions.map((p) => (p.kind === "token" ? p.wallet : null)).sort()).toEqual([
      "funding",
      "spot",
    ]);
    store.close();
  });

  test("an unpriceable token (null price) contributes 0 but is still persisted", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectBinance(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        token({
          externalId: "BTC:spot",
          symbol: "BTC",
          balance: "0.5",
          unitPrice: "50000",
        }),
        token({
          externalId: "WAGMI:spot",
          symbol: "WAGMI",
          balance: "100",
          unitPrice: null,
        }),
      ],
      "2026-06-16T10:00:00.000Z",
    );

    const asset = (await store.assets.readAssets()).find((a) => a.id === assetId)!;
    expect(asset.currentValue.amountMinor).toBe(2_500_000); // only the BTC counts

    const positions = await store.connectedSources.readPositions(sourceId);
    expect(positions).toHaveLength(2);
    const wagmi = positions.find((p) => p.kind === "token" && p.symbol === "WAGMI");
    expect(wagmi).toMatchObject({ symbol: "WAGMI", balance: "100", unitPrice: null });
    store.close();
  });

  test("a re-sync replaces balances and re-rolls (sells/buys reflected wholesale)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectBinance(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [token({ balance: "0.5", unitPrice: "50000" })],
      "2026-06-16T10:00:00.000Z",
    );
    // A later sync: balance grew, price moved.
    await store.connectedSources.syncPositions(
      sourceId,
      [token({ balance: "1", unitPrice: "60000" })],
      "2026-06-17T10:00:00.000Z",
    );

    const asset = (await store.assets.readAssets()).find((a) => a.id === assetId)!;
    expect(asset.currentValue.amountMinor).toBe(6_000_000); // 1 × 60 000 €
    expect(await store.connectedSources.readPositions(sourceId)).toHaveLength(1);
    store.close();
  });
});

describe("syncPositions (Binance) materializes ONE asset per rung (S3, #248)", () => {
  test("spot + locked-earn → a market crypto asset AND a term-locked one, both linked", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectBinance(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        token({
          externalId: "BTC:spot",
          symbol: "BTC",
          balance: "0.5",
          unitPrice: "50000",
          wallet: "spot",
          liquidityTier: "market",
        }), // 25 000 € on market
        token({
          externalId: "ETH:locked-earn",
          symbol: "ETH",
          balance: "3",
          unitPrice: "2000",
          wallet: "locked-earn",
          liquidityTier: "term-locked",
        }), // 6 000 € on term-locked
      ],
      "2026-06-16T10:00:00.000Z",
    );

    const crypto = (await store.assets.readAssets())
      .filter((a) => a.instrument === "crypto")
      .sort((a, b) => a.liquidityTier.localeCompare(b.liquidityTier));
    expect(crypto).toHaveLength(2);

    const byTier = new Map(crypto.map((a) => [a.liquidityTier, a]));
    expect(byTier.get("market")!.id).toBe(assetId); // the primary asset keeps the id
    expect(byTier.get("market")!.currentValue.amountMinor).toBe(2_500_000);
    expect(byTier.get("term-locked")!.currentValue.amountMinor).toBe(600_000);

    const termLockedAssetId = byTier.get("term-locked")!.id;

    // Both assets are linked to the source; listSourceAssetIds returns both.
    const ids = await store.connectedSources.listSourceAssetIds(sourceId);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(assetId);
    expect(ids).toContain(termLockedAssetId);

    // readSourceIdForAsset resolves the source from EITHER rung asset (#248): the
    // market (primary) one AND the term-locked one — the term-locked asset's id is
    // distinct from connected_sources.asset_id (the primary), yet still routes back.
    expect(await store.connectedSources.readSourceIdForAsset(assetId)).toBe(sourceId);
    expect(await store.connectedSources.readSourceIdForAsset(termLockedAssetId)).toBe(
      sourceId,
    );
    expect(termLockedAssetId).not.toBe(assetId);

    // The term-locked asset inherits the source's ownership (the ownership-copy
    // branch in rerollSourceHoldings) — 100 % the connecting member.
    const termLocked = (await store.assets.readAssets()).find(
      (a) => a.id === termLockedAssetId,
    )!;
    expect(termLocked.ownership).toEqual([{ memberId: MEMBER_ID, shareBps: 10_000 }]);
    store.close();
  });

  test("a later sync that empties the locked rung sets the term-locked asset to 0 (kept, not deleted)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId } = await connectBinance(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        token({
          externalId: "BTC:spot",
          symbol: "BTC",
          balance: "0.5",
          unitPrice: "50000",
        }),
        token({
          externalId: "ETH:locked-earn",
          symbol: "ETH",
          balance: "3",
          unitPrice: "2000",
          wallet: "locked-earn",
          liquidityTier: "term-locked",
        }),
      ],
      "2026-06-16T10:00:00.000Z",
    );

    const sourceAssetIds = await store.connectedSources.listSourceAssetIds(sourceId);
    const assets = await store.assets.readAssets();
    const lockedId = sourceAssetIds.find((id) => {
      const a = assets.find((x) => x.id === id)!;
      return a.liquidityTier === "term-locked";
    })!;

    // A later sync redeemed the locked position — only spot remains.
    await store.connectedSources.syncPositions(
      sourceId,
      [
        token({
          externalId: "BTC:spot",
          symbol: "BTC",
          balance: "0.5",
          unitPrice: "50000",
        }),
      ],
      "2026-06-17T10:00:00.000Z",
    );

    // The term-locked asset survives (snapshots/identity) but is valued 0 now.
    const locked = (await store.assets.readAssets()).find((a) => a.id === lockedId);
    expect(locked).toBeDefined();
    expect(locked!.currentValue.amountMinor).toBe(0);
    // It is still the source's asset, so the link is intact.
    expect(await store.connectedSources.listSourceAssetIds(sourceId)).toContain(lockedId);
    store.close();
  });

  test("re-sync materializes a FRESH live asset for a rung whose prior asset was trashed (#248, FIX 6)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId } = await connectBinance(store);

    await store.connectedSources.syncPositions(
      sourceId,
      [
        token({
          externalId: "ETH:locked-earn",
          symbol: "ETH",
          balance: "3",
          unitPrice: "2000",
          wallet: "locked-earn",
          liquidityTier: "term-locked",
        }),
      ],
      "2026-06-16T10:00:00.000Z",
    );

    const sourceAssetIds = await store.connectedSources.listSourceAssetIds(sourceId);
    const assets = await store.assets.readAssets();
    const trashedId = sourceAssetIds.find((id) => {
      const a = assets.find((x) => x.id === id)!;
      return a.liquidityTier === "term-locked";
    })!;

    // Trash the term-locked rung asset, then re-sync the SAME rung.
    await store.assets.softDeleteAsset(trashedId, "2026-06-17T09:00:00.000Z");

    await store.connectedSources.syncPositions(
      sourceId,
      [
        token({
          externalId: "ETH:locked-earn",
          symbol: "ETH",
          balance: "3",
          unitPrice: "2000",
          wallet: "locked-earn",
          liquidityTier: "term-locked",
        }),
      ],
      "2026-06-17T10:00:00.000Z",
    );

    // Reroll ignores the trashed asset (deletedAt IS NULL filter) and materializes a
    // fresh LIVE one — it does NOT resurrect the trashed row.
    const live = (await store.assets.readAssets()).filter(
      (a) => a.liquidityTier === "term-locked",
    );
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(trashedId);
    expect(live[0]!.currentValue.amountMinor).toBe(600_000);
    store.close();
  });
});

describe("syncConnectedSource (Binance) carries a token's last-good price forward", () => {
  test("a token re-synced with a null price keeps its prior value (never zeroed by a price miss)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectBinance(store);

    // First sync: WBETH priced cleanly (2 × 1 655 € = 3 310 €) alongside BNB.
    await store.syncConnectedSource({
      sourceId,
      positions: [
        token({
          externalId: "WBETH:flexible-earn",
          symbol: "WBETH",
          balance: "2",
          unitPrice: "1655",
          wallet: "flexible-earn",
        }),
        token({ externalId: "BNB:spot", symbol: "BNB", balance: "10", unitPrice: "500" }),
      ],
      syncedAt: "2026-06-21T07:00:00.000Z",
    });

    // Second sync: CoinGecko missed WBETH (null), BNB still priced. Without the
    // carry-forward this would zero WBETH; with it, the last-good price survives.
    await store.syncConnectedSource({
      sourceId,
      positions: [
        token({
          externalId: "WBETH:flexible-earn",
          symbol: "WBETH",
          balance: "2",
          unitPrice: null,
          wallet: "flexible-earn",
        }),
        token({ externalId: "BNB:spot", symbol: "BNB", balance: "10", unitPrice: "500" }),
      ],
      syncedAt: "2026-06-22T07:00:00.000Z",
    });

    const positions = await store.connectedSources.readPositions(sourceId);
    const wbeth = positions.find((p) => p.kind === "token" && p.symbol === "WBETH");
    expect(wbeth).toMatchObject({ unitPrice: "1655" }); // carried forward, not null

    const asset = (await store.assets.readAssets()).find((a) => a.id === assetId)!;
    expect(asset.currentValue.amountMinor).toBe(831_000); // 2×1 655 € + 10×500 € intact
    store.close();
  });

  test("a token never priced before stays null on a null re-sync (nothing to carry)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectBinance(store);

    await store.syncConnectedSource({
      sourceId,
      positions: [
        token({ externalId: "JEX:spot", symbol: "JEX", balance: "100", unitPrice: null }),
        token({ externalId: "BNB:spot", symbol: "BNB", balance: "10", unitPrice: "500" }),
      ],
      syncedAt: "2026-06-21T07:00:00.000Z",
    });
    await store.syncConnectedSource({
      sourceId,
      positions: [
        token({ externalId: "JEX:spot", symbol: "JEX", balance: "100", unitPrice: null }),
        token({ externalId: "BNB:spot", symbol: "BNB", balance: "10", unitPrice: "500" }),
      ],
      syncedAt: "2026-06-22T07:00:00.000Z",
    });

    const positions = await store.connectedSources.readPositions(sourceId);
    const jex = positions.find((p) => p.kind === "token" && p.symbol === "JEX");
    expect(jex).toMatchObject({ unitPrice: null }); // never priced → cannot fabricate

    const asset = (await store.assets.readAssets()).find((a) => a.id === assetId)!;
    expect(asset.currentValue.amountMinor).toBe(500_000); // only BNB counts
    store.close();
  });

  test("a freshly-fetched price always wins over the carried-forward one", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId, assetId } = await connectBinance(store);

    await store.syncConnectedSource({
      sourceId,
      positions: [
        token({ externalId: "BNB:spot", symbol: "BNB", balance: "10", unitPrice: "500" }),
      ],
      syncedAt: "2026-06-21T07:00:00.000Z",
    });
    await store.syncConnectedSource({
      sourceId,
      positions: [
        token({ externalId: "BNB:spot", symbol: "BNB", balance: "10", unitPrice: "509" }),
      ],
      syncedAt: "2026-06-22T07:00:00.000Z",
    });

    const asset = (await store.assets.readAssets()).find((a) => a.id === assetId)!;
    expect(asset.currentValue.amountMinor).toBe(509_000); // live quote, not the stale 500
    store.close();
  });
});

describe("manual crypto coexists with Binance (no duplicate detection)", () => {
  test("a hand-entered crypto investment and a Binance BTC both count", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    const { sourceId } = await connectBinance(store);
    await store.connectedSources.syncPositions(
      sourceId,
      [token({ balance: "0.5", unitPrice: "50000" })],
      "2026-06-16T10:00:00.000Z",
    );

    // The Binance source projects ONE holding; a separate manual crypto holding
    // would be its own asset — worthline never dedupes the two (manual-first).
    const cryptoAssets = (await store.assets.readAssets()).filter(
      (a) => a.instrument === "crypto",
    );
    expect(cryptoAssets).toHaveLength(1); // only the Binance-projected one exists here
    store.close();
  });
});
