import { afterEach, describe, expect, test } from "vitest";

import { calculateNetWorth } from "@worthline/domain";
import { createFileBackedStore, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

describe("manual asset persistence", () => {
  test("creates manual liquid assets with ownership and updates current valuation", () => {
    const store = createFileBackedStore("worthline-assets-");

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
    const store = createFileBackedStore("worthline-assets-");

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
