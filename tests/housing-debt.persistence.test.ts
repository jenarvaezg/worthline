import { calculateNetWorth } from "@worthline/domain";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, createFileBackedStore } from "./helpers";

afterEach(cleanupTempDirs);

describe("housing and debt persistence", () => {
  test("persists real estate and mortgage as separate net worth components", async () => {
    const store = await createFileBackedStore("worthline-housing-");

    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 30_000_000,
      id: "asset_home",
      isPrimaryResidence: true,
      liquidityTier: "housing",
      name: "Vivienda",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "real_estate",
    });
    await store.liabilities.createLiability({
      associatedAssetId: "asset_home",
      balanceMinor: 18_000_000,
      currency: "EUR",
      id: "debt_mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "mortgage",
    });

    const summary = calculateNetWorth({
      assets: await store.assets.readAssets(),
      liabilities: await store.liabilities.readLiabilities(),
      scopeId: "household",
      workspace: (await store.workspace.readWorkspace())!,
    });

    expect(summary.grossAssets.amountMinor).toBe(30_000_000);
    expect(summary.debts.amountMinor).toBe(18_000_000);
    expect(summary.housingEquity.amountMinor).toBe(12_000_000);
    expect(summary.liquidNetWorth.amountMinor).toBe(0);
  });
});
