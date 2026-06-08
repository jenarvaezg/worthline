import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createWorthlineStore } from "@worthline/db";
import { calculateNetWorth } from "@worthline/domain";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("manual asset persistence", () => {
  test("creates manual liquid assets with ownership and updates current valuation", () => {
    const store = createTestStore();

    store.initializeWorkspace({
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });
    store.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [
        { memberId: "member_ana", shareBps: 2_500 },
        { memberId: "member_jose", shareBps: 7_500 },
      ],
      type: "cash",
    });

    expect(
      calculateNetWorth({
        assets: store.readAssets(),
        scopeId: "member_ana",
        workspace: store.readWorkspace()!,
      }).liquidNetWorth.amountMinor,
    ).toBe(25_000);

    store.updateAssetValuation("asset_cash", 120_000);

    expect(
      calculateNetWorth({
        assets: store.readAssets(),
        scopeId: "household",
        workspace: store.readWorkspace()!,
      }).liquidNetWorth.amountMinor,
    ).toBe(120_000);
  });

  test("keeps ownership attached to the right asset when several coexist", () => {
    const store = createTestStore();

    store.initializeWorkspace({
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });
    store.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000,
      id: "asset_ana",
      liquidityTier: "cash",
      name: "Caja Ana",
      ownership: [{ memberId: "member_ana", shareBps: 10_000 }],
      type: "cash",
    });
    store.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000,
      id: "asset_jose",
      liquidityTier: "cash",
      name: "Caja Jose",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });

    const assets = store.readAssets();
    const workspace = store.readWorkspace()!;

    // Each member's scope sees only the asset they own — proof the batched
    // ownership read maps shares to the correct asset.
    expect(
      calculateNetWorth({ assets, scopeId: "member_ana", workspace }).liquidNetWorth
        .amountMinor,
    ).toBe(100_000);
    expect(
      calculateNetWorth({ assets, scopeId: "member_jose", workspace }).liquidNetWorth
        .amountMinor,
    ).toBe(200_000);
  });
});

function createTestStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "worthline-assets-"));
  tempDirs.push(dataDir);

  return createWorthlineStore({
    databasePath: join(dataDir, "worthline.sqlite"),
  });
}
