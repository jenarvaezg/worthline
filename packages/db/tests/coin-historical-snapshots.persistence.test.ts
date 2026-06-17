/**
 * Coin purchase-date ripple into snapshot history (ADR 0017, S6 / #167).
 *
 * Integration tests against a real in-memory store. A coin's purchase date is a
 * dated fact about the past: syncing the Numista collection ripples existing
 * snapshots from that date forward, stamping the coin's value AT RIPPLE TIME and
 * freezing it — a later price move never rewrites a past snapshot, and a sold
 * coin drops from the live holding while staying in history. Mirrors the
 * historical-snapshots persistence style (recordBuy seeds the past snapshots the
 * coins then ripple into).
 */
import { describe, expect, test } from "vitest";

import type { CoinPosition } from "@worthline/domain";

import { createInMemoryStore } from "../src/index";
import type { SourcePositionInput, WorthlineStore } from "../src/index";

const TODAY = "2026-06-15";
const MEMBER_ID = "mJ";

function seed(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
  store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    name: "Fondo indexado",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
}

/** A backdated buy that generates the snapshot at its date (the past snapshots
 *  the coin ripple later lands in). The no-price fund freezes at cost basis. */
function recordBuy(
  store: WorthlineStore,
  executedAt: string,
  units: string,
  price: string,
): void {
  store.recordOperationAndRipple(
    {
      assetId: "fund",
      currency: "EUR",
      executedAt,
      feesMinor: 0,
      id: `op_${executedAt}_${units}`,
      kind: "buy",
      pricePerUnit: price,
      units,
    },
    { today: TODAY },
  );
}

function connectNumista(store: WorthlineStore): { sourceId: string; assetId: string } {
  return store.connectedSources.connect({
    adapter: "numista",
    credentialsJson: JSON.stringify({ apiKey: "secret" }),
    label: "Colección Numista",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
}

/** A coin position, numismatic-valued by default so its coinValue == the figure
 *  passed in (metal/purchase candidates left absent). */
function coin(
  externalId: string,
  purchaseDate: string | null,
  valueMinor: number,
  overrides: Partial<Omit<CoinPosition, "id" | "sourceId">> = {},
): Omit<CoinPosition, "id" | "sourceId"> {
  return {
    kind: "coin",
    catalogueId: `cat-${externalId}`,
    currency: "EUR",
    externalId,
    finenessMillis: null,
    grade: "unc",
    issueId: null,
    liquidityTier: "illiquid",
    metal: "silver",
    metalValueMinor: null,
    name: `Coin ${externalId}`,
    numismaticFetchedAt: null,
    numismaticValueMinor: valueMinor,
    obverseThumbUrl: null,
    purchaseDate,
    purchasePriceMinor: null,
    quantity: 1,
    weightGrams: null,
    year: null,
    ...overrides,
  };
}

function syncCoins(
  store: WorthlineStore,
  sourceId: string,
  positions: SourcePositionInput[],
  syncedAt = "2026-06-15T10:00:00.000Z",
): void {
  store.syncConnectedSource({ positions, sourceId, syncedAt });
}

function grossAt(store: WorthlineStore, dateKey: string): number | undefined {
  return store.snapshots.readSnapshots().find((snap) => snap.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

/** The live rolled-up value of the coin-collection holding. */
function liveCoinValue(store: WorthlineStore, assetId: string): number {
  return store.assets.readAssets().find((a) => a.id === assetId)!.currentValue
    .amountMinor;
}

describe("coin purchase-date ripple into snapshot history", () => {
  test("a coin ripples existing snapshots from its purchase date forward, not before", () => {
    const store = createInMemoryStore();
    seed(store);
    // Two past snapshots straddling the coin's purchase date.
    recordBuy(store, "2024-01-10", "10", "100"); // fund 1000.00
    recordBuy(store, "2024-03-01", "5", "200"); // fund cost basis 10×100 + 5×200 = 2000.00
    expect(grossAt(store, "2024-01-10")).toBe(10 * 100_00);
    expect(grossAt(store, "2024-03-01")).toBe(10 * 100_00 + 5 * 200_00);

    const { sourceId } = connectNumista(store);
    // A coin acquired 2024-02-01, worth 300.00 at ripple time.
    syncCoins(store, sourceId, [coin("c1", "2024-02-01", 300_00)]);

    // Before the purchase date → untouched. On/after it → the coin is added.
    expect(grossAt(store, "2024-01-10")).toBe(10 * 100_00);
    expect(grossAt(store, "2024-03-01")).toBe(10 * 100_00 + 5 * 200_00 + 300_00);
    store.close();
  });

  test("each new trade ripples only from its own purchase date", () => {
    const store = createInMemoryStore();
    seed(store);
    // A snapshot between the two coins' dates, and one after both.
    recordBuy(store, "2024-02-15", "10", "100"); // fund 1000.00
    recordBuy(store, "2024-03-15", "5", "100"); // fund cost basis 1500.00

    const { sourceId } = connectNumista(store);
    syncCoins(store, sourceId, [
      coin("x", "2024-02-01", 200_00), // before both snapshots
      coin("y", "2024-03-01", 50_00), // after the first snapshot, before the second
    ]);

    // 2024-02-15 sees only coin x (y's date is later); 2024-03-15 sees both.
    expect(grossAt(store, "2024-02-15")).toBe(1_000_00 + 200_00);
    expect(grossAt(store, "2024-03-15")).toBe(1_500_00 + 200_00 + 50_00);
    store.close();
  });

  test("a later price move never rewrites a rippled past snapshot (frozen)", () => {
    const store = createInMemoryStore();
    seed(store);
    recordBuy(store, "2024-03-01", "10", "100"); // fund 1000.00

    const { sourceId, assetId } = connectNumista(store);
    syncCoins(store, sourceId, [coin("c1", "2024-01-01", 100_00)]);
    expect(grossAt(store, "2024-03-01")).toBe(1_000_00 + 100_00);

    // Re-sync the SAME trade (same external id) with a higher numismatic value.
    syncCoins(
      store,
      sourceId,
      [coin("c1", "2024-01-01", 500_00)],
      "2026-06-15T11:00:00.000Z",
    );

    // The live holding reflects the new price; the past snapshot stays frozen at
    // the value stamped on the first sync (ADR 0017) — never re-valued to 500.
    expect(liveCoinValue(store, assetId)).toBe(500_00);
    expect(grossAt(store, "2024-03-01")).toBe(1_000_00 + 100_00);
    store.close();
  });

  test("a sold coin leaves the live holding but stays in past snapshots", () => {
    const store = createInMemoryStore();
    seed(store);
    recordBuy(store, "2024-03-01", "10", "100"); // fund 1000.00

    const { sourceId, assetId } = connectNumista(store);
    syncCoins(store, sourceId, [
      coin("a", "2024-01-01", 100_00),
      coin("b", "2024-02-01", 200_00),
    ]);
    expect(liveCoinValue(store, assetId)).toBe(300_00);
    expect(grossAt(store, "2024-03-01")).toBe(1_000_00 + 300_00);

    // Coin b is sold on Numista → next sync drops it (a keeps its external id).
    syncCoins(
      store,
      sourceId,
      [coin("a", "2024-01-01", 100_00)],
      "2026-06-15T11:00:00.000Z",
    );

    // It left the live holding; the past snapshot it was rippled into is intact.
    expect(liveCoinValue(store, assetId)).toBe(100_00);
    expect(grossAt(store, "2024-03-01")).toBe(1_000_00 + 300_00);
    store.close();
  });

  test("a coin with no purchase date is not rippled into history", () => {
    const store = createInMemoryStore();
    seed(store);
    recordBuy(store, "2024-03-01", "10", "100"); // fund 1000.00

    const { sourceId, assetId } = connectNumista(store);
    syncCoins(store, sourceId, [coin("nd", null, 100_00)]);

    // It counts in the live holding but has no dated fact, so no past snapshot moves.
    expect(liveCoinValue(store, assetId)).toBe(100_00);
    expect(grossAt(store, "2024-03-01")).toBe(1_000_00);
    store.close();
  });
});

describe("coin collection in freshly generated past snapshots", () => {
  test("a snapshot generated before the purchase date excludes the collection; after it includes it", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId } = connectNumista(store);
    // A coin acquired 2024-06-01, worth 300 — synced while NO snapshots exist yet
    // (so the #167 ripple has nothing to touch; only fresh generation will).
    syncCoins(store, sourceId, [coin("c1", "2024-06-01", 300_00)]);

    // Backdated fund ops GENERATE fresh snapshots straddling the coin's date.
    recordBuy(store, "2020-01-01", "10", "100"); // before the coin
    recordBuy(store, "2024-12-01", "5", "100"); // after the coin

    // 2020 predates the coin → the collection is valued at 0 (no row), NOT its
    // full current value (the bug this fixes).
    expect(grossAt(store, "2020-01-01")).toBe(10 * 100_00);
    // 2024-12 is after the purchase date → the coin is included, frozen at gen time.
    expect(grossAt(store, "2024-12-01")).toBe(15 * 100_00 + 300_00);
    store.close();
  });

  test("fresh generation agrees with the #167 ripple on a shared date", () => {
    // Two stores, same facts in different order, must land on the same figure for
    // 2024-12-01: one reaches it by fresh generation, the other by the ripple.
    const viaGeneration = createInMemoryStore();
    seed(viaGeneration);
    {
      const { sourceId } = connectNumista(viaGeneration);
      syncCoins(viaGeneration, sourceId, [coin("c1", "2024-06-01", 300_00)]);
      recordBuy(viaGeneration, "2024-12-01", "5", "100"); // generates the snapshot
    }

    const viaRipple = createInMemoryStore();
    seed(viaRipple);
    {
      recordBuy(viaRipple, "2024-12-01", "5", "100"); // snapshot exists first
      const { sourceId } = connectNumista(viaRipple);
      syncCoins(viaRipple, sourceId, [coin("c1", "2024-06-01", 300_00)]); // ripples it
    }

    expect(grossAt(viaGeneration, "2024-12-01")).toBe(grossAt(viaRipple, "2024-12-01"));
    expect(grossAt(viaGeneration, "2024-12-01")).toBe(5 * 100_00 + 300_00);
    viaGeneration.close();
    viaRipple.close();
  });
});
