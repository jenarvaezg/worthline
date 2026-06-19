import { afterEach, describe, expect, test } from "vitest";

import { createWorthlineStore } from "@worthline/db";
import { cleanupTempDirs, tempDatabasePath } from "./helpers";

afterEach(cleanupTempDirs);

/** Public ids of `holding` entity type, keyed by holding id. */
function holdingPublicIds(
  store: ReturnType<typeof createWorthlineStore>,
): Map<string, string> {
  return new Map(
    store.agentView
      .readPublicIds()
      .filter((row) => row.entityType === "holding")
      .map((row) => [row.entityId, row.publicId] as const),
  );
}

describe("agent-view holding public IDs (#335)", () => {
  test("registers wl_hld_-prefixed public IDs when creating an asset and a liability", () => {
    const databasePath = tempDatabasePath("worthline-agent-view-holding-create-");
    const store = createWorthlineStore({ databasePath });
    store.workspace.initializeWorkspace({
      members: [{ id: "member_ana", name: "Ana" }],
      mode: "individual",
    });

    store.assets.createManualAsset({
      id: "asset_cash",
      name: "Cuenta",
      type: "cash",
      currency: "EUR",
      currentValueMinor: 500000,
      liquidityTier: "cash",
      ownership: [{ memberId: "member_ana", shareBps: 10000 }],
    });
    store.liabilities.createLiability({
      id: "liab_loan",
      name: "Préstamo",
      type: "debt",
      currency: "EUR",
      balanceMinor: 200000,
      ownership: [{ memberId: "member_ana", shareBps: 10000 }],
    });

    const byHolding = holdingPublicIds(store);

    expect(byHolding.get("asset_cash")).toMatch(/^wl_hld_[a-f0-9]{32}$/);
    expect(byHolding.get("liab_loan")).toMatch(/^wl_hld_[a-f0-9]{32}$/);
    store.close();
  });

  test("removes a holding's public ID on hard delete, keeps it through trash/restore", () => {
    const databasePath = tempDatabasePath("worthline-agent-view-holding-delete-");
    const store = createWorthlineStore({ databasePath });
    store.workspace.initializeWorkspace({
      members: [{ id: "member_ana", name: "Ana" }],
      mode: "individual",
    });

    store.assets.createManualAsset({
      id: "asset_kept",
      name: "Coche",
      type: "manual",
      currency: "EUR",
      currentValueMinor: 300000,
      liquidityTier: "illiquid",
      ownership: [{ memberId: "member_ana", shareBps: 10000 }],
    });
    store.assets.createManualAsset({
      id: "asset_gone",
      name: "Trasto",
      type: "manual",
      currency: "EUR",
      currentValueMinor: 100,
      liquidityTier: "illiquid",
      ownership: [{ memberId: "member_ana", shareBps: 10000 }],
    });

    // A soft delete (trash) must KEEP the public id so a restore stays stable.
    store.assets.softDeleteAsset("asset_kept", "2026-06-19T00:00:00.000Z");
    expect(holdingPublicIds(store).has("asset_kept")).toBe(true);

    // A hard delete must REMOVE the public id.
    store.assets.softDeleteAsset("asset_gone", "2026-06-19T00:00:00.000Z");
    expect(store.assets.hardDeleteAsset("asset_gone")).toBe(1);

    const after = holdingPublicIds(store);
    expect(after.has("asset_gone")).toBe(false);
    expect(after.has("asset_kept")).toBe(true);
    store.close();
  });

  test("keeps holding public IDs stable across workspace export and import", () => {
    const sourcePath = tempDatabasePath("worthline-agent-view-holding-source-");
    const targetPath = tempDatabasePath("worthline-agent-view-holding-target-");

    const source = createWorthlineStore({ databasePath: sourcePath });
    source.workspace.initializeWorkspace({
      members: [{ id: "member_ana", name: "Ana" }],
      mode: "individual",
    });
    source.assets.createManualAsset({
      id: "asset_cash",
      name: "Cuenta",
      type: "cash",
      currency: "EUR",
      currentValueMinor: 500000,
      liquidityTier: "cash",
      ownership: [{ memberId: "member_ana", shareBps: 10000 }],
    });
    source.liabilities.createLiability({
      id: "liab_loan",
      name: "Préstamo",
      type: "debt",
      currency: "EUR",
      balanceMinor: 200000,
      ownership: [{ memberId: "member_ana", shareBps: 10000 }],
    });
    const before = holdingPublicIds(source);
    const exported = source.workspace.exportWorkspace();
    source.close();

    // The export carries the holding public ids.
    expect(exported.publicIds.some((row) => row.entityType === "holding")).toBe(true);

    const target = createWorthlineStore({ databasePath: targetPath });
    target.workspace.importWorkspace(exported);
    const after = holdingPublicIds(target);

    expect(after).toEqual(before);
    target.close();
  });

  test("backfills missing holding public IDs when importing a pre-#335 export", () => {
    const sourcePath = tempDatabasePath("worthline-agent-view-holding-legacy-source-");
    const targetPath = tempDatabasePath("worthline-agent-view-holding-legacy-target-");

    const source = createWorthlineStore({ databasePath: sourcePath });
    source.workspace.initializeWorkspace({
      members: [{ id: "member_ana", name: "Ana" }],
      mode: "individual",
    });
    source.assets.createManualAsset({
      id: "asset_cash",
      name: "Cuenta",
      type: "cash",
      currency: "EUR",
      currentValueMinor: 500000,
      liquidityTier: "cash",
      ownership: [{ memberId: "member_ana", shareBps: 10000 }],
    });
    const exported = source.workspace.exportWorkspace();
    source.close();

    // A pre-#335 export carries no holding public ids; import must mint them so
    // the non-lazy read path never 500s on a freshly restored workspace.
    const legacy = {
      ...exported,
      publicIds: exported.publicIds.filter((row) => row.entityType !== "holding"),
    };

    const target = createWorthlineStore({ databasePath: targetPath });
    target.workspace.importWorkspace(legacy);

    expect(holdingPublicIds(target).get("asset_cash")).toMatch(/^wl_hld_[a-f0-9]{32}$/);
    target.close();
  });
});
