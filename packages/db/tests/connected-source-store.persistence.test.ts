/**
 * Connected-source persistence (PRD #160 / #163, ADR 0016/0017).
 *
 * Integration tests against a real in-memory store: `connect` materializes a
 * derived coin-collection holding, `syncPositions` replaces positions and
 * re-rolls the holding's value from its positions (never hand-set), token round
 * trips, and the v19 migration creates the two tables.
 */
import {
  isValueUpdateEligible,
  valuationMethodOfAsset,
  type ManualAsset,
} from "@worthline/domain";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "../src/index";
import type { SourcePositionInput, WorthlineStore } from "../src/index";
import { migrate, SCHEMA_VERSION } from "../src/migrate";

const MEMBER_ID = "mJ";

function seed(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
}

/** A position to sync, with sensible defaults the test can override. */
function position(overrides: Partial<SourcePositionInput> = {}): SourcePositionInput {
  return {
    catalogueId: "n123",
    currency: "EUR",
    grade: "VF",
    liquidityTier: "illiquid",
    metal: "silver",
    name: "8 reales",
    purchaseDate: "2024-01-01",
    purchasePriceMinor: 5_000,
    quantity: 1,
    ...overrides,
  };
}

const ownerAll = [{ memberId: MEMBER_ID, shareBps: 10_000 }];

function connectNumista(store: WorthlineStore): { sourceId: string; assetId: string } {
  return store.connectedSources.connect({
    adapter: "numista",
    credentialsJson: JSON.stringify({ apiKey: "secret" }),
    label: "Colección Numista",
    ownership: ownerAll,
  });
}

function holding(store: WorthlineStore, assetId: string): ManualAsset {
  const asset = store.assets.readAssets().find((a) => a.id === assetId);
  expect(asset).toBeDefined();
  return asset!;
}

describe("connected-source store — connect", () => {
  test("materializes a derived, illiquid coin collection valued at 0, owned 100%", () => {
    const store = createInMemoryStore();
    seed(store);

    const { sourceId, assetId } = connectNumista(store);

    const asset = holding(store, assetId);
    expect(asset.instrument).toBe("coin_collection");
    expect(asset.liquidityTier).toBe("illiquid");
    expect(asset.currentValue.amountMinor).toBe(0);
    expect(asset.ownership).toEqual(ownerAll);

    // A connected-source holding is derived from its positions — excluded from
    // the manual value-update pass (ADR 0014/0016).
    expect(valuationMethodOfAsset(asset)).toBe("derived");
    expect(isValueUpdateEligible(asset)).toBe(false);

    const source = store.connectedSources.readSource(sourceId);
    expect(source).toMatchObject({
      adapter: "numista",
      assetId,
      label: "Colección Numista",
      lastSyncAt: null,
      tokenJson: null,
    });
    expect(store.connectedSources.listSources()).toHaveLength(1);
  });
});

describe("connected-source store — syncPositions", () => {
  test("persists positions and rolls the holding value to the sum of prices", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId, assetId } = connectNumista(store);

    store.connectedSources.syncPositions(
      sourceId,
      [
        position({ catalogueId: "n1", name: "Coin A", purchasePriceMinor: 5_000 }),
        position({ catalogueId: "n2", name: "Coin B", purchasePriceMinor: 7_500 }),
      ],
      "2024-06-01T10:00:00.000Z",
    );

    expect(holding(store, assetId).currentValue.amountMinor).toBe(12_500);

    const stored = store.connectedSources.readPositions(sourceId);
    expect(stored).toHaveLength(2);
    expect(stored.map((p) => p.catalogueId).sort()).toEqual(["n1", "n2"]);
    expect(stored.find((p) => p.catalogueId === "n1")).toMatchObject({
      catalogueId: "n1",
      currency: "EUR",
      grade: "VF",
      liquidityTier: "illiquid",
      metal: "silver",
      name: "Coin A",
      purchaseDate: "2024-01-01",
      purchasePriceMinor: 5_000,
      quantity: 1,
      sourceId,
    });
  });

  test("re-sync replaces positions and re-rolls the value", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId, assetId } = connectNumista(store);

    store.connectedSources.syncPositions(
      sourceId,
      [
        position({ catalogueId: "keep", purchasePriceMinor: 5_000 }),
        position({ catalogueId: "drop", purchasePriceMinor: 9_000 }),
      ],
      "2024-06-01T10:00:00.000Z",
    );
    expect(holding(store, assetId).currentValue.amountMinor).toBe(14_000);

    store.connectedSources.syncPositions(
      sourceId,
      [
        position({ catalogueId: "keep", purchasePriceMinor: 5_000 }),
        position({ catalogueId: "new", purchasePriceMinor: 3_000 }),
      ],
      "2024-07-01T10:00:00.000Z",
    );

    const stored = store.connectedSources.readPositions(sourceId);
    expect(stored.map((p) => p.catalogueId).sort()).toEqual(["keep", "new"]);
    expect(stored.some((p) => p.catalogueId === "drop")).toBe(false);
    expect(holding(store, assetId).currentValue.amountMinor).toBe(8_000);
  });

  test("a null purchase price contributes 0 but is still stored", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId, assetId } = connectNumista(store);

    store.connectedSources.syncPositions(
      sourceId,
      [
        position({ catalogueId: "priced", purchasePriceMinor: 4_000 }),
        position({ catalogueId: "unpriced", purchasePriceMinor: null }),
      ],
      "2024-06-01T10:00:00.000Z",
    );

    expect(holding(store, assetId).currentValue.amountMinor).toBe(4_000);

    const stored = store.connectedSources.readPositions(sourceId);
    expect(stored).toHaveLength(2);
    const unpriced = stored.find((p) => p.catalogueId === "unpriced");
    expect(unpriced?.purchasePriceMinor).toBeNull();
  });
});

describe("connected-source store — token + last sync", () => {
  test("saveToken round-trips and a sync stamps lastSyncAt", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId } = connectNumista(store);

    const tokenJson = JSON.stringify({ accessToken: "abc", expiresAt: 123 });
    store.connectedSources.saveToken(sourceId, tokenJson);
    expect(store.connectedSources.readSource(sourceId)?.tokenJson).toBe(tokenJson);
    expect(store.connectedSources.readSource(sourceId)?.lastSyncAt).toBeNull();

    store.connectedSources.syncPositions(
      sourceId,
      [position()],
      "2024-08-15T09:00:00.000Z",
    );
    expect(store.connectedSources.readSource(sourceId)?.lastSyncAt).toBe(
      "2024-08-15T09:00:00.000Z",
    );
    // The token is untouched by a sync.
    expect(store.connectedSources.readSource(sourceId)?.tokenJson).toBe(tokenJson);
  });
});

describe("connected-source store — v19 migration", () => {
  // Fresh-DB table-existence + version assertion: a raw better-sqlite3 DB run
  // through `migrate` lands at SCHEMA_VERSION (19) with both tables present.
  // (Fresh-DB path, not an explicit 18→19 upgrade — connected_sources / positions
  //  are brand-new tables with no prior data to migrate.)
  test("migrate creates connected_sources and positions and reaches v19", () => {
    const db = new Database(":memory:");
    migrate(db);

    const tableNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);

    expect(tableNames).toContain("connected_sources");
    expect(tableNames).toContain("positions");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(19);

    db.close();
  });
});
