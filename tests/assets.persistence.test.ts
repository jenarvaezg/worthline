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
});

function createTestStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "worthline-assets-"));
  tempDirs.push(dataDir);

  return createWorthlineStore({
    databasePath: join(dataDir, "worthline.sqlite"),
  });
}
