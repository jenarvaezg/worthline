/**
 * Wiring suite: patrimonio holding lifecycle actions
 * (deleteAssetAction, deleteLiabilityAction, restoreAssetAction,
 *  restoreLiabilityAction, acknowledgeWarningAction,
 *  updateLiabilityBalanceAction, editAssetAction).
 *
 * FormData in → redirect-or-error out, real in-memory store.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  acknowledgeWarningAction,
  deleteAssetAction,
  deleteLiabilityAction,
  editAssetAction,
  restoreAssetAction,
  restoreLiabilityAction,
  updateAssetValuationAction,
  updateLiabilityBalanceAction,
} from "@web/patrimonio/actions";
import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { catchRedirect, fd } from "./helpers";

// ------------------------------------------------------------- test fixtures --

let store: WorthlineStore;

const ASSET_ID = "asset_cash_001";
const LIABILITY_ID = "debt_mortgage_001";
const MEMBER_ID = "member_yo";

afterEach(() => {
  store?.close();
});

async function setupStore() {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Yo" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    id: ASSET_ID,
    name: "Cuenta corriente",
    type: "cash",
    currency: "EUR",
    currentValueMinor: 50_000,
    liquidityTier: "cash",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
  await store.liabilities.createLiability({
    id: LIABILITY_ID,
    name: "Hipoteca",
    type: "mortgage",
    currency: "EUR",
    balanceMinor: 100_000,
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
  return store;
}

// ============================================================= deleteAssetAction

describe("deleteAssetAction wiring", () => {
  test("happy path: asset soft-deleted, redirect to deleted_recoverable", async () => {
    await setupStore();

    const url = await catchRedirect(() => deleteAssetAction(fd({ id: ASSET_ID }), store));

    expect(url).toContain("ok=deleted_recoverable");
    const trash = await store.readTrash();
    expect(trash.assets.some((a) => a.id === ASSET_ID)).toBe(true);
  });

  test("missing id: error redirect, store unchanged", async () => {
    await setupStore();

    const url = await catchRedirect(() => deleteAssetAction(fd({ id: "" }), store));

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
    expect(await store.assets.readAssets()).toHaveLength(1);
  });

  test("unknown id (changes=0): error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      deleteAssetAction(fd({ id: "asset_nonexistent" }), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/eliminado/i);
  });
});

// ========================================================== deleteLiabilityAction

describe("deleteLiabilityAction wiring", () => {
  test("happy path: liability soft-deleted, redirect to deleted_recoverable", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      deleteLiabilityAction(fd({ id: LIABILITY_ID }), store),
    );

    expect(url).toContain("ok=deleted_recoverable");
    const trash = await store.readTrash();
    expect(trash.liabilities.some((l) => l.id === LIABILITY_ID)).toBe(true);
  });

  test("missing id: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() => deleteLiabilityAction(fd({ id: "" }), store));

    expect(url).toContain("error=");
    expect(await store.liabilities.readLiabilities()).toHaveLength(1);
  });

  test("unknown id: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      deleteLiabilityAction(fd({ id: "debt_nonexistent" }), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/eliminado/i);
  });
});

// =========================================================== restoreAssetAction

describe("restoreAssetAction wiring", () => {
  test("happy path: soft-deleted asset is restored", async () => {
    await setupStore();
    await store.assets.softDeleteAsset(ASSET_ID, new Date().toISOString());

    const url = await catchRedirect(() =>
      restoreAssetAction(fd({ id: ASSET_ID }), store),
    );

    expect(url).toContain("ok=restored");
    expect(await store.assets.readAssets()).toHaveLength(1);
    expect((await store.readTrash()).assets).toHaveLength(0);
  });

  test("missing id: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() => restoreAssetAction(fd({ id: "" }), store));

    expect(url).toContain("error=");
  });

  test("asset not in trash (changes=0): error redirect", async () => {
    await setupStore();
    // Asset exists but is not in trash

    const url = await catchRedirect(() =>
      restoreAssetAction(fd({ id: ASSET_ID }), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/papelera/i);
  });
});

// ======================================================= restoreLiabilityAction

describe("restoreLiabilityAction wiring", () => {
  test("happy path: soft-deleted liability is restored", async () => {
    await setupStore();
    await store.liabilities.softDeleteLiability(LIABILITY_ID, new Date().toISOString());

    const url = await catchRedirect(() =>
      restoreLiabilityAction(fd({ id: LIABILITY_ID }), store),
    );

    expect(url).toContain("ok=restored");
    expect(await store.liabilities.readLiabilities()).toHaveLength(1);
    expect((await store.readTrash()).liabilities).toHaveLength(0);
  });

  test("missing id: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() => restoreLiabilityAction(fd({ id: "" }), store));

    expect(url).toContain("error=");
  });

  test("liability not in trash (changes=0): error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      restoreLiabilityAction(fd({ id: LIABILITY_ID }), store),
    );

    expect(url).toContain("error=");
  });
});

// ======================================================== acknowledgeWarningAction

describe("acknowledgeWarningAction wiring", () => {
  test("happy path: override persisted, redirect to warning_acknowledged", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      acknowledgeWarningAction(
        fd({ code: "zero_value_asset", entityId: ASSET_ID }),
        store,
      ),
    );

    expect(url).toContain("ok=warning_acknowledged");
    const overrides = await store.readWarningOverrides();
    expect(
      overrides.some((o) => o.code === "zero_value_asset" && o.entityId === ASSET_ID),
    ).toBe(true);
  });

  test("missing code: error redirect, nothing persisted", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      acknowledgeWarningAction(fd({ code: "", entityId: ASSET_ID }), store),
    );

    expect(url).toContain("error=");
    expect(await store.readWarningOverrides()).toHaveLength(0);
  });

  test("missing entityId: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      acknowledgeWarningAction(fd({ code: "zero_value_asset", entityId: "" }), store),
    );

    expect(url).toContain("error=");
    expect(await store.readWarningOverrides()).toHaveLength(0);
  });
});

// =================================================== updateLiabilityBalanceAction

describe("updateLiabilityBalanceAction wiring", () => {
  test("happy path: balance updated, redirect to saved", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      updateLiabilityBalanceAction(fd({ id: LIABILITY_ID, balance: "200" }), store),
    );

    expect(url).toContain("ok=saved");
    const liabilities = await store.liabilities.readLiabilities();
    expect(liabilities[0]!.currentBalance.amountMinor).toBe(20_000);
  });

  test("missing id: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      updateLiabilityBalanceAction(fd({ id: "", balance: "200" }), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
  });

  test("invalid balance: error redirect, store unchanged", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      updateLiabilityBalanceAction(
        fd({ id: LIABILITY_ID, balance: "not-a-number" }),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/saldo/i);
    // Balance unchanged
    expect(
      (await store.liabilities.readLiabilities())[0]!.currentBalance.amountMinor,
    ).toBe(100_000);
  });
});

// ========================================================= updateAssetValuationAction

describe("updateAssetValuationAction wiring", () => {
  test("updating a real-estate current value anchors today and recalculates prior housing snapshots", async () => {
    await setupStore();
    await store.assets.createManualAsset({
      id: "asset_home",
      name: "Piso",
      type: "real_estate",
      currency: "EUR",
      currentValueMinor: 200_000_00,
      liquidityTier: "housing",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    });
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "asset_home",
      id: "anchor_purchase",
      valuationDate: "2024-01-01",
      valueMinor: 100_000_00,
    });
    await store.assets.setAnnualAppreciationRate("asset_home", "0.1");
    await store.assets.createInvestmentAsset({
      id: "asset_fund",
      name: "Fondo",
      currency: "EUR",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    });
    await store.recordOperationAndRipple(
      {
        assetId: "asset_fund",
        currency: "EUR",
        executedAt: "2025-01-01",
        feesMinor: 0,
        id: "op_2025",
        kind: "buy",
        pricePerUnit: "1",
        units: "1",
      },
      { today: "2026-06-12" },
    );

    const housingValueAt2025Before = async () =>
      (
        await store.snapshots.readSnapshotHoldings({
          from: "2025-01-01",
          to: "2025-01-01",
        })
      ).find((row) => row.holdingId === "asset_home" && row.scopeId === "household")
        ?.valueMinor;

    expect(await housingValueAt2025Before()).toBeGreaterThan(109_000_00);

    const url = await catchRedirect(() =>
      updateAssetValuationAction(fd({ id: "asset_home", currentValue: "100000" }), store),
    );

    expect(url).toContain("ok=saved");
    expect(
      (await store.assets.readAssets()).find((asset) => asset.id === "asset_home")
        ?.currentValue.amountMinor,
    ).toBe(100_000_00);
    expect(await housingValueAt2025Before()).toBe(100_000_00);
  });
});

// ================================================================ editAssetAction

describe("editAssetAction wiring", () => {
  test("happy path (asset): name and tier updated", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      editAssetAction(
        fd({
          id: ASSET_ID,
          isLiability: "false",
          name: "Cuenta Ahorro",
          type: "cash",
          liquidityTier: "cash",
          isPrimaryResidence: "",
          ownershipPreset: "custom",
          [`owner_${MEMBER_ID}`]: "100",
        }),
        store,
      ),
    );

    expect(url).toContain("ok=saved");
    const asset = (await store.assets.readAssets()).find((a) => a.id === ASSET_ID);
    expect(asset?.name).toBe("Cuenta Ahorro");
  });

  test("editing real-estate ownership recalculates housing snapshots retroactively", async () => {
    await setupStore();
    await store.assets.createManualAsset({
      id: "asset_home",
      name: "Rio Tajo",
      type: "real_estate",
      currency: "EUR",
      currentValueMinor: 100_000_00,
      liquidityTier: "housing",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    });
    await store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "asset_home",
        id: "anchor_purchase",
        valuationDate: "2024-01-01",
        valueMinor: 100_000_00,
      },
      { today: "2026-06-12" },
    );

    expect(
      (await store.snapshots.readSnapshots("household")).find(
        (snapshot) => snapshot.dateKey === "2024-01-01",
      )?.grossAssets.amountMinor,
    ).toBe(100_000_00 + 50_000);

    const url = await catchRedirect(() =>
      editAssetAction(
        fd({
          id: "asset_home",
          isLiability: "false",
          name: "Rio Tajo",
          type: "real_estate",
          liquidityTier: "housing",
          ownershipPreset: "custom",
          [`owner_${MEMBER_ID}`]: "50",
        }),
        store,
      ),
    );

    expect(url).toContain("ok=saved");
    expect(
      (await store.assets.readAssets()).find((asset) => asset.id === "asset_home")
        ?.ownership,
    ).toEqual([{ memberId: MEMBER_ID, shareBps: 5_000 }]);
    expect(
      (await store.snapshots.readSnapshots("household")).find(
        (snapshot) => snapshot.dateKey === "2024-01-01",
      )?.grossAssets.amountMinor,
    ).toBe(50_000_00 + 50_000);
  });

  test("happy path (liability): name updated", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      editAssetAction(
        fd({
          id: LIABILITY_ID,
          isLiability: "true",
          name: "Hipoteca Renovada",
          type: "mortgage",
          ownershipPreset: "custom",
          [`owner_${MEMBER_ID}`]: "100",
        }),
        store,
      ),
    );

    expect(url).toContain("ok=saved");
    const liability = (await store.liabilities.readLiabilities()).find(
      (l) => l.id === LIABILITY_ID,
    );
    expect(liability?.name).toBe("Hipoteca Renovada");
  });

  test("missing id: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      editAssetAction(fd({ id: "", name: "Whatever" }), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
  });

  test("blank name (asset): error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      editAssetAction(
        fd({
          id: ASSET_ID,
          isLiability: "false",
          name: "",
          type: "cash",
          liquidityTier: "cash",
        }),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/nombre/i);
    // Name unchanged
    expect((await store.assets.readAssets()).find((a) => a.id === ASSET_ID)?.name).toBe(
      "Cuenta corriente",
    );
  });

  test("blank name (liability): error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      editAssetAction(
        fd({
          id: LIABILITY_ID,
          isLiability: "true",
          name: "",
          type: "mortgage",
        }),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/nombre/i);
  });
});
