/**
 * Multi-scope snapshot capture loop — integration test (PRD #120, R16, issue #136).
 *
 * The production dashboard load path (apps/web/app/load-dashboard.ts:152-170)
 * walks every scope returned by `listScopeOptions` and, for each, runs
 * `captureSnapshotForScope` (internally `planSnapshotCapture` +
 * `captureValuedNetWorthSnapshot`) then persists the result with
 * `store.snapshots.saveSnapshot`. Until now that loop was only exercised by
 * running the web app. This suite drives the exact same loop against a real
 * file-backed store so the end-to-end capture path is regression-covered:
 *
 *  - household + 2 members, each scope getting its own ownership-weighted figures
 *  - the ADR 0008 reconciliation invariant holding for every scope's frozen rows
 *  - monthly closes derived correctly across successive days, and the same-day
 *    latest-wins upsert (ADR 0005) keeping at most one snapshot per scope per day
 *
 * Mirrors the prior-art real-store persistence suites
 * (snapshot-holdings.persistence, snapshot-policy.persistence, snapshots.persistence).
 */
import { afterEach, describe, expect, test } from "vitest";

import type { WorthlineStore } from "@worthline/db";
import type {
  CaptureSnapshotOutput,
  InvestmentCaptureDetail,
  ScopeOption,
} from "@worthline/domain";
import {
  assertSnapshotHoldingsReconcile,
  captureSnapshotForScope,
  deriveMonthlyCloses,
  listScopeOptions,
} from "@worthline/domain";
import { cleanupTempDirs, createFileBackedStore } from "./helpers";

afterEach(cleanupTempDirs);

/**
 * A household with two members. Ana owns 60% and Jose 40% of a cash account
 * (100_000.00 €); Jose solely owns a debt (40_000.00 €). The shares are chosen
 * so scope-weighting lands on clean minor-unit values (no rounding ambiguity):
 *   household → 100_000.00 assets, 40_000.00 debts
 *   member_ana → 60_000.00 assets, 0 debts
 *   member_jose → 40_000.00 assets, 40_000.00 debts
 */
async function seedHousehold(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [
      { id: "member_ana", name: "Ana" },
      { id: "member_jose", name: "Jose" },
    ],
    mode: "household",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 100_000_00,
    id: "asset_cash",
    liquidityTier: "cash",
    name: "Caja comun",
    ownership: [
      { memberId: "member_ana", shareBps: 6_000 },
      { memberId: "member_jose", shareBps: 4_000 },
    ],
    type: "cash",
  });
  await store.liabilities.createLiability({
    balanceMinor: 40_000_00,
    currency: "EUR",
    id: "liability_loan",
    name: "Prestamo de Jose",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "debt",
  });
}

/**
 * Run exactly the load-dashboard multi-scope capture loop against a real store:
 * read the shared inputs once, walk every scope, capture and persist.
 * Returns the captures keyed by scope id so assertions can inspect what was
 * written without re-deriving it.
 */
async function runCaptureLoop(
  store: WorthlineStore,
  now: string,
): Promise<Map<string, CaptureSnapshotOutput>> {
  const workspace = (await store.workspace.readWorkspace())!;
  const assets = await store.assets.readAssets();
  const liabilities = await store.liabilities.readLiabilities();
  const scopes = listScopeOptions(workspace);

  const investmentDetails = new Map<string, InvestmentCaptureDetail>(
    (await store.snapshots.readPositions()).map((position) => [
      position.assetId,
      {
        units: position.currentUnits,
        ...(position.currentPricePerUnit
          ? { unitPrice: position.currentPricePerUnit }
          : {}),
      },
    ]),
  );

  const captures = new Map<string, CaptureSnapshotOutput>();

  for (const scope of scopes) {
    const capture = captureSnapshotForScope({
      assets,
      capturedAt: now,
      existingSnapshots: await store.snapshots.readSnapshots(scope.id),
      investmentDetails,
      liabilities,
      scope,
      workspace,
    });

    if (capture) {
      await store.snapshots.saveSnapshot({
        holdings: capture.holdings,
        replace: capture.replace,
        snapshot: capture.snapshot,
      });
      captures.set(scope.id, capture);
    }
  }

  return captures;
}

describe("multi-scope snapshot capture loop (integration)", () => {
  test("captures one ownership-weighted snapshot per scope: household + 2 members", async () => {
    const store = await createFileBackedStore("worthline-capture-loop-");
    await seedHousehold(store);

    const scopes = listScopeOptions((await store.workspace.readWorkspace())!);
    // listScopeOptions yields household first, then the active members.
    expect(scopes.map((scope: ScopeOption) => scope.id)).toEqual([
      "household",
      "member_ana",
      "member_jose",
    ]);

    await runCaptureLoop(store, "2026-06-10T10:00:00.000Z");

    // Every scope accumulated exactly one snapshot for the day.
    const household = await store.snapshots.readSnapshots("household");
    const ana = await store.snapshots.readSnapshots("member_ana");
    const jose = await store.snapshots.readSnapshots("member_jose");
    expect(household).toHaveLength(1);
    expect(ana).toHaveLength(1);
    expect(jose).toHaveLength(1);

    // Household: full asset, full debt → net worth 60_000.00.
    expect(household[0]!.grossAssets.amountMinor).toBe(100_000_00);
    expect(household[0]!.debts.amountMinor).toBe(40_000_00);
    expect(household[0]!.totalNetWorth.amountMinor).toBe(60_000_00);

    // Ana: 60% of the cash, no debt → net worth 60_000.00.
    expect(ana[0]!.grossAssets.amountMinor).toBe(60_000_00);
    expect(ana[0]!.debts.amountMinor).toBe(0);
    expect(ana[0]!.totalNetWorth.amountMinor).toBe(60_000_00);

    // Jose: 40% of the cash, all of the debt → net worth 0.
    expect(jose[0]!.grossAssets.amountMinor).toBe(40_000_00);
    expect(jose[0]!.debts.amountMinor).toBe(40_000_00);
    expect(jose[0]!.totalNetWorth.amountMinor).toBe(0);

    store.close();
  });

  test("the ADR 0008 reconciliation invariant holds for every scope's frozen rows read from the DB", async () => {
    const store = await createFileBackedStore("worthline-capture-loop-");
    await seedHousehold(store);

    await runCaptureLoop(store, "2026-06-10T10:00:00.000Z");

    for (const scopeId of ["household", "member_ana", "member_jose"]) {
      const snapshot = (await store.snapshots.readSnapshots(scopeId))[0]!;
      const rows = await store.snapshots.readSnapshotHoldings({ scopeId });

      // Reconcile what was actually persisted against the persisted headline
      // figures — not the in-memory capture. A throw fails the test.
      expect(() =>
        assertSnapshotHoldingsReconcile(rows, {
          debtsMinor: snapshot.debts.amountMinor,
          grossAssetsMinor: snapshot.grossAssets.amountMinor,
        }),
      ).not.toThrow();
    }

    // Holdings with no stake in a scope are omitted (not behind its figures):
    // Ana has no share of Jose's solely-owned debt, so only her cash row exists.
    const anaRows = await store.snapshots.readSnapshotHoldings({ scopeId: "member_ana" });
    expect(anaRows.map((row) => row.holdingId)).toEqual(["asset_cash"]);
    expect(anaRows[0]!.valueMinor).toBe(60_000_00);

    // Jose carries both his cash share and the full debt row.
    const joseRows = await store.snapshots.readSnapshotHoldings({
      scopeId: "member_jose",
    });
    expect(new Set(joseRows.map((row) => row.holdingId))).toEqual(
      new Set(["asset_cash", "liability_loan"]),
    );
    expect(joseRows.find((row) => row.holdingId === "asset_cash")?.valueMinor).toBe(
      40_000_00,
    );
    expect(joseRows.find((row) => row.holdingId === "liability_loan")?.valueMinor).toBe(
      40_000_00,
    );

    store.close();
  });

  test("monthly closes are derived per scope as the last snapshot of each calendar month", async () => {
    const store = await createFileBackedStore("worthline-capture-loop-");
    await seedHousehold(store);

    // The production loop runs once per dashboard load. Replay it across
    // successive days, re-valuing the shared cash account each day so the
    // figures move and the close is unambiguous.
    const days: Array<{ now: string; cashMinor: number }> = [
      { cashMinor: 90_000_00, now: "2026-05-15T12:00:00.000Z" },
      { cashMinor: 95_000_00, now: "2026-05-31T12:00:00.000Z" },
      { cashMinor: 100_000_00, now: "2026-06-01T12:00:00.000Z" },
      { cashMinor: 110_000_00, now: "2026-06-11T12:00:00.000Z" },
    ];

    for (const day of days) {
      await store.assets.updateAssetValuation("asset_cash", day.cashMinor);
      await runCaptureLoop(store, day.now);
    }

    // Each scope independently accrues one snapshot per day across both months.
    for (const scopeId of ["household", "member_ana", "member_jose"]) {
      const snapshots = await store.snapshots.readSnapshots(scopeId);
      expect(snapshots).toHaveLength(4);

      const closes = deriveMonthlyCloses(snapshots);
      expect(closes.size).toBe(2);
      // The last snapshot of May (the 31st) and of June (the 11th) win.
      expect(closes.get("2026-05")).toBe(
        snapshots.find((snapshot) => snapshot.dateKey === "2026-05-31")!.id,
      );
      expect(closes.get("2026-06")).toBe(
        snapshots.find((snapshot) => snapshot.dateKey === "2026-06-11")!.id,
      );
    }

    store.close();
  });

  test("same-day re-runs upsert latest-wins: at most one snapshot and one set of rows per scope per day", async () => {
    const store = await createFileBackedStore("worthline-capture-loop-");
    await seedHousehold(store);

    // First dashboard load of the day.
    const morning = await runCaptureLoop(store, "2026-06-10T08:00:00.000Z");
    // None of the morning captures replaced anything — first of the day.
    for (const capture of morning.values()) {
      expect(capture.replace).toBe(false);
    }

    // Re-value mid-day and load again — the policy says recapture, replacing.
    await store.assets.updateAssetValuation("asset_cash", 120_000_00);
    const evening = await runCaptureLoop(store, "2026-06-10T18:00:00.000Z");
    // Every evening capture replaced the morning same-day snapshot.
    for (const capture of evening.values()) {
      expect(capture.replace).toBe(true);
    }

    for (const scopeId of ["household", "member_ana", "member_jose"]) {
      const snapshots = await store.snapshots.readSnapshots(scopeId);
      // Latest-wins: exactly one snapshot for the day per scope.
      expect(snapshots).toHaveLength(1);

      const rows = await store.snapshots.readSnapshotHoldings({ scopeId });
      // And exactly one set of frozen rows, all from the evening capture.
      const eveningId = evening.get(scopeId)!.snapshot.id;
      expect(rows.every((row) => row.snapshotId === eveningId)).toBe(true);
    }

    // The re-valued figures replaced the morning ones (household sees the full
    // 120_000.00 of assets now).
    expect(
      (await store.snapshots.readSnapshots("household"))[0]!.grossAssets.amountMinor,
    ).toBe(120_000_00);
    // Ana's 60% share moved to 72_000.00.
    expect(
      (await store.snapshots.readSnapshots("member_ana"))[0]!.grossAssets.amountMinor,
    ).toBe(72_000_00);

    store.close();
  });
});
