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

describe("housing and debt persistence", () => {
  test("persists real estate and mortgage as separate net worth components", () => {
    const store = createTestStore();

    store.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    store.createManualAsset({
      currency: "EUR",
      currentValueMinor: 30_000_000,
      id: "asset_home",
      isPrimaryResidence: true,
      liquidityTier: "housing",
      name: "Vivienda",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "real_estate",
    });
    store.createLiability({
      associatedAssetId: "asset_home",
      balanceMinor: 18_000_000,
      currency: "EUR",
      id: "debt_mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "mortgage",
    });

    const summary = calculateNetWorth({
      assets: store.readAssets(),
      liabilities: store.readLiabilities(),
      scopeId: "household",
      workspace: store.readWorkspace()!,
    });

    expect(summary.grossAssets.amountMinor).toBe(30_000_000);
    expect(summary.debts.amountMinor).toBe(18_000_000);
    expect(summary.housingEquity.amountMinor).toBe(12_000_000);
    expect(summary.liquidNetWorth.amountMinor).toBe(0);
  });
});

function createTestStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "worthline-housing-"));
  tempDirs.push(dataDir);

  return createWorthlineStore({
    databasePath: join(dataDir, "worthline.sqlite"),
  });
}
