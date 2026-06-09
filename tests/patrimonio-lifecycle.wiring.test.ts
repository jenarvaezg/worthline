/**
 * Wiring suite: patrimonio holding lifecycle actions
 * (deleteAssetAction, deleteLiabilityAction, restoreAssetAction,
 *  restoreLiabilityAction, acknowledgeWarningAction,
 *  updateLiabilityBalanceAction, editAssetAction).
 *
 * FormData in → redirect-or-error out, real in-memory store.
 */

import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import {
  deleteAssetAction,
  deleteLiabilityAction,
  restoreAssetAction,
  restoreLiabilityAction,
  acknowledgeWarningAction,
  updateLiabilityBalanceAction,
  editAssetAction,
} from "../apps/web/app/patrimonio/actions";

// ------------------------------------------------------------------ helpers --

function catchRedirect(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => {
      throw new Error("Expected redirect but action returned normally");
    },
    (err: unknown) => {
      if (err instanceof Error && (err.message === "NEXT_REDIRECT" || "digest" in err)) {
        const digest = (err as { digest?: string }).digest ?? "";
        const parts = digest.split(";");
        return parts[2] ?? digest;
      }
      throw err;
    },
  );
}

function fd(fields: Record<string, string>): FormData {
  const form = new FormData();
  form.set("currentUrl", "/patrimonio");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

// ------------------------------------------------------------- test fixtures --

let store: WorthlineStore;

const ASSET_ID = "asset_cash_001";
const LIABILITY_ID = "debt_mortgage_001";
const MEMBER_ID = "member_yo";

afterEach(() => {
  store?.close();
});

function setupStore() {
  store = createInMemoryStore();
  store.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Yo" }],
    mode: "individual",
  });
  store.createManualAsset({
    id: ASSET_ID,
    name: "Cuenta corriente",
    type: "cash",
    currency: "EUR",
    currentValueMinor: 50_000,
    liquidityTier: "cash",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
  store.createLiability({
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
    setupStore();

    const url = await catchRedirect(() =>
      deleteAssetAction(fd({ id: ASSET_ID }), store),
    );

    expect(url).toContain("ok=deleted_recoverable");
    const trash = store.readTrash();
    expect(trash.assets.some((a) => a.id === ASSET_ID)).toBe(true);
  });

  test("missing id: error redirect, store unchanged", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      deleteAssetAction(fd({ id: "" }), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
    expect(store.readAssets()).toHaveLength(1);
  });

  test("unknown id (changes=0): error redirect", async () => {
    setupStore();

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
    setupStore();

    const url = await catchRedirect(() =>
      deleteLiabilityAction(fd({ id: LIABILITY_ID }), store),
    );

    expect(url).toContain("ok=deleted_recoverable");
    const trash = store.readTrash();
    expect(trash.liabilities.some((l) => l.id === LIABILITY_ID)).toBe(true);
  });

  test("missing id: error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      deleteLiabilityAction(fd({ id: "" }), store),
    );

    expect(url).toContain("error=");
    expect(store.readLiabilities()).toHaveLength(1);
  });

  test("unknown id: error redirect", async () => {
    setupStore();

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
    setupStore();
    store.softDeleteAsset(ASSET_ID, new Date().toISOString());

    const url = await catchRedirect(() =>
      restoreAssetAction(fd({ id: ASSET_ID }), store),
    );

    expect(url).toContain("ok=restored");
    expect(store.readAssets()).toHaveLength(1);
    expect(store.readTrash().assets).toHaveLength(0);
  });

  test("missing id: error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      restoreAssetAction(fd({ id: "" }), store),
    );

    expect(url).toContain("error=");
  });

  test("asset not in trash (changes=0): error redirect", async () => {
    setupStore();
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
    setupStore();
    store.softDeleteLiability(LIABILITY_ID, new Date().toISOString());

    const url = await catchRedirect(() =>
      restoreLiabilityAction(fd({ id: LIABILITY_ID }), store),
    );

    expect(url).toContain("ok=restored");
    expect(store.readLiabilities()).toHaveLength(1);
    expect(store.readTrash().liabilities).toHaveLength(0);
  });

  test("missing id: error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      restoreLiabilityAction(fd({ id: "" }), store),
    );

    expect(url).toContain("error=");
  });

  test("liability not in trash (changes=0): error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      restoreLiabilityAction(fd({ id: LIABILITY_ID }), store),
    );

    expect(url).toContain("error=");
  });
});

// ======================================================== acknowledgeWarningAction

describe("acknowledgeWarningAction wiring", () => {
  test("happy path: override persisted, redirect to warning_acknowledged", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      acknowledgeWarningAction(
        fd({ code: "zero_value_asset", entityId: ASSET_ID }),
        store,
      ),
    );

    expect(url).toContain("ok=warning_acknowledged");
    const overrides = store.readWarningOverrides();
    expect(overrides.some((o) => o.code === "zero_value_asset" && o.entityId === ASSET_ID)).toBe(true);
  });

  test("missing code: error redirect, nothing persisted", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      acknowledgeWarningAction(
        fd({ code: "", entityId: ASSET_ID }),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(store.readWarningOverrides()).toHaveLength(0);
  });

  test("missing entityId: error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      acknowledgeWarningAction(
        fd({ code: "zero_value_asset", entityId: "" }),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(store.readWarningOverrides()).toHaveLength(0);
  });
});

// =================================================== updateLiabilityBalanceAction

describe("updateLiabilityBalanceAction wiring", () => {
  test("happy path: balance updated, redirect to saved", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      updateLiabilityBalanceAction(
        fd({ id: LIABILITY_ID, balance: "200" }),
        store,
      ),
    );

    expect(url).toContain("ok=saved");
    const liabilities = store.readLiabilities();
    expect(liabilities[0]!.currentBalance.amountMinor).toBe(20_000);
  });

  test("missing id: error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      updateLiabilityBalanceAction(fd({ id: "", balance: "200" }), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
  });

  test("invalid balance: error redirect, store unchanged", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      updateLiabilityBalanceAction(
        fd({ id: LIABILITY_ID, balance: "not-a-number" }),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/saldo/i);
    // Balance unchanged
    expect(store.readLiabilities()[0]!.currentBalance.amountMinor).toBe(100_000);
  });
});

// ================================================================ editAssetAction

describe("editAssetAction wiring", () => {
  test("happy path (asset): name and tier updated", async () => {
    setupStore();

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
    const asset = store.readAssets().find((a) => a.id === ASSET_ID);
    expect(asset?.name).toBe("Cuenta Ahorro");
  });

  test("happy path (liability): name updated", async () => {
    setupStore();

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
    const liability = store.readLiabilities().find((l) => l.id === LIABILITY_ID);
    expect(liability?.name).toBe("Hipoteca Renovada");
  });

  test("missing id: error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      editAssetAction(fd({ id: "", name: "Whatever" }), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
  });

  test("blank name (asset): error redirect", async () => {
    setupStore();

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
    expect(store.readAssets().find((a) => a.id === ASSET_ID)?.name).toBe("Cuenta corriente");
  });

  test("blank name (liability): error redirect", async () => {
    setupStore();

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
