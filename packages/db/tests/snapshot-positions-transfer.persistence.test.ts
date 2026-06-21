/**
 * Snapshot per-position breakdown export/import round-trip (ADR 0035, PRD #459 S3).
 *
 * The frozen per-position child rows beneath a connected-source holding must
 * survive a full workspace export → import, so the second-level drilldown is
 * preserved on a restore. The export must read the child rows and attach them;
 * the import must re-insert them (it uses its own bulk path, not saveSnapshot).
 * Values + labels only — never secrets.
 */
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "@db/index";
import type { NetWorthSnapshot } from "@worthline/domain";
import type { WorthlineStore } from "@db/index";

/**
 * A workspace whose single snapshot freezes one connected-source holding with a
 * per-position breakdown: a token row (null metal/image) and a coin row (metal +
 * thumbnail), summing exactly to the holding (ADR 0035).
 */
async function seedWorkspaceWithPositionBreakdown(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 5_000_00,
    id: "a_coins",
    liquidityTier: "illiquid",
    name: "Colección Numista",
    ownership: [{ memberId: "m1", shareBps: 10_000 }],
    type: "manual",
  });

  const snapshot: NetWorthSnapshot = {
    capturedAt: "2026-06-11T10:00:00.000Z",
    dateKey: "2026-06-11",
    debts: { amountMinor: 0, currency: "EUR" },
    grossAssets: { amountMinor: 5_000_00, currency: "EUR" },
    housingEquity: { amountMinor: 0, currency: "EUR" },
    id: "snap1",
    isMonthlyClose: false,
    liquidNetWorth: { amountMinor: 0, currency: "EUR" },
    monthKey: "2026-06",
    scopeId: "household",
    scopeLabel: "Hogar",
    totalNetWorth: { amountMinor: 5_000_00, currency: "EUR" },
    warnings: [],
  };
  await store.snapshots.saveSnapshot({
    holdings: [
      {
        countsAsHousing: false,
        holdingId: "a_coins",
        kind: "asset",
        label: "Colección Numista",
        liquidityTier: "illiquid",
        securesHousing: false,
        valueMinor: 5_000_00,
        positions: [
          {
            positionKey: "BTC:spot",
            label: "BTC",
            valueMinor: 3_000_00,
            metal: null,
            imageUrl: null,
          },
          {
            positionKey: "numista_1",
            label: "Sovereign",
            valueMinor: 2_000_00,
            metal: "gold",
            imageUrl: "https://numista.test/s.jpg",
          },
        ],
      },
    ],
    snapshot,
  });
}

describe("snapshot per-position breakdown survives export → import (ADR 0035)", () => {
  test("the frozen per-position rows round-trip into a fresh store, second-level drilldown intact", async () => {
    const source = await createInMemoryStore();
    await seedWorkspaceWithPositionBreakdown(source);

    const doc = await source.workspace.exportWorkspace();

    const restored = await createInMemoryStore();
    await restored.workspace.importWorkspace(doc);

    const rows = await restored.snapshots.readSnapshotHoldings({ scopeId: "household" });
    const coins = rows.find((row) => row.holdingId === "a_coins");
    // The breakdown survives — values + labels + metal + image, no secrets.
    expect(coins?.positions).toEqual([
      {
        positionKey: "BTC:spot",
        label: "BTC",
        valueMinor: 3_000_00,
        metal: null,
        imageUrl: null,
      },
      {
        positionKey: "numista_1",
        label: "Sovereign",
        valueMinor: 2_000_00,
        metal: "gold",
        imageUrl: "https://numista.test/s.jpg",
      },
    ]);
    // ADR 0035 invariant survives the round-trip.
    const sum = coins!.positions!.reduce((acc, p) => acc + p.valueMinor, 0);
    expect(sum).toBe(coins!.valueMinor);

    source.close();
    restored.close();
  });

  test("the exported document carries the per-position rows under the holding", async () => {
    const source = await createInMemoryStore();
    await seedWorkspaceWithPositionBreakdown(source);

    const doc = await source.workspace.exportWorkspace();
    const holding = doc.snapshots[0]!.holdings.find((h) => h.holdingId === "a_coins");
    expect(holding?.positions).toHaveLength(2);
    expect(holding?.positions?.map((p) => p.positionKey)).toEqual([
      "BTC:spot",
      "numista_1",
    ]);

    source.close();
  });
});
