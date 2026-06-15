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
    purchaseDate: "2024-01-01",
    purchasePriceMinor: 5_000,
    quantity: 1,
    weightGrams: null,
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
        position({
          catalogueId: "n1",
          externalId: "ext-1",
          name: "Coin A",
          purchasePriceMinor: 5_000,
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

    expect(holding(store, assetId).currentValue.amountMinor).toBe(12_500);

    const stored = store.connectedSources.readPositions(sourceId);
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

  test("persists and round-trips the indefinite detail + numismatic fetched-at", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId } = connectNumista(store);

    store.connectedSources.syncPositions(
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

    const stored = store.connectedSources.readPositions(sourceId);
    expect(stored[0]).toMatchObject({
      issueId: 32723,
      finenessMillis: 999,
      weightGrams: 31.103,
      numismaticFetchedAt: "2026-06-15T12:00:00.000Z",
    });
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

describe("connected-source store — revaluePositions", () => {
  test("updates candidates in place, re-rolls the holding, stamps freshness", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId, assetId } = connectNumista(store);

    store.connectedSources.syncPositions(
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
    expect(holding(store, assetId).currentValue.amountMinor).toBe(11609);

    const stored = store.connectedSources.readPositions(sourceId);
    const eagle = stored.find((p) => p.catalogueId === "1493")!;
    const pesetas = stored.find((p) => p.catalogueId === "5678")!;

    store.connectedSources.revaluePositions(
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
    expect(holding(store, assetId).currentValue.amountMinor).toBe(12058);

    const reread = store.connectedSources.readPositions(sourceId);
    expect(reread.find((p) => p.catalogueId === "1493")).toMatchObject({
      metalValueMinor: 3000,
      numismaticFetchedAt: "2026-07-15T12:00:00.000Z",
    });

    // The freshness row is the staleness indicator + the daily refresh trigger.
    expect(store.operations.readPriceCache(assetId)).toMatchObject({
      source: "numista",
      freshnessState: "fresh",
      fetchedAt: "2026-07-15T12:00:00.000Z",
    });
  });

  test("an outage freshness (stale + reason) keeps the last-known value", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId, assetId } = connectNumista(store);

    store.connectedSources.syncPositions(
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
    const eagle = store.connectedSources.readPositions(sourceId)[0]!;

    // Outage: keep last-known candidate values, mark the row stale with a reason.
    store.connectedSources.revaluePositions(
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

    expect(holding(store, assetId).currentValue.amountMinor).toBe(7558);
    expect(store.operations.readPriceCache(assetId)).toMatchObject({
      freshnessState: "stale",
      staleReason: "Numista no disponible",
    });
  });
});

describe("connected-source store — freezeIntoStoredHolding", () => {
  test("drops the source + positions, keeps the asset as a hand-valued precious_metal holding", () => {
    const store = createInMemoryStore();
    seed(store);
    const { sourceId, assetId } = connectNumista(store);

    store.connectedSources.syncPositions(
      sourceId,
      [
        position({ catalogueId: "n1", externalId: "ext-1", purchasePriceMinor: 5_000 }),
        position({ catalogueId: "n2", externalId: "ext-2", purchasePriceMinor: 7_500 }),
      ],
      "2024-06-01T10:00:00.000Z",
    );
    // A connected source carries a valuation-freshness price-cache row.
    store.connectedSources.revaluePositions(
      sourceId,
      store.connectedSources.readPositions(sourceId).map((p) => ({
        id: p.id,
        metalValueMinor: p.metalValueMinor,
        numismaticValueMinor: p.numismaticValueMinor,
        numismaticFetchedAt: p.numismaticFetchedAt,
      })),
      { fetchedAt: "2024-06-01T10:00:00.000Z", freshnessState: "fresh" },
    );
    expect(holding(store, assetId).currentValue.amountMinor).toBe(12_500);
    expect(store.operations.readPriceCache(assetId)).not.toBeNull();

    const result = store.connectedSources.freezeIntoStoredHolding(sourceId);
    expect(result).toEqual({ assetId });

    // The source + its positions are gone; frozen snapshots are untouched.
    expect(store.connectedSources.listSources()).toHaveLength(0);
    expect(store.connectedSources.readSource(sourceId)).toBeNull();
    expect(store.connectedSources.readPositions(sourceId)).toHaveLength(0);

    // The asset survives as a plain, hand-maintained precious-metal holding: same
    // frozen value, name and ownership, now valued by hand (stored) and eligible
    // for the manual value-update pass.
    const frozen = holding(store, assetId);
    expect(frozen.instrument).toBe("precious_metal");
    expect(frozen.liquidityTier).toBe("illiquid");
    expect(frozen.currentValue.amountMinor).toBe(12_500);
    expect(frozen.name).toBe("Colección Numista");
    expect(frozen.ownership).toEqual(ownerAll);
    expect(valuationMethodOfAsset(frozen)).toBe("stored");
    expect(isValueUpdateEligible(frozen)).toBe(true);

    // The orphaned connected-source price-cache row is cleared.
    expect(store.operations.readPriceCache(assetId)).toBeNull();
  });

  test("returns null for an unknown source and changes nothing", () => {
    const store = createInMemoryStore();
    seed(store);
    const { assetId } = connectNumista(store);

    expect(store.connectedSources.freezeIntoStoredHolding("missing")).toBeNull();
    expect(store.connectedSources.listSources()).toHaveLength(1);
    expect(holding(store, assetId).instrument).toBe("coin_collection");
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

describe("connected-source store — migration", () => {
  // Fresh-DB table-existence + version assertion: a raw better-sqlite3 DB run
  // through `migrate` lands at SCHEMA_VERSION with both tables present, and the
  // positions table carries the v21 external_id column (the cross-sync trade key,
  // #167) added by the ladder after the v19 CREATE TABLE.
  test("migrate creates connected_sources + positions and adds external_id", () => {
    const db = new Database(":memory:");
    migrate(db);

    const tableNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);

    expect(tableNames).toContain("connected_sources");
    expect(tableNames).toContain("positions");

    const positionColumns = (
      db.prepare("PRAGMA table_info(positions)").all() as { name: string }[]
    ).map((row) => row.name);
    expect(positionColumns).toContain("external_id");

    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(21);

    db.close();
  });

  // The v20 decoupled-valuation columns (PRD #166): present on a fresh DB and,
  // crucially, idempotent — the v20 ALTERs are guarded so a fresh DB (which gets
  // them from schema-sql) does not double-add and throw.
  test("positions carries the v20 valuation-refresh columns", () => {
    const db = new Database(":memory:");
    migrate(db);

    const columns = (
      db.prepare("PRAGMA table_info(positions)").all() as { name: string }[]
    ).map((row) => row.name);

    expect(columns).toEqual(
      expect.arrayContaining([
        "issue_id",
        "fineness_millis",
        "weight_grams",
        "numismatic_fetched_at",
      ]),
    );

    db.close();
  });

  // An existing v19 DB (connected_sources/positions present, old positions shape)
  // upgrades cleanly to v20: the ALTERs add the four columns to real data.
  test("upgrades a v19 database to v20 by adding the columns", () => {
    const db = new Database(":memory:");
    // Stand up the v19 positions shape, then mark the DB as v19 so migrate runs
    // only the v20 step against it (the real upgrade path, not the fresh-DB path).
    db.exec(`CREATE TABLE positions (
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
    db.pragma("user_version = 19");

    migrate(db);

    const columns = (
      db.prepare("PRAGMA table_info(positions)").all() as { name: string }[]
    ).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "issue_id",
        "fineness_millis",
        "weight_grams",
        "numismatic_fetched_at",
      ]),
    );
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);

    db.close();
  });
});
