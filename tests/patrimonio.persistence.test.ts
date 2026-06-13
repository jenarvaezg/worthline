import { afterEach, describe, expect, test } from "vitest";

import { createFileBackedStore, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

function setupStore() {
  const store = createFileBackedStore("worthline-patrimonio-");
  store.workspace.initializeWorkspace({
    members: [
      { id: "m_ana", name: "Ana" },
      { id: "m_jose", name: "Jose" },
    ],
    mode: "household",
  });
  return store;
}

describe("batchApplyValueUpdates — value-update-pass persistence", () => {
  test("applies changed values only, skipping unchanged rows", () => {
    const store = setupStore();
    store.assets.createManualAsset({
      id: "a_cash",
      name: "Caja",
      type: "cash",
      liquidityTier: "cash",
      currency: "EUR",
      currentValueMinor: 100_000,
      isPrimaryResidence: false,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });
    store.assets.createManualAsset({
      id: "a_manual",
      name: "Piso",
      type: "real_estate",
      liquidityTier: "housing",
      currency: "EUR",
      currentValueMinor: 200_000,
      isPrimaryResidence: true,
      ownership: [
        { memberId: "m_ana", shareBps: 5_000 },
        { memberId: "m_jose", shareBps: 5_000 },
      ],
    });

    // Apply batch: only a_cash changes, a_manual stays at 200_000
    store.operations.batchApplyValueUpdates([{ id: "a_cash", newValueMinor: 110_000 }]);

    const assets = store.assets.readAssets();
    const cash = assets.find((a) => a.id === "a_cash")!;
    const piso = assets.find((a) => a.id === "a_manual")!;

    expect(cash.currentValue.amountMinor).toBe(110_000);
    expect(piso.currentValue.amountMinor).toBe(200_000);
    store.close();
  });

  test("applies multiple updates in a single transaction", () => {
    const store = setupStore();
    store.assets.createManualAsset({
      id: "a1",
      name: "Activo 1",
      type: "cash",
      liquidityTier: "cash",
      currency: "EUR",
      currentValueMinor: 1_000,
      isPrimaryResidence: false,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });
    store.assets.createManualAsset({
      id: "a2",
      name: "Activo 2",
      type: "manual",
      liquidityTier: "illiquid",
      currency: "EUR",
      currentValueMinor: 2_000,
      isPrimaryResidence: false,
      ownership: [{ memberId: "m_jose", shareBps: 10_000 }],
    });

    store.operations.batchApplyValueUpdates([
      { id: "a1", newValueMinor: 1_500 },
      { id: "a2", newValueMinor: 2_500 },
    ]);

    const assets = store.assets.readAssets();
    expect(assets.find((a) => a.id === "a1")!.currentValue.amountMinor).toBe(1_500);
    expect(assets.find((a) => a.id === "a2")!.currentValue.amountMinor).toBe(2_500);
    store.close();
  });

  test("empty batch is a no-op", () => {
    const store = setupStore();
    store.assets.createManualAsset({
      id: "a_only",
      name: "Solo",
      type: "cash",
      liquidityTier: "cash",
      currency: "EUR",
      currentValueMinor: 5_000,
      isPrimaryResidence: false,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });

    store.operations.batchApplyValueUpdates([]);

    expect(
      store.assets.readAssets().find((a) => a.id === "a_only")!.currentValue.amountMinor,
    ).toBe(5_000);
    store.close();
  });
});

describe("updateLiability — full liability edit", () => {
  test("updates name, type, and associated asset", () => {
    const store = setupStore();
    store.assets.createManualAsset({
      id: "a_house",
      name: "Casa",
      type: "real_estate",
      liquidityTier: "housing",
      currency: "EUR",
      currentValueMinor: 300_000_00,
      isPrimaryResidence: true,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });
    store.liabilities.createLiability({
      id: "l_hip",
      name: "Hipoteca vieja",
      type: "mortgage",
      currency: "EUR",
      balanceMinor: 100_000_00,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });

    store.liabilities.updateLiability("l_hip", {
      name: "Hipoteca nueva",
      type: "debt",
      associatedAssetId: "a_house",
    });

    const liabilities = store.liabilities.readLiabilities();
    const updated = liabilities.find((l) => l.id === "l_hip")!;
    expect(updated.name).toBe("Hipoteca nueva");
    expect(updated.type).toBe("debt");
    expect(updated.associatedAssetId).toBe("a_house");
    store.close();
  });

  test("updates ownership split for a liability", () => {
    const store = setupStore();
    store.liabilities.createLiability({
      id: "l_own",
      name: "Deuda compartida",
      type: "debt",
      currency: "EUR",
      balanceMinor: 50_000,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });

    store.liabilities.updateLiability("l_own", {
      ownership: [
        { memberId: "m_ana", shareBps: 7_000 },
        { memberId: "m_jose", shareBps: 3_000 },
      ],
    });

    const liability = store.liabilities.readLiabilities().find((l) => l.id === "l_own")!;
    const anaShare = liability.ownership.find((s) => s.memberId === "m_ana")!;
    const joseShare = liability.ownership.find((s) => s.memberId === "m_jose")!;
    expect(anaShare.shareBps).toBe(7_000);
    expect(joseShare.shareBps).toBe(3_000);
    store.close();
  });
});

describe("updateAsset — full asset edit", () => {
  test("updates name, type, tier, and isPrimaryResidence", () => {
    const store = setupStore();
    store.assets.createManualAsset({
      id: "a_edit",
      name: "Old Name",
      type: "cash",
      liquidityTier: "cash",
      currency: "EUR",
      currentValueMinor: 50_000,
      isPrimaryResidence: false,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });

    store.assets.updateAsset("a_edit", {
      name: "New Name",
      type: "real_estate",
      liquidityTier: "housing",
      isPrimaryResidence: true,
    });

    const asset = store.assets.readAssets().find((a) => a.id === "a_edit")!;
    expect(asset.name).toBe("New Name");
    expect(asset.type).toBe("real_estate");
    expect(asset.liquidityTier).toBe("housing");
    expect(asset.isPrimaryResidence).toBe(true);
    // Value unchanged
    expect(asset.currentValue.amountMinor).toBe(50_000);
    store.close();
  });

  test("updates ownership split for an asset", () => {
    const store = setupStore();
    store.assets.createManualAsset({
      id: "a_own",
      name: "Shared",
      type: "manual",
      liquidityTier: "illiquid",
      currency: "EUR",
      currentValueMinor: 100_000,
      isPrimaryResidence: false,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });

    // Transfer half to Jose
    store.assets.updateAsset("a_own", {
      ownership: [
        { memberId: "m_ana", shareBps: 5_000 },
        { memberId: "m_jose", shareBps: 5_000 },
      ],
    });

    const asset = store.assets.readAssets().find((a) => a.id === "a_own")!;
    const anaShare = asset.ownership.find((s) => s.memberId === "m_ana")!;
    const joseShare = asset.ownership.find((s) => s.memberId === "m_jose")!;
    expect(anaShare.shareBps).toBe(5_000);
    expect(joseShare.shareBps).toBe(5_000);
    store.close();
  });
});

describe("batchApplyAllValueUpdates — atomic asset+liability pass", () => {
  test("applies asset and liability updates in a single transaction", () => {
    const store = setupStore();
    store.assets.createManualAsset({
      id: "a_cash",
      name: "Caja",
      type: "cash",
      liquidityTier: "cash",
      currency: "EUR",
      currentValueMinor: 10_000,
      isPrimaryResidence: false,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });
    store.liabilities.createLiability({
      id: "l_debt",
      name: "Deuda",
      type: "debt",
      currency: "EUR",
      balanceMinor: 5_000,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });

    store.operations.batchApplyAllValueUpdates(
      [{ id: "a_cash", newValueMinor: 20_000 }],
      [{ id: "l_debt", newValueMinor: 3_000 }],
    );

    const asset = store.assets.readAssets().find((a) => a.id === "a_cash")!;
    const liability = store.liabilities.readLiabilities().find((l) => l.id === "l_debt")!;
    expect(asset.currentValue.amountMinor).toBe(20_000);
    expect(liability.currentBalance.amountMinor).toBe(3_000);
    store.close();
  });

  test("writes NOTHING when any amount is not an integer (atomicity guard)", () => {
    const store = setupStore();
    store.assets.createManualAsset({
      id: "a_cash",
      name: "Caja",
      type: "cash",
      liquidityTier: "cash",
      currency: "EUR",
      currentValueMinor: 10_000,
      isPrimaryResidence: false,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });
    store.liabilities.createLiability({
      id: "l_debt",
      name: "Deuda",
      type: "debt",
      currency: "EUR",
      balanceMinor: 5_000,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });

    expect(() =>
      store.operations.batchApplyAllValueUpdates(
        [{ id: "a_cash", newValueMinor: 20_000 }],
        [{ id: "l_debt", newValueMinor: 3_000.5 }], // invalid — not integer
      ),
    ).toThrow("integer");

    // Validation fires BEFORE any write — the asset must be unchanged.
    const asset = store.assets.readAssets().find((a) => a.id === "a_cash")!;
    const liability = store.liabilities.readLiabilities().find((l) => l.id === "l_debt")!;
    expect(asset.currentValue.amountMinor).toBe(10_000);
    expect(liability.currentBalance.amountMinor).toBe(5_000);
    store.close();
  });

  test("empty batches are a no-op", () => {
    const store = setupStore();
    store.operations.batchApplyAllValueUpdates([], []);
    store.close();
  });
});

describe("softDeleteAsset / restoreAsset — returns affected row count", () => {
  test("returns 1 when the asset exists", () => {
    const store = setupStore();
    store.assets.createManualAsset({
      id: "a_del",
      name: "Para borrar",
      type: "cash",
      liquidityTier: "cash",
      currency: "EUR",
      currentValueMinor: 1_000,
      isPrimaryResidence: false,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });
    expect(store.assets.softDeleteAsset("a_del", new Date().toISOString())).toBe(1);
    expect(store.assets.restoreAsset("a_del")).toBe(1);
    store.close();
  });

  test("returns 0 when the id does not exist", () => {
    const store = setupStore();
    expect(store.assets.softDeleteAsset("ghost_id", new Date().toISOString())).toBe(0);
    expect(store.assets.restoreAsset("ghost_id")).toBe(0);
    store.close();
  });
});

describe("softDeleteLiability / restoreLiability — returns affected row count", () => {
  test("returns 1 when the liability exists", () => {
    const store = setupStore();
    store.liabilities.createLiability({
      id: "l_del",
      name: "Para borrar",
      type: "debt",
      currency: "EUR",
      balanceMinor: 1_000,
      ownership: [{ memberId: "m_ana", shareBps: 10_000 }],
    });
    expect(store.liabilities.softDeleteLiability("l_del", new Date().toISOString())).toBe(
      1,
    );
    expect(store.liabilities.restoreLiability("l_del")).toBe(1);
    store.close();
  });

  test("returns 0 when the id does not exist", () => {
    const store = setupStore();
    expect(
      store.liabilities.softDeleteLiability("ghost_id", new Date().toISOString()),
    ).toBe(0);
    expect(store.liabilities.restoreLiability("ghost_id")).toBe(0);
    store.close();
  });
});
