/**
 * Wiring suite: hard delete + reset server actions (issues #80–#84).
 *
 * FormData in → redirect-or-error out, against an isolated in-memory store.
 * next/cache is stubbed; the NEXT_REDIRECT digest is parsed to the target URL.
 */
import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import {
  emptyTrashAction,
  hardDeleteAssetAction,
  hardDeleteLiabilityAction,
} from "../apps/web/app/patrimonio/actions";
import {
  deleteOperationAction,
  hardDeleteInvestmentAction,
} from "../apps/web/app/inversiones/actions";
import {
  hardDeleteMemberAction,
  resetWorkspaceAction,
} from "../apps/web/app/ajustes/actions";
import { catchRedirect, fd } from "./helpers";

let store: WorthlineStore;

afterEach(() => {
  store?.close();
});

function setupStore(): WorthlineStore {
  store = createInMemoryStore();
  store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Yo" }],
    mode: "individual",
  });
  return store;
}

function seedTrashedAsset(id = "a1", name = "Cuenta"): void {
  store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 1000,
    id,
    isPrimaryResidence: false,
    liquidityTier: "cash",
    name,
    ownership: [{ memberId: "m", shareBps: 10_000 }],
    type: "cash",
  });
  store.assets.softDeleteAsset(id, new Date().toISOString());
}

// ============================================================ patrimonio: assets

describe("hardDeleteAssetAction wiring", () => {
  test("happy path: trashed asset destroyed, redirect to hard_deleted", async () => {
    setupStore();
    seedTrashedAsset();

    const url = await catchRedirect(() => hardDeleteAssetAction(fd({ id: "a1" }), store));

    expect(url).toContain("ok=hard_deleted");
    expect(store.readTrash().assets).toEqual([]);
  });

  test("missing id: error redirect", async () => {
    setupStore();
    const url = await catchRedirect(() => hardDeleteAssetAction(fd({ id: "" }), store));
    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
  });

  test("not in trash (changes=0): error redirect", async () => {
    setupStore();
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1000,
      id: "live",
      isPrimaryResidence: false,
      liquidityTier: "cash",
      name: "Vivo",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      type: "cash",
    });

    const url = await catchRedirect(() =>
      hardDeleteAssetAction(fd({ id: "live" }), store),
    );
    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/papelera/i);
    expect(store.assets.readAssets().some((a) => a.id === "live")).toBe(true);
  });
});

// ======================================================= patrimonio: liabilities

describe("hardDeleteLiabilityAction wiring", () => {
  test("happy path: trashed liability destroyed", async () => {
    setupStore();
    store.liabilities.createLiability({
      balanceMinor: 5000,
      currency: "EUR",
      id: "l1",
      name: "Deuda",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      type: "debt",
    });
    store.liabilities.softDeleteLiability("l1", new Date().toISOString());

    const url = await catchRedirect(() =>
      hardDeleteLiabilityAction(fd({ id: "l1" }), store),
    );
    expect(url).toContain("ok=hard_deleted");
    expect(store.readTrash().liabilities).toEqual([]);
  });
});

// ============================================================= patrimonio: trash

describe("emptyTrashAction wiring", () => {
  test("happy path: every trashed holding destroyed", async () => {
    setupStore();
    seedTrashedAsset("a1", "Uno");
    seedTrashedAsset("a2", "Dos");

    const url = await catchRedirect(() => emptyTrashAction(fd({}), store));
    expect(url).toContain("ok=trash_emptied");
    expect(store.readTrash()).toEqual({ assets: [], liabilities: [] });
  });
});

// ====================================================== inversiones: hard delete

describe("hardDeleteInvestmentAction wiring", () => {
  test("happy path: trashed investment destroyed", async () => {
    setupStore();
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "inv1",
      liquidityTier: "market",
      name: "ETF",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
    });
    store.assets.softDeleteAsset("inv1", new Date().toISOString());

    const url = await catchRedirect(() =>
      hardDeleteInvestmentAction(fd({ id: "inv1" }, "/inversiones"), store),
    );
    expect(url).toContain("ok=hard_deleted");
    expect(store.readTrash().assets).toEqual([]);
  });

  test("not in trash: error redirect", async () => {
    setupStore();
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "inv1",
      liquidityTier: "market",
      name: "ETF",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
    });

    const url = await catchRedirect(() =>
      hardDeleteInvestmentAction(fd({ id: "inv1" }, "/inversiones"), store),
    );
    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/papelera/i);
  });
});

// ====================================================== inversiones: operations

describe("deleteOperationAction wiring", () => {
  function seedInvestmentWithOp(): void {
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "inv1",
      liquidityTier: "market",
      name: "ETF",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
    });
    store.operations.recordOperation({
      assetId: "inv1",
      currency: "EUR",
      executedAt: "2026-01-10",
      feesMinor: 0,
      id: "op1",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });
  }

  test("happy path: operation deleted, redirect to operation_deleted", async () => {
    setupStore();
    seedInvestmentWithOp();

    const url = await catchRedirect(() =>
      deleteOperationAction(
        "inv1",
        fd({ operationId: "op1" }, "/inversiones/inv1/operacion"),
        store,
      ),
    );
    expect(url).toContain("ok=operation_deleted");
    expect(store.operations.readOperations("inv1")).toEqual([]);
  });

  test("missing operationId: error redirect", async () => {
    setupStore();
    seedInvestmentWithOp();

    const url = await catchRedirect(() =>
      deleteOperationAction("inv1", fd({}, "/inversiones/inv1/operacion"), store),
    );
    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
  });

  test("unknown operationId: error redirect", async () => {
    setupStore();
    seedInvestmentWithOp();

    const url = await catchRedirect(() =>
      deleteOperationAction(
        "inv1",
        fd({ operationId: "nope" }, "/inversiones/inv1/operacion"),
        store,
      ),
    );
    expect(url).toContain("error=");
  });
});

// ============================================================= ajustes: members

describe("hardDeleteMemberAction wiring", () => {
  function fdAjustes(fields: Record<string, string>): FormData {
    return fd(fields, "/ajustes");
  }

  test("happy path: a disabled member with no ownerships is destroyed", async () => {
    setupStore();
    store.workspace.createMember({ id: "tmp", name: "Temporal" });
    store.workspace.disableMember("tmp", new Date().toISOString());

    const url = await catchRedirect(() =>
      hardDeleteMemberAction(fdAjustes({ id: "tmp" }), store),
    );
    expect(url).toContain("ok=member_deleted");
    expect(store.workspace.readWorkspace()!.members.some((m) => m.id === "tmp")).toBe(false);
  });

  test("active member: blocked with a clear message", async () => {
    setupStore();
    store.workspace.createMember({ id: "tmp", name: "Temporal" });

    const url = await catchRedirect(() =>
      hardDeleteMemberAction(fdAjustes({ id: "tmp" }), store),
    );
    expect(url).toContain("error=");
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toMatch(/desactivado/i);
    expect(store.workspace.readWorkspace()!.members.some((m) => m.id === "tmp")).toBe(true);
  });

  test("disabled member with ownerships: blocked, message lists the holding", async () => {
    setupStore();
    store.workspace.createMember({ id: "tmp", name: "Temporal" });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1000,
      id: "a1",
      isPrimaryResidence: false,
      liquidityTier: "cash",
      name: "Piso compartido",
      ownership: [{ memberId: "tmp", shareBps: 10_000 }],
      type: "cash",
    });
    store.workspace.disableMember("tmp", new Date().toISOString());

    const url = await catchRedirect(() =>
      hardDeleteMemberAction(fdAjustes({ id: "tmp" }), store),
    );
    expect(url).toContain("error=");
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toMatch(/Piso compartido/);
    expect(store.workspace.readWorkspace()!.members.some((m) => m.id === "tmp")).toBe(true);
  });
});

// ============================================================== ajustes: reset

describe("resetWorkspaceAction wiring", () => {
  test("happy path: exact phrase empties the workspace and lands on /empezar", async () => {
    setupStore();
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1000,
      id: "a1",
      isPrimaryResidence: false,
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      type: "cash",
    });

    const url = await catchRedirect(() =>
      resetWorkspaceAction(fd({ confirmation: "borrar todo" }, "/ajustes"), store),
    );
    expect(url).toBe("/empezar");
    expect(store.workspace.readWorkspace()).toBeNull();
  });

  test("wrong phrase: error redirect, workspace untouched", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      resetWorkspaceAction(fd({ confirmation: "borra" }, "/ajustes"), store),
    );
    expect(url).toContain("error=");
    expect(store.workspace.readWorkspace()).not.toBeNull();
  });

  test("empty phrase: error redirect, workspace untouched", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      resetWorkspaceAction(fd({}, "/ajustes"), store),
    );
    expect(url).toContain("error=");
    expect(store.workspace.readWorkspace()).not.toBeNull();
  });
});
