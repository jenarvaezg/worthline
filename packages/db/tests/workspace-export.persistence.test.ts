import type { AssetPrice, NetWorthSnapshot } from "@worthline/domain";
import { EXPORT_VERSION } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "../src/index";
import type { WorthlineStore } from "../src/index";

/**
 * Seed a workspace that touches every export section through the public store
 * API: members (incl. one disabled), a group, hand-valued assets, an
 * investment with metadata + operations, a liability tied to an asset, a
 * warning override, FIRE config, a snapshot with holdings, trashed holdings
 * (incl. a trashed investment), and price-cache entries.
 */
function seedFullWorkspace(store: WorthlineStore): void {
  store.initializeWorkspace({
    groups: [{ id: "g1", memberIds: ["m1", "m2"], name: "Familia" }],
    members: [
      { id: "m1", name: "Alice" },
      { id: "m2", name: "Bob" },
    ],
    mode: "household",
  });
  store.createMember({ id: "m3", name: "Carol" });
  store.disableMember("m3", "2026-01-15T00:00:00.000Z");

  store.createManualAsset({
    currency: "EUR",
    currentValueMinor: 500000,
    id: "a_cash",
    liquidityTier: "cash",
    name: "Cuenta ING",
    ownership: [{ memberId: "m1", shareBps: 10000 }],
    type: "cash",
  });
  store.createManualAsset({
    currency: "EUR",
    currentValueMinor: 30000000,
    id: "a_home",
    isPrimaryResidence: true,
    liquidityTier: "housing",
    name: "Piso Madrid",
    ownership: [
      { memberId: "m1", shareBps: 5000 },
      { memberId: "m2", shareBps: 5000 },
    ],
    type: "real_estate",
  });
  store.createInvestmentAsset({
    currency: "EUR",
    id: "a_inv",
    isin: "IE00BK5BQT80",
    manualPricePerUnit: "105.5",
    name: "Fondo Indexado",
    ownership: [
      { memberId: "m1", shareBps: 5000 },
      { memberId: "m2", shareBps: 5000 },
    ],
    providerSymbol: "VWCE.DE",
    unitSymbol: "VWCE",
  });
  store.recordOperation({
    assetId: "a_inv",
    currency: "EUR",
    executedAt: "2026-01-10T00:00:00.000Z",
    feesMinor: 150,
    id: "op1",
    kind: "buy",
    pricePerUnit: "100",
    units: "10",
  });

  store.createLiability({
    associatedAssetId: "a_home",
    balanceMinor: 12000000,
    currency: "EUR",
    id: "l_mort",
    name: "Hipoteca",
    ownership: [
      { memberId: "m1", shareBps: 5000 },
      { memberId: "m2", shareBps: 5000 },
    ],
    type: "mortgage",
  });

  store.acknowledgeWarning("primary_residence_owned", "a_home");
  store.saveFireConfig("m1", {
    expectedRealReturn: 0.07,
    monthlySpendingMinor: 200000,
    safeWithdrawalRate: 0.04,
  });

  const snapshot: NetWorthSnapshot = {
    capturedAt: "2026-02-01T10:00:00.000Z",
    dateKey: "2026-02-01",
    debts: { amountMinor: 120000, currency: "EUR" },
    grossAssets: { amountMinor: 605500, currency: "EUR" },
    housingEquity: { amountMinor: 0, currency: "EUR" },
    id: "snap1",
    isMonthlyClose: true,
    liquidNetWorth: { amountMinor: 485500, currency: "EUR" },
    monthKey: "2026-02",
    scopeId: "m1",
    scopeLabel: "Alice",
    totalNetWorth: { amountMinor: 485500, currency: "EUR" },
    warnings: [],
  };
  store.saveSnapshot({
    holdings: [
      {
        holdingId: "a_cash",
        kind: "asset",
        label: "Cuenta ING",
        liquidityTier: "cash",
        valueMinor: 500000,
      },
      {
        holdingId: "a_inv",
        kind: "asset",
        label: "Fondo Indexado",
        liquidityTier: "market",
        unitPrice: "105.5",
        units: "10",
        valueMinor: 105500,
      },
      {
        holdingId: "l_mort",
        kind: "liability",
        label: "Hipoteca",
        liquidityTier: null,
        valueMinor: 120000,
      },
    ],
    snapshot,
  });

  // A trashed hand-valued asset, a trashed investment (metadata + operations
  // must survive in the export), and a trashed liability.
  store.createManualAsset({
    currency: "EUR",
    currentValueMinor: 75000,
    id: "a_old",
    liquidityTier: "illiquid",
    name: "Coche viejo",
    ownership: [{ memberId: "m2", shareBps: 10000 }],
    type: "manual",
  });
  store.softDeleteAsset("a_old", "2026-03-01T00:00:00.000Z");

  store.createInvestmentAsset({
    currency: "EUR",
    id: "a_inv2",
    name: "Cripto vieja",
    ownership: [{ memberId: "m1", shareBps: 10000 }],
    unitSymbol: "BTC",
  });
  store.recordOperation({
    assetId: "a_inv2",
    currency: "EUR",
    executedAt: "2026-02-20T00:00:00.000Z",
    id: "op2",
    kind: "buy",
    pricePerUnit: "50000",
    units: "0.1",
  });
  store.softDeleteAsset("a_inv2", "2026-04-01T00:00:00.000Z");

  store.createLiability({
    balanceMinor: 30000,
    currency: "EUR",
    id: "l_old",
    name: "Préstamo viejo",
    ownership: [{ memberId: "m1", shareBps: 10000 }],
    type: "debt",
  });
  store.softDeleteLiability("l_old", "2026-04-02T00:00:00.000Z");

  store.upsertPrice({
    assetId: "a_inv",
    currency: "EUR",
    fetchedAt: "2026-06-10T18:00:00.000Z",
    freshnessState: "fresh",
    price: "106.20",
    priceDate: "2026-06-10",
    source: "stooq",
  });
  store.upsertPrice({
    assetId: "a_inv2",
    currency: "EUR",
    fetchedAt: "2026-05-01T00:00:00.000Z",
    freshnessState: "stale",
    price: "48000",
    source: "manual",
    staleReason: "price older than its source TTL",
  });
}

describe("exportWorkspace", () => {
  test("captures every section of the workspace", () => {
    const store = createInMemoryStore();
    seedFullWorkspace(store);

    const doc = store.exportWorkspace();

    expect(doc.version).toBe(EXPORT_VERSION);
    expect(doc.workspace).toEqual({ baseCurrency: "EUR", mode: "household" });

    // Members: all three, the disabled one carrying disabledAt.
    expect(doc.members.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(doc.members[2]).toEqual({
      disabledAt: "2026-01-15T00:00:00.000Z",
      id: "m3",
      name: "Carol",
    });
    expect("disabledAt" in doc.members[0]!).toBe(false);

    expect(doc.groups).toEqual([{ id: "g1", memberIds: ["m1", "m2"], name: "Familia" }]);

    // Live assets only — trashed ones must not appear here.
    expect(doc.assets.map((a) => a.id)).toEqual(["a_cash", "a_home", "a_inv"]);

    const cash = doc.assets.find((a) => a.id === "a_cash")!;
    expect(cash).toStrictEqual({
      currency: "EUR",
      currentValue: { amountMinor: 500000, currency: "EUR" },
      id: "a_cash",
      isPrimaryResidence: false,
      liquidityTier: "cash",
      name: "Cuenta ING",
      ownership: [{ memberId: "m1", shareBps: 10000 }],
      type: "cash",
    });

    const home = doc.assets.find((a) => a.id === "a_home")!;
    expect(home.isPrimaryResidence).toBe(true);
    expect(home.currentValue).toEqual({ amountMinor: 30000000, currency: "EUR" });

    // Investments: no currentValue (derived, ADR 0006), metadata nested.
    const inv = doc.assets.find((a) => a.id === "a_inv")!;
    expect("currentValue" in inv).toBe(false);
    expect(inv.investment).toBeDefined();
    expect(inv.investment!.unitSymbol).toBe("VWCE");
    expect(inv.investment!.isin).toBe("IE00BK5BQT80");
    expect(inv.investment!.providerSymbol).toBe("VWCE.DE");
    expect(inv.investment!.manualPricePerUnit).toBe("105.5");
    expect(typeof inv.investment!.manualPricedAt).toBe("string");

    // Liabilities: live only, associatedAssetId carried when set.
    expect(doc.liabilities.map((l) => l.id)).toEqual(["l_mort"]);
    expect(doc.liabilities[0]).toStrictEqual({
      associatedAssetId: "a_home",
      currency: "EUR",
      currentBalance: { amountMinor: 12000000, currency: "EUR" },
      id: "l_mort",
      name: "Hipoteca",
      ownership: [
        { memberId: "m1", shareBps: 5000 },
        { memberId: "m2", shareBps: 5000 },
      ],
      type: "mortgage",
    });

    // Operations for ALL investments — including the trashed one.
    expect(doc.operations.map((op) => op.id).sort()).toEqual(["op1", "op2"]);
    expect(doc.operations.find((op) => op.id === "op1")).toEqual({
      assetId: "a_inv",
      currency: "EUR",
      executedAt: "2026-01-10T00:00:00.000Z",
      feesMinor: 150,
      id: "op1",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });

    expect(doc.warningOverrides).toEqual([
      { code: "primary_residence_owned", entityId: "a_home" },
    ]);
    expect(doc.fireConfig).toEqual({
      m1: {
        expectedRealReturn: 0.07,
        monthlySpendingMinor: 200000,
        safeWithdrawalRate: 0.04,
      },
    });

    // Snapshots: full NetWorthSnapshot shape plus holdings in insertion order.
    expect(doc.snapshots).toHaveLength(1);
    const snap = doc.snapshots[0]!;
    expect(snap.id).toBe("snap1");
    expect(snap.scopeId).toBe("m1");
    expect(snap.scopeLabel).toBe("Alice");
    expect(snap.capturedAt).toBe("2026-02-01T10:00:00.000Z");
    expect(snap.dateKey).toBe("2026-02-01");
    expect(snap.monthKey).toBe("2026-02");
    expect(snap.isMonthlyClose).toBe(true);
    expect(snap.totalNetWorth).toEqual({ amountMinor: 485500, currency: "EUR" });
    expect(snap.grossAssets).toEqual({ amountMinor: 605500, currency: "EUR" });
    expect(snap.debts).toEqual({ amountMinor: 120000, currency: "EUR" });
    expect(snap.warnings).toEqual([]);
    expect(snap.holdings).toStrictEqual([
      {
        holdingId: "a_cash",
        kind: "asset",
        label: "Cuenta ING",
        liquidityTier: "cash",
        valueMinor: 500000,
      },
      {
        holdingId: "a_inv",
        kind: "asset",
        label: "Fondo Indexado",
        liquidityTier: "market",
        unitPrice: "105.5",
        units: "10",
        valueMinor: 105500,
      },
      {
        holdingId: "l_mort",
        kind: "liability",
        label: "Hipoteca",
        liquidityTier: null,
        valueMinor: 120000,
      },
    ]);

    // Trash: soft-deleted holdings in full shape with deletedAt.
    expect(doc.trash.assets.map((a) => a.id).sort()).toEqual(["a_inv2", "a_old"]);
    const trashedManual = doc.trash.assets.find((a) => a.id === "a_old")!;
    expect(trashedManual.deletedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(trashedManual.currentValue).toEqual({ amountMinor: 75000, currency: "EUR" });

    const trashedInvestment = doc.trash.assets.find((a) => a.id === "a_inv2")!;
    expect(trashedInvestment.deletedAt).toBe("2026-04-01T00:00:00.000Z");
    expect("currentValue" in trashedInvestment).toBe(false);
    expect(trashedInvestment.investment).toEqual({ unitSymbol: "BTC" });

    expect(doc.trash.liabilities).toHaveLength(1);
    expect(doc.trash.liabilities[0]!.id).toBe("l_old");
    expect(doc.trash.liabilities[0]!.deletedAt).toBe("2026-04-02T00:00:00.000Z");

    // Price cache rows verbatim, freshness fields preserved, optionals omitted.
    expect(doc.priceCache).toHaveLength(2);
    const freshPrice = doc.priceCache.find((p) => p.assetId === "a_inv")!;
    expect(freshPrice).toStrictEqual({
      assetId: "a_inv",
      currency: "EUR",
      fetchedAt: "2026-06-10T18:00:00.000Z",
      freshnessState: "fresh",
      price: "106.20",
      priceDate: "2026-06-10",
      source: "stooq",
    } satisfies AssetPrice);
    const stalePrice = doc.priceCache.find((p) => p.assetId === "a_inv2")!;
    expect(stalePrice.staleReason).toBe("price older than its source TTL");
    expect("priceDate" in stalePrice).toBe(false);

    // The audit log is deliberately NOT a section.
    expect(Object.keys(doc)).not.toContain("audit");
    expect(Object.keys(doc)).not.toContain("auditLog");

    store.close();
  });

  test("is read-only: no writes, stable across repeated exports", () => {
    const store = createInMemoryStore();
    seedFullWorkspace(store);

    const auditBefore = store.readAuditLog();
    const assetsBefore = store.readAssets();
    const liabilitiesBefore = store.readLiabilities();
    const snapshotsBefore = store.readSnapshots();
    const pricesBefore = store.readAllPriceCacheEntries();

    const first = store.exportWorkspace();
    const second = store.exportWorkspace();

    expect(second).toEqual(first);
    expect(store.readAuditLog()).toEqual(auditBefore);
    expect(store.readAssets()).toEqual(assetsBefore);
    expect(store.readLiabilities()).toEqual(liabilitiesBefore);
    expect(store.readSnapshots()).toEqual(snapshotsBefore);
    expect(store.readAllPriceCacheEntries()).toEqual(pricesBefore);

    store.close();
  });
});
