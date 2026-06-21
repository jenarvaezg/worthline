/**
 * Snapshot holding rows persistence (ADR 0008, issue #72).
 *
 * Holding rows are saved atomically with their snapshot: a capture that fails
 * the reconciliation invariant persists nothing, and a same-day recapture
 * replaces the previous rows — at most one set of rows per scope per day.
 */
import { afterEach, describe, expect, test } from "vitest";

import type { WorthlineStore } from "@worthline/db";
import {
  assertSnapshotHoldingsReconcile,
  captureValuedNetWorthSnapshot,
} from "@worthline/domain";
import { createFileBackedStore, cleanupTempDirs } from "./helpers";

afterEach(cleanupTempDirs);

async function seedPortfolio(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 100_000_00,
    id: "asset_cash",
    liquidityTier: "cash",
    name: "Caja",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "cash",
  });
  await store.liabilities.createLiability({
    balanceMinor: 40_000_00,
    currency: "EUR",
    id: "liability_loan",
    name: "Prestamo",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "debt",
  });
}

async function captureFor(store: WorthlineStore, id: string, capturedAt: string) {
  return captureValuedNetWorthSnapshot({
    assets: await store.assets.readAssets(),
    capturedAt,
    id,
    liabilities: await store.liabilities.readLiabilities(),
    scopeId: "household",
    scopeLabel: "Hogar",
    workspace: (await store.workspace.readWorkspace())!,
  });
}

describe("snapshot holding rows persistence", () => {
  test("saves holding rows atomically with the snapshot and reads them back by scope", async () => {
    const store = await createFileBackedStore("worthline-snapshot-holdings-");
    await seedPortfolio(store);

    const { holdings, snapshot } = await captureFor(
      store,
      "snap_1",
      "2026-06-10T10:00:00.000Z",
    );
    await store.snapshots.saveSnapshot({ holdings, snapshot });

    const rows = await store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    expect(rows).toHaveLength(2);

    const assetRow = rows.find((row) => row.holdingId === "asset_cash");
    expect(assetRow).toMatchObject({
      dateKey: "2026-06-10",
      kind: "asset",
      label: "Caja",
      liquidityTier: "cash",
      scopeId: "household",
      snapshotId: "snap_1",
      valueMinor: 100_000_00,
    });

    const liabilityRow = rows.find((row) => row.holdingId === "liability_loan");
    expect(liabilityRow).toMatchObject({
      kind: "liability",
      label: "Prestamo",
      liquidityTier: null,
      valueMinor: 40_000_00,
    });

    store.close();
  });

  test("the reconciliation invariant rejects rows that contradict the snapshot's figures", async () => {
    // The guard now lives outside the store layer (PRD #120 candidate 3): the
    // capture functions assert reconciliation by construction, so a doctored
    // set of rows never makes it as far as a saveSnapshot call. This exercises
    // that boundary — the same invariant the store used to re-check inline.
    const store = await createFileBackedStore("worthline-snapshot-holdings-");
    await seedPortfolio(store);

    const { holdings, snapshot } = await captureFor(
      store,
      "snap_bad",
      "2026-06-10T10:00:00.000Z",
    );
    // Doctor a copy of the rows so the asset sum no longer matches the headline.
    const doctored = holdings.map((row) =>
      row.holdingId === "asset_cash" ? { ...row, valueMinor: row.valueMinor + 1 } : row,
    );

    expect(() =>
      assertSnapshotHoldingsReconcile(doctored, {
        debtsMinor: snapshot.debts.amountMinor,
        grossAssetsMinor: snapshot.grossAssets.amountMinor,
      }),
    ).toThrow(/gross assets/i);

    store.close();
  });

  test("same-day recapture replaces the previous rows — at most one set per scope per day", async () => {
    const store = await createFileBackedStore("worthline-snapshot-holdings-");
    await seedPortfolio(store);

    const first = await captureFor(store, "snap_morning", "2026-06-10T08:00:00.000Z");
    await store.snapshots.saveSnapshot({
      holdings: first.holdings,
      snapshot: first.snapshot,
    });

    await store.assets.updateAssetValuation("asset_cash", 120_000_00);
    const second = await captureFor(store, "snap_evening", "2026-06-10T18:00:00.000Z");
    await store.snapshots.saveSnapshot({
      holdings: second.holdings,
      replace: true,
      snapshot: second.snapshot,
    });

    const rows = await store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    // Still exactly one set of rows for the day (one asset + one liability).
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.snapshotId === "snap_evening")).toBe(true);
    expect(rows.find((row) => row.holdingId === "asset_cash")?.valueMinor).toBe(
      120_000_00,
    );

    store.close();
  });

  test("same-day upsert without explicit replace also replaces the rows", async () => {
    const store = await createFileBackedStore("worthline-snapshot-holdings-");
    await seedPortfolio(store);

    const first = await captureFor(store, "snap_a", "2026-06-10T08:00:00.000Z");
    await store.snapshots.saveSnapshot({
      holdings: first.holdings,
      snapshot: first.snapshot,
    });

    const second = await captureFor(store, "snap_b", "2026-06-10T09:00:00.000Z");
    await store.snapshots.saveSnapshot({
      holdings: second.holdings,
      snapshot: second.snapshot,
    });

    const rows = await store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.snapshotId === "snap_b")).toBe(true);

    store.close();
  });

  test("captures investment units and unit price as decimal strings", async () => {
    const store = await createFileBackedStore("worthline-snapshot-holdings-");
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_fund",
      name: "Fondo",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    });
    await store.operations.recordOperation({
      assetId: "asset_fund",
      currency: "EUR",
      executedAt: "2026-06-01T10:00:00.000Z",
      id: "op_1",
      kind: "buy",
      pricePerUnit: "100",
      units: "10.5",
    });
    await store.operations.upsertPrice({
      assetId: "asset_fund",
      currency: "EUR",
      fetchedAt: "2026-06-10T09:00:00.000Z",
      freshnessState: "fresh",
      price: "110.40",
      source: "stooq",
    });

    const positions = await store.snapshots.readPositions();
    const details = new Map(
      positions.map((position) => [
        position.assetId,
        {
          units: position.currentUnits,
          ...(position.currentPricePerUnit
            ? { unitPrice: position.currentPricePerUnit }
            : {}),
        },
      ]),
    );

    const { holdings, snapshot } = captureValuedNetWorthSnapshot({
      assets: await store.assets.readAssets(),
      capturedAt: "2026-06-10T10:00:00.000Z",
      id: "snap_inv",
      investmentDetails: details,
      liabilities: await store.liabilities.readLiabilities(),
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace: (await store.workspace.readWorkspace())!,
    });
    await store.snapshots.saveSnapshot({ holdings, snapshot });

    const rows = await store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    const fundRow = rows.find((row) => row.holdingId === "asset_fund");
    expect(fundRow?.units).toBe("10.5");
    expect(fundRow?.unitPrice).toBe("110.40");
    // 10.5 units × 110.40 = 1159.20 € — scope-weighted value in minor units.
    expect(fundRow?.valueMinor).toBe(115_920);

    store.close();
  });

  test("reads filter by scope and by time window", async () => {
    const store = await createFileBackedStore("worthline-snapshot-holdings-");
    await seedPortfolio(store);

    for (const [id, capturedAt] of [
      ["snap_d1", "2026-06-08T10:00:00.000Z"],
      ["snap_d2", "2026-06-09T10:00:00.000Z"],
      ["snap_d3", "2026-06-10T10:00:00.000Z"],
    ] as const) {
      const { holdings, snapshot } = await captureFor(store, id, capturedAt);
      await store.snapshots.saveSnapshot({ holdings, snapshot });
    }

    // By scope: all three days, two rows each.
    expect(
      await store.snapshots.readSnapshotHoldings({ scopeId: "household" }),
    ).toHaveLength(6);
    // Unknown scope: nothing.
    expect(
      await store.snapshots.readSnapshotHoldings({ scopeId: "member_jose" }),
    ).toHaveLength(0);

    // Time window (inclusive date keys).
    const windowed = await store.snapshots.readSnapshotHoldings({
      from: "2026-06-09",
      scopeId: "household",
      to: "2026-06-09",
    });
    expect(windowed).toHaveLength(2);
    expect(windowed.every((row) => row.dateKey === "2026-06-09")).toBe(true);

    const openEnded = await store.snapshots.readSnapshotHoldings({
      from: "2026-06-09",
      scopeId: "household",
    });
    expect(openEnded).toHaveLength(4);

    store.close();
  });

  test("frozen rows survive renaming, re-tiering, and deleting the holding", async () => {
    const store = await createFileBackedStore("worthline-snapshot-holdings-");
    await seedPortfolio(store);

    const { holdings, snapshot } = await captureFor(
      store,
      "snap_frozen",
      "2026-06-10T10:00:00.000Z",
    );
    await store.snapshots.saveSnapshot({ holdings, snapshot });

    await store.assets.updateAsset("asset_cash", {
      liquidityTier: "illiquid",
      name: "Renombrada",
    });
    await store.assets.softDeleteAsset("asset_cash", "2026-06-11T10:00:00.000Z");

    const rows = await store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    const assetRow = rows.find((row) => row.holdingId === "asset_cash");
    expect(assetRow?.label).toBe("Caja");
    expect(assetRow?.liquidityTier).toBe("cash");

    store.close();
  });

  test("freezes a connected holding's per-coin rows and reads them back attached (ADR 0035)", async () => {
    const store = await createFileBackedStore("worthline-snapshot-positions-");
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 5_000_00,
      id: "asset_coins",
      liquidityTier: "illiquid",
      name: "Colección Numista",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "manual",
    });

    const positionDetails = new Map([
      [
        "asset_coins",
        [
          {
            positionKey: "numista_1",
            label: "Sovereign",
            valueMinor: 3_000_00,
            metal: "gold",
            imageUrl: "https://numista.test/s.jpg",
          },
          {
            positionKey: "numista_2",
            label: "Maple",
            valueMinor: 2_000_00,
            metal: "silver",
            imageUrl: null,
          },
        ],
      ],
    ]);

    const { holdings, snapshot } = captureValuedNetWorthSnapshot({
      assets: await store.assets.readAssets(),
      capturedAt: "2026-06-11T10:00:00.000Z",
      id: "snap_coins",
      positionDetails,
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace: (await store.workspace.readWorkspace())!,
    });
    await store.snapshots.saveSnapshot({ holdings, snapshot });

    const rows = await store.snapshots.readSnapshotHoldings({ scopeId: "household" });
    const coins = rows.find((row) => row.holdingId === "asset_coins");
    // The frozen position rows round-trip — value + label + metal + image, no secrets.
    expect(coins?.positions).toEqual([
      {
        positionKey: "numista_1",
        label: "Sovereign",
        valueMinor: 3_000_00,
        metal: "gold",
        imageUrl: "https://numista.test/s.jpg",
      },
      {
        positionKey: "numista_2",
        label: "Maple",
        valueMinor: 2_000_00,
        metal: "silver",
        imageUrl: null,
      },
    ]);
    // ADR 0035 invariant survives the round-trip.
    const sum = coins!.positions!.reduce((acc, p) => acc + p.valueMinor, 0);
    expect(sum).toBe(coins!.valueMinor);

    // A manual holding (the cash account would be one) carries no position rows.
    store.close();
  });
});
