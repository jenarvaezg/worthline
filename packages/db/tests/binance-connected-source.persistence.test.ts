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
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "../src/index";
import type { SourcePositionInput, WorthlineStore } from "../src/index";

const MEMBER_ID = "mJ";

function seed(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
}

function connectBinance(store: WorthlineStore): { sourceId: string; assetId: string } {
  return store.connectedSources.connect({
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
    currency: "EUR" as const,
    ...overrides,
  };
}

describe("connect (Binance) materializes a market-rung crypto holding", () => {
  test("the holding is a derived crypto asset on the market rung, valued 0 before sync", () => {
    const store = createInMemoryStore();
    seed(store);
    const { assetId } = connectBinance(store);

    const asset = store.assets.readAssets().find((a) => a.id === assetId)!;
    expect(asset.instrument).toBe("crypto");
    expect(asset.liquidityTier).toBe("market");
    expect(asset.currentValue.amountMinor).toBe(0);
    store.close();
  });
});

describe("syncPositions (Binance) re-rolls the holding LIVE as Σ(balance × price)", () => {
  test("spot tokens roll up to the live market value and persist their balances", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId, assetId } = connectBinance(store);

    store.connectedSources.syncPositions(
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

    const asset = store.assets.readAssets().find((a) => a.id === assetId)!;
    expect(asset.currentValue.amountMinor).toBe(2_900_000); // 25 000 € + 4 000 €

    const positions = store.connectedSources.readPositions(sourceId);
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

  test("the SAME token on spot + funding sums into one holding value (#247)", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId, assetId } = connectBinance(store);

    // BTC parked on two market wallets — distinct externalIds, one symbol.
    store.connectedSources.syncPositions(
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

    const asset = store.assets.readAssets().find((a) => a.id === assetId)!;
    expect(asset.currentValue.amountMinor).toBe(3_000_000); // both wallets summed

    // Both positions persist with their wallet origin (#247 metadata).
    const positions = store.connectedSources.readPositions(sourceId);
    expect(positions).toHaveLength(2);
    expect(positions.map((p) => (p.kind === "token" ? p.wallet : null)).sort()).toEqual([
      "funding",
      "spot",
    ]);
    store.close();
  });

  test("an unpriceable token (null price) contributes 0 but is still persisted", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId, assetId } = connectBinance(store);

    store.connectedSources.syncPositions(
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

    const asset = store.assets.readAssets().find((a) => a.id === assetId)!;
    expect(asset.currentValue.amountMinor).toBe(2_500_000); // only the BTC counts

    const positions = store.connectedSources.readPositions(sourceId);
    expect(positions).toHaveLength(2);
    const wagmi = positions.find((p) => p.kind === "token" && p.symbol === "WAGMI");
    expect(wagmi).toMatchObject({ symbol: "WAGMI", balance: "100", unitPrice: null });
    store.close();
  });

  test("a re-sync replaces balances and re-rolls (sells/buys reflected wholesale)", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId, assetId } = connectBinance(store);

    store.connectedSources.syncPositions(
      sourceId,
      [token({ balance: "0.5", unitPrice: "50000" })],
      "2026-06-16T10:00:00.000Z",
    );
    // A later sync: balance grew, price moved.
    store.connectedSources.syncPositions(
      sourceId,
      [token({ balance: "1", unitPrice: "60000" })],
      "2026-06-17T10:00:00.000Z",
    );

    const asset = store.assets.readAssets().find((a) => a.id === assetId)!;
    expect(asset.currentValue.amountMinor).toBe(6_000_000); // 1 × 60 000 €
    expect(store.connectedSources.readPositions(sourceId)).toHaveLength(1);
    store.close();
  });
});

describe("syncPositions (Binance) materializes ONE asset per rung (S3, #248)", () => {
  test("spot + locked-earn → a market crypto asset AND a term-locked one, both linked", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId, assetId } = connectBinance(store);

    store.connectedSources.syncPositions(
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

    const crypto = store.assets
      .readAssets()
      .filter((a) => a.instrument === "crypto")
      .sort((a, b) => a.liquidityTier.localeCompare(b.liquidityTier));
    expect(crypto).toHaveLength(2);

    const byTier = new Map(crypto.map((a) => [a.liquidityTier, a]));
    expect(byTier.get("market")!.id).toBe(assetId); // the primary asset keeps the id
    expect(byTier.get("market")!.currentValue.amountMinor).toBe(2_500_000);
    expect(byTier.get("term-locked")!.currentValue.amountMinor).toBe(600_000);

    const termLockedAssetId = byTier.get("term-locked")!.id;

    // Both assets are linked to the source; listSourceAssetIds returns both.
    const ids = store.connectedSources.listSourceAssetIds(sourceId);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(assetId);
    expect(ids).toContain(termLockedAssetId);

    // readSourceIdForAsset resolves the source from EITHER rung asset (#248): the
    // market (primary) one AND the term-locked one — the term-locked asset's id is
    // distinct from connected_sources.asset_id (the primary), yet still routes back.
    expect(store.connectedSources.readSourceIdForAsset(assetId)).toBe(sourceId);
    expect(store.connectedSources.readSourceIdForAsset(termLockedAssetId)).toBe(sourceId);
    expect(termLockedAssetId).not.toBe(assetId);

    // The term-locked asset inherits the source's ownership (the ownership-copy
    // branch in rerollSourceHoldings) — 100 % the connecting member.
    const termLocked = store.assets.readAssets().find((a) => a.id === termLockedAssetId)!;
    expect(termLocked.ownership).toEqual([{ memberId: MEMBER_ID, shareBps: 10_000 }]);
    store.close();
  });

  test("a later sync that empties the locked rung sets the term-locked asset to 0 (kept, not deleted)", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId } = connectBinance(store);

    store.connectedSources.syncPositions(
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

    const lockedId = store.connectedSources.listSourceAssetIds(sourceId).find((id) => {
      const a = store.assets.readAssets().find((x) => x.id === id)!;
      return a.liquidityTier === "term-locked";
    })!;

    // A later sync redeemed the locked position — only spot remains.
    store.connectedSources.syncPositions(
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
    const locked = store.assets.readAssets().find((a) => a.id === lockedId);
    expect(locked).toBeDefined();
    expect(locked!.currentValue.amountMinor).toBe(0);
    // It is still the source's asset, so the link is intact.
    expect(store.connectedSources.listSourceAssetIds(sourceId)).toContain(lockedId);
    store.close();
  });

  test("re-sync materializes a FRESH live asset for a rung whose prior asset was trashed (#248, FIX 6)", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId } = connectBinance(store);

    store.connectedSources.syncPositions(
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

    const trashedId = store.connectedSources.listSourceAssetIds(sourceId).find((id) => {
      const a = store.assets.readAssets().find((x) => x.id === id)!;
      return a.liquidityTier === "term-locked";
    })!;

    // Trash the term-locked rung asset, then re-sync the SAME rung.
    store.assets.softDeleteAsset(trashedId, "2026-06-17T09:00:00.000Z");

    store.connectedSources.syncPositions(
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
    const live = store.assets
      .readAssets()
      .filter((a) => a.liquidityTier === "term-locked");
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(trashedId);
    expect(live[0]!.currentValue.amountMinor).toBe(600_000);
    store.close();
  });
});

describe("manual crypto coexists with Binance (no duplicate detection)", () => {
  test("a hand-entered crypto investment and a Binance BTC both count", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId } = connectBinance(store);
    store.connectedSources.syncPositions(
      sourceId,
      [token({ balance: "0.5", unitPrice: "50000" })],
      "2026-06-16T10:00:00.000Z",
    );

    // The Binance source projects ONE holding; a separate manual crypto holding
    // would be its own asset — worthline never dedupes the two (manual-first).
    const cryptoAssets = store.assets
      .readAssets()
      .filter((a) => a.instrument === "crypto");
    expect(cryptoAssets).toHaveLength(1); // only the Binance-projected one exists here
    store.close();
  });
});
