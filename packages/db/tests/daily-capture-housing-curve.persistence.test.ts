/**
 * Daily capture values housing on its appreciation curve, not the stored value.
 *
 * The cron/self-heal capture (`captureDailySnapshotForWorkspace`) must freeze
 * real-estate holdings the same way ripples and live valuation do. The stored
 * `current_value_minor` is only updated on edits, so a capture after a month
 * boundary must sample the housing curve instead of replaying that stale value.
 */

import { captureDailySnapshotForWorkspace } from "@db/index";
import type { PersistenceTestStore as WorthlineStore } from "@db/testing";
import { createInMemoryStore } from "@db/testing";
import { describe, expect, test } from "vitest";

const TODAY = "2026-07-02";
const NOW = `${TODAY}T21:00:00.000Z`;

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 650_000_00,
    id: "home",
    isPrimaryResidence: true,
    liquidityTier: "illiquid",
    name: "Casa",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "real_estate",
  });
  await store.assets.addValuationAnchor({
    adjustsPriorCurve: true,
    assetId: "home",
    id: "anchor",
    valuationDate: "2026-06-21",
    valueMinor: 650_000_00,
  });
  await store.assets.setAnnualAppreciationRate("home", "0.1");
}

async function capturedAssetRow(
  store: WorthlineStore,
  holdingId: string,
): Promise<number | undefined> {
  const rows = await store.snapshots.readSnapshotHoldings({
    holdingId,
    kind: "asset",
  });
  return rows.find((row) => row.dateKey === TODAY)?.valueMinor;
}

describe("daily capture — housing curve valuation", () => {
  test("captures the curve-derived value, not the stored one", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const expected = await store.assets.valueHousingAtDate("home", TODAY, TODAY);
    expect(expected).not.toBe(650_000_00);

    await captureDailySnapshotForWorkspace(store, NOW);

    expect(await capturedAssetRow(store, "home")).toBe(expected);
    const snapshot = (await store.snapshots.readSnapshots()).find(
      (candidate) => candidate.dateKey === TODAY,
    );
    expect(snapshot?.housingEquity.amountMinor).toBe(expected);
    store.close();
  });
});
