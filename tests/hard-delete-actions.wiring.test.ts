/**
 * Wiring suite: hard delete + reset server actions (issues #80–#84).
 *
 * FormData in → redirect-or-error out, against an isolated in-memory store.
 * next/cache is stubbed; the NEXT_REDIRECT digest is parsed to the target URL.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { hardDeleteMemberAction, resetWorkspaceAction } from "@web/ajustes/actions";
import { deleteOperationAction } from "@web/inversiones/actions";
import {
  emptyTrashAction,
  hardDeleteAssetAction,
  hardDeleteLiabilityAction,
} from "@web/patrimonio/actions";
import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { catchRedirect, fd } from "./helpers";

let store: WorthlineStore;

afterEach(() => {
  store?.close();
});

async function setupStore(): Promise<WorthlineStore> {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Yo" }],
    mode: "individual",
  });
  return store;
}

async function seedTrashedAsset(id = "a1", name = "Cuenta"): Promise<void> {
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 1000,
    id,
    isPrimaryResidence: false,
    liquidityTier: "cash",
    name,
    ownership: [{ memberId: "m", shareBps: 10_000 }],
    type: "cash",
  });
  await store.assets.softDeleteAsset(id, new Date().toISOString());
}

// ============================================================ patrimonio: assets

describe("hardDeleteAssetAction wiring", () => {
  test("happy path: trashed asset destroyed, redirect to hard_deleted", async () => {
    await setupStore();
    await seedTrashedAsset();

    const url = await catchRedirect(() => hardDeleteAssetAction(fd({ id: "a1" }), store));

    expect(url).toContain("ok=hard_deleted");
    expect((await store.readTrash()).assets).toEqual([]);
  });

  test("missing id: error redirect", async () => {
    await setupStore();
    const url = await catchRedirect(() => hardDeleteAssetAction(fd({ id: "" }), store));
    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
  });

  test("not in trash (changes=0): error redirect", async () => {
    await setupStore();
    await store.assets.createManualAsset({
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
    expect((await store.assets.readAssets()).some((a) => a.id === "live")).toBe(true);
  });
});

// ======================================================= patrimonio: liabilities

describe("hardDeleteLiabilityAction wiring", () => {
  test("happy path: trashed liability destroyed", async () => {
    await setupStore();
    await store.liabilities.createLiability({
      balanceMinor: 5000,
      currency: "EUR",
      id: "l1",
      name: "Deuda",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      type: "debt",
    });
    await store.liabilities.softDeleteLiability("l1", new Date().toISOString());

    const url = await catchRedirect(() =>
      hardDeleteLiabilityAction(fd({ id: "l1" }), store),
    );
    expect(url).toContain("ok=hard_deleted");
    expect((await store.readTrash()).liabilities).toEqual([]);
  });
});

// ============================================================= patrimonio: trash

describe("emptyTrashAction wiring", () => {
  test("happy path: every trashed holding destroyed", async () => {
    await setupStore();
    await seedTrashedAsset("a1", "Uno");
    await seedTrashedAsset("a2", "Dos");

    const url = await catchRedirect(() => emptyTrashAction(fd({}), store));
    expect(url).toContain("ok=trash_emptied");
    expect(await store.readTrash()).toEqual({ assets: [], liabilities: [] });
  });
});

// ====================================================== inversiones: operations

describe("deleteOperationAction wiring", () => {
  async function seedInvestmentWithOp(): Promise<void> {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "inv1",
      liquidityTier: "market",
      name: "ETF",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
    });
    await store.operations.recordOperation({
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
    await setupStore();
    await seedInvestmentWithOp();

    const url = await catchRedirect(() =>
      deleteOperationAction(
        "inv1",
        fd({ operationId: "op1" }, "/inversiones/inv1/operacion"),
        store,
      ),
    );
    expect(url).toContain("ok=operation_deleted");
  });

  test("missing operationId: error redirect", async () => {
    await setupStore();
    await seedInvestmentWithOp();

    const url = await catchRedirect(() =>
      deleteOperationAction("inv1", fd({}, "/inversiones/inv1/operacion"), store),
    );
    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
  });

  test("unknown operationId: error redirect", async () => {
    await setupStore();
    await seedInvestmentWithOp();

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
    await setupStore();
    await store.workspace.createMember({ id: "tmp", name: "Temporal" });
    await store.workspace.disableMember("tmp", new Date().toISOString());

    const url = await catchRedirect(() =>
      hardDeleteMemberAction(fdAjustes({ id: "tmp" }), store),
    );
    expect(url).toContain("ok=member_deleted");
    expect(
      (await store.workspace.readWorkspace())!.members.some((m) => m.id === "tmp"),
    ).toBe(false);
  });

  test("active member: blocked with a clear message", async () => {
    await setupStore();
    await store.workspace.createMember({ id: "tmp", name: "Temporal" });

    const url = await catchRedirect(() =>
      hardDeleteMemberAction(fdAjustes({ id: "tmp" }), store),
    );
    expect(url).toContain("error=");
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toMatch(/desactivado/i);
    expect(
      (await store.workspace.readWorkspace())!.members.some((m) => m.id === "tmp"),
    ).toBe(true);
  });

  test("disabled member with ownerships: blocked, message lists the holding", async () => {
    await setupStore();
    await store.workspace.createMember({ id: "tmp", name: "Temporal" });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1000,
      id: "a1",
      isPrimaryResidence: false,
      liquidityTier: "cash",
      name: "Piso compartido",
      ownership: [{ memberId: "tmp", shareBps: 10_000 }],
      type: "cash",
    });
    await store.workspace.disableMember("tmp", new Date().toISOString());

    const url = await catchRedirect(() =>
      hardDeleteMemberAction(fdAjustes({ id: "tmp" }), store),
    );
    expect(url).toContain("error=");
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toMatch(/Piso compartido/);
    expect(
      (await store.workspace.readWorkspace())!.members.some((m) => m.id === "tmp"),
    ).toBe(true);
  });
});

// ============================================================== ajustes: reset

describe("resetWorkspaceAction wiring", () => {
  test("happy path: exact phrase empties the workspace and lands on /empezar", async () => {
    await setupStore();
    await store.assets.createManualAsset({
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
    expect(await store.workspace.readWorkspace()).toBeNull();
  });

  test("wrong phrase: error redirect, workspace untouched", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      resetWorkspaceAction(fd({ confirmation: "borra" }, "/ajustes"), store),
    );
    expect(url).toContain("error=");
    expect(await store.workspace.readWorkspace()).not.toBeNull();
  });

  test("empty phrase: error redirect, workspace untouched", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      resetWorkspaceAction(fd({}, "/ajustes"), store),
    );
    expect(url).toContain("error=");
    expect(await store.workspace.readWorkspace()).not.toBeNull();
  });
});
