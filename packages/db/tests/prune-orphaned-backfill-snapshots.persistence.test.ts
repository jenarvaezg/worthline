/**
 * Prune orphaned backfill snapshots when their operation is deleted (#305).
 *
 * A backfilled historical snapshot (id prefix `histsnap_`, ADR 0012) exists on a
 * date ONLY because an investment operation made that date an event date. When
 * the last operation justifying the date is deleted, the snapshot becomes a
 * fossil: frozen with the holdings that existed at backfill time, no longer
 * justified by any operation. Such a fossil can show a `derived` investment as
 * "not held" on a day it was held → a phantom dip in the /historico per-day
 * bridge (deriveHoldingDeltas).
 *
 * These tests pin the cleanup:
 *  - deleting the last operation on a `histsnap_` date removes the snapshot AND
 *    its frozen rows, for EVERY scope, transactionally with the delete/ripple;
 *  - a real daily-capture snapshot (id prefix `snapshot_`) is NEVER pruned, even
 *    when its date carries no operation (it records a day the app was opened);
 *  - a date still justified by ANOTHER operation keeps its snapshot;
 *  - the /historico bridge shows no phantom dip on the pruned date.
 */
import { buildSnapshotId, deriveHoldingDeltas } from "@worthline/domain";
import type {
  CoinPosition,
  NetWorthSnapshot,
  SnapshotHoldingRow,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "../src/index";
import type { SourcePositionInput, WorthlineStore } from "../src/index";

const TODAY = "2026-06-12";

function seedIndividual(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    name: "Fondo indexado",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
}

function seedHousehold(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [
      { id: "mJ", name: "Jose" },
      { id: "mA", name: "Ana" },
    ],
    mode: "household",
  });
  store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    name: "Fondo indexado",
    ownership: [
      { memberId: "mJ", shareBps: 5_000 },
      { memberId: "mA", shareBps: 5_000 },
    ],
  });
}

function recordBuy(
  store: WorthlineStore,
  executedAt: string,
  units: string,
  pricePerUnit: string,
): void {
  store.recordOperationAndRipple(
    {
      assetId: "fund",
      currency: "EUR",
      executedAt,
      feesMinor: 0,
      id: `op_${executedAt}_${units}`,
      kind: "buy",
      pricePerUnit,
      units,
    },
    { today: TODAY },
  );
}

function snapshotIdsAt(store: WorthlineStore, dateKey: string): string[] {
  return store.snapshots
    .readSnapshots()
    .filter((snap) => snap.dateKey === dateKey)
    .map((snap) => snap.id)
    .sort();
}

describe("prune orphaned backfill snapshots (#305)", () => {
  test("deleting the last operation on a histsnap_ date removes the snapshot and its frozen rows for every scope", () => {
    const store = createInMemoryStore();
    seedHousehold(store);
    // A live cash asset keeps the date's snapshot reconciling with holdings that
    // remain after the fund leaves — so the snapshot is NOT empty, yet its date is
    // orphaned once the only operation justifying it is gone.
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [
        { memberId: "mJ", shareBps: 5_000 },
        { memberId: "mA", shareBps: 5_000 },
      ],
      type: "cash",
    });

    recordBuy(store, "2024-01-10", "10", "100");
    recordBuy(store, "2024-03-01", "5", "200");

    // The backfill generated a histsnap_ snapshot per scope at 2024-01-10.
    const before = snapshotIdsAt(store, "2024-01-10");
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((id) => id.startsWith("histsnap_"))).toBe(true);
    // And frozen rows exist for those snapshots, in every scope.
    expect(
      store.snapshots.readSnapshotHoldings({ from: "2024-01-10", to: "2024-01-10" })
        .length,
    ).toBeGreaterThan(0);

    const op = store.operations
      .readOperations("fund")
      .find((o) => o.executedAt === "2024-01-10")!;
    store.deleteOperationAndRipple({ operationId: op.id, today: TODAY });

    // The orphaned backfill snapshot is gone for EVERY scope...
    expect(snapshotIdsAt(store, "2024-01-10")).toEqual([]);
    // ...and so are its frozen holding rows (every scope).
    expect(
      store.snapshots.readSnapshotHoldings({ from: "2024-01-10", to: "2024-01-10" }),
    ).toEqual([]);

    // The still-justified date 2024-03-01 (op_mar) survives, fund + cash.
    expect(snapshotIdsAt(store, "2024-03-01").length).toBeGreaterThan(0);
    store.close();
  });

  test("a date still justified by another operation keeps its snapshot", () => {
    const store = createInMemoryStore();
    seedIndividual(store);

    // Two operations on the SAME date; deleting one leaves the date justified.
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund2",
      liquidityTier: "market",
      name: "Otro fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    recordBuy(store, "2024-01-10", "10", "100");
    store.recordOperationAndRipple(
      {
        assetId: "fund2",
        currency: "EUR",
        executedAt: "2024-01-10",
        feesMinor: 0,
        id: "op_fund2",
        kind: "buy",
        pricePerUnit: "50",
        units: "4",
      },
      { today: TODAY },
    );

    const op = store.operations
      .readOperations("fund")
      .find((o) => o.executedAt === "2024-01-10")!;
    store.deleteOperationAndRipple({ operationId: op.id, today: TODAY });

    // fund2 still has an operation on 2024-01-10 → the snapshot survives.
    expect(snapshotIdsAt(store, "2024-01-10").length).toBeGreaterThan(0);
    store.close();
  });

  test("a real daily-capture snapshot (snapshot_ prefix) is never pruned, even with no operation on its date", () => {
    const store = createInMemoryStore();
    seedIndividual(store);

    // A backdated operation generates a histsnap_ snapshot at 2024-01-10.
    recordBuy(store, "2024-01-10", "10", "100");

    // Mint a REAL daily-capture snapshot at a date that carries NO operation,
    // using the production id generator (`buildSnapshotId` → `snapshot_…`). It
    // records a day the app was opened (a single cash holding that reconciles).
    // Captured under the household scope (individual mode) AND dated AFTER the
    // backfill date, so the delete ripple loop actually reaches it — proving the
    // prune SPARES a `snapshot_` daily capture it iterates over.
    const dailyDate = "2024-02-15";
    const dailyId = buildSnapshotId("household", `${dailyDate}T20:00:00.000Z`, 7);
    expect(dailyId.startsWith("snapshot_")).toBe(true);
    const cashHolding: SnapshotHoldingRow = {
      countsAsHousing: false,
      holdingId: "cash",
      kind: "asset",
      label: "Cuenta",
      liquidityTier: "cash",
      securesHousing: false,
      valueMinor: 1_000_00,
    };
    const dailySnapshot: NetWorthSnapshot = {
      capturedAt: `${dailyDate}T20:00:00.000Z`,
      dateKey: dailyDate,
      debts: { amountMinor: 0, currency: "EUR" },
      grossAssets: { amountMinor: 1_000_00, currency: "EUR" },
      housingEquity: { amountMinor: 0, currency: "EUR" },
      id: dailyId,
      isMonthlyClose: false,
      liquidNetWorth: { amountMinor: 1_000_00, currency: "EUR" },
      monthKey: dailyDate.slice(0, 7),
      scopeId: "household",
      scopeLabel: "Hogar",
      totalNetWorth: { amountMinor: 1_000_00, currency: "EUR" },
      warnings: [],
    };
    store.snapshots.saveSnapshot({
      holdings: [cashHolding],
      replace: false,
      snapshot: dailySnapshot,
    });
    expect(snapshotIdsAt(store, dailyDate)).toEqual([dailyId]);

    // Delete the only operation on 2024-01-10 → that histsnap_ snapshot is pruned.
    const op = store.operations
      .readOperations("fund")
      .find((o) => o.executedAt === "2024-01-10")!;
    store.deleteOperationAndRipple({ operationId: op.id, today: TODAY });

    expect(snapshotIdsAt(store, "2024-01-10")).toEqual([]);
    // The daily-capture snapshot survives untouched, though its date has no op.
    expect(snapshotIdsAt(store, dailyDate)).toEqual([dailyId]);
    expect(
      store.snapshots.readSnapshotHoldings({ from: dailyDate, to: dailyDate }).length,
    ).toBeGreaterThan(0);
    store.close();
  });

  test("the /historico bridge shows no phantom dip after the orphan is pruned", () => {
    const store = createInMemoryStore();
    seedIndividual(store);
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });

    // 2024-01-10 (orphan candidate) and 2024-02-10, 2024-03-01 (kept, op_mar etc).
    recordBuy(store, "2024-01-10", "10", "100");
    recordBuy(store, "2024-03-01", "5", "200");

    // Delete the sole basis of 2024-01-10 → it must be pruned, not left as a
    // fossil that the per-day bridge would read as a fund "dip" to/from zero.
    const op = store.operations
      .readOperations("fund")
      .find((o) => o.executedAt === "2024-01-10")!;
    store.deleteOperationAndRipple({ operationId: op.id, today: TODAY });

    // Build the per-day bridge across the surviving snapshots' frozen rows.
    // Individual mode captures under the household scope.
    const scopeId = "household";
    const surviving = store.snapshots
      .readSnapshots(scopeId)
      .map((snap) => snap.dateKey)
      .sort();
    // The orphan date is absent — no frozen fund row to misread as a dip.
    expect(surviving).not.toContain("2024-01-10");

    // For every adjacent surviving pair, the fund must never appear as a "gone"
    // delta (a phantom dip): it either persists with units, or simply was never
    // recorded as held on a pruned day.
    const rowsByDate = new Map<string, SnapshotHoldingRow[]>();
    for (const dateKey of surviving) {
      rowsByDate.set(
        dateKey,
        store.snapshots
          .readSnapshotHoldings({ scopeId, from: dateKey, to: dateKey })
          .map((r) => ({
            countsAsHousing: r.countsAsHousing,
            holdingId: r.holdingId,
            kind: r.kind,
            label: r.label,
            liquidityTier: r.liquidityTier,
            securesHousing: r.securesHousing,
            valueMinor: r.valueMinor,
            ...(r.units !== undefined ? { units: r.units } : {}),
            ...(r.unitPrice !== undefined ? { unitPrice: r.unitPrice } : {}),
          })),
      );
    }
    for (let i = 1; i < surviving.length; i += 1) {
      const prev = rowsByDate.get(surviving[i - 1]!) ?? [];
      const cur = rowsByDate.get(surviving[i]!) ?? [];
      const deltas = deriveHoldingDeltas(prev, cur);
      const phantomDip = deltas.find(
        (d) => d.holdingId === "fund" && d.status === "gone",
      );
      expect(phantomDip).toBeUndefined();
    }
    store.close();
  });
});

/**
 * #305 regression (maintainer review on PR #326): the prune must check EVERY
 * dated fact that mints a `histsnap_` snapshot, not only investment operations.
 * Debts (balance anchors, amortization cuotas, rate revisions, early repayments),
 * housing valuation anchors, and connected-source coin acquisitions all make a
 * date an event date. Deleting an UNRELATED investment operation must never prune
 * a snapshot whose date one of these other facts still justifies — that would be
 * real history data loss.
 *
 * Each test seeds a backfilled snapshot on a date D justified by a NON-operation
 * fact, plus an unrelated investment operation on a different date; deletes the
 * operation; and asserts D survives (with its frozen rows).
 */
describe("prune spares snapshots justified by a non-operation dated fact (#305 / PR #326)", () => {
  const DATE_D = "2025-01-01";
  const OP_DATE = "2024-06-01";

  /** A household with a priced-at-cost fund, so deleting the fund op is a real
   *  unrelated deletion whose ripple loop reaches D. */
  function seedFundIndividual(store: WorthlineStore): void {
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      name: "Fondo indexado",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
  }

  function recordFundBuy(store: WorthlineStore, executedAt: string): void {
    store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt,
        feesMinor: 0,
        id: `op_${executedAt}`,
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );
  }

  function deleteFundOp(store: WorthlineStore, executedAt: string): void {
    const op = store.operations
      .readOperations("fund")
      .find((o) => o.executedAt === executedAt)!;
    store.deleteOperationAndRipple({ operationId: op.id, today: TODAY });
  }

  function survivesAt(store: WorthlineStore, dateKey: string): boolean {
    return snapshotIdsAt(store, dateKey).length > 0;
  }

  test("a balance-anchor date survives deleting an unrelated investment operation", () => {
    const store = createInMemoryStore();
    seedFundIndividual(store);
    store.liabilities.createLiability({
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "card",
      name: "Tarjeta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });
    store.liabilities.setDebtModel("card", "revolving");

    // D is justified ONLY by a balance anchor (no operation on D).
    store.addBalanceAnchorAndRipple(
      { anchorDate: DATE_D, balanceMinor: 3_000_00, id: "an1", liabilityId: "card" },
      { today: TODAY },
    );
    // An unrelated investment op on a different date.
    recordFundBuy(store, OP_DATE);
    const before = snapshotIdsAt(store, DATE_D);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((id) => id.startsWith("histsnap_"))).toBe(true);

    deleteFundOp(store, OP_DATE);

    expect(survivesAt(store, DATE_D)).toBe(true);
    expect(
      store.snapshots.readSnapshotHoldings({ from: DATE_D, to: DATE_D }).length,
    ).toBeGreaterThan(0);
    store.close();
  });

  test("a housing valuation-anchor date survives deleting an unrelated investment operation", () => {
    const store = createInMemoryStore();
    seedFundIndividual(store);
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 180_000_00,
      id: "piso",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "real_estate",
    });

    // D is justified ONLY by a housing valuation anchor.
    store.addValuationAnchorAndRipple(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "v1",
        valuationDate: DATE_D,
        valueMinor: 180_000_00,
      },
      { today: TODAY },
    );
    recordFundBuy(store, OP_DATE);
    expect(snapshotIdsAt(store, DATE_D).length).toBeGreaterThan(0);

    deleteFundOp(store, OP_DATE);

    expect(survivesAt(store, DATE_D)).toBe(true);
    store.close();
  });

  test("an amortization cuota date survives deleting an unrelated investment operation", () => {
    const store = createInMemoryStore();
    seedFundIndividual(store);
    store.liabilities.createLiability({
      balanceMinor: 150_000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    store.liabilities.setDebtModel("mortgage", "amortizable");
    // Disbursement 2024-01-01, first payment 2024-02-01. A computed cuota boundary
    // lands on 2025-01-01 (= firstPayment + 11 months) — that is DATE_D, a date
    // with NO operation, NO anchor; justified ONLY by the amortization curve.
    store.createAmortizationPlanAndRipple(
      {
        annualInterestRate: "0.03",
        disbursementDate: "2024-01-01",
        firstPaymentDate: "2024-02-01",
        id: "plan1",
        initialCapitalMinor: 150_000_00,
        liabilityId: "mortgage",
        termMonths: 240,
      },
      { today: TODAY },
    );
    recordFundBuy(store, OP_DATE);
    // The plan ripple generated a snapshot at every past cuota, including DATE_D.
    const before = snapshotIdsAt(store, DATE_D);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((id) => id.startsWith("histsnap_"))).toBe(true);

    deleteFundOp(store, OP_DATE);

    expect(survivesAt(store, DATE_D)).toBe(true);
    store.close();
  });

  test("a connected-source coin acquisition date survives deleting an unrelated investment operation", () => {
    const store = createInMemoryStore();
    seedFundIndividual(store);

    // Seed a snapshot at D first (the coin ripple only touches EXISTING snapshots),
    // via a backdated buy on D that we then leave in place by deleting a DIFFERENT op.
    // To make D justified ONLY by the coin, we mint D through a SECOND op then delete
    // it, but that would orphan D. Instead: record an op on OP_DATE only, and rely on
    // the coin acquisition on D having generated nothing... — so create the D snapshot
    // through the fund op on D, sync the coin onto it, then delete a SEPARATE op.
    recordFundBuy(store, DATE_D); // generates the snapshot at D (and its frozen rows)
    recordFundBuy(store, OP_DATE); // an unrelated, later op we will delete

    const source = store.connectedSources.connect({
      adapter: "numista",
      credentialsJson: JSON.stringify({ apiKey: "secret" }),
      label: "Colección Numista",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    const coinPosition: SourcePositionInput = {
      kind: "coin",
      catalogueId: "cat-c1",
      currency: "EUR",
      externalId: "c1",
      finenessMillis: null,
      grade: "unc",
      issueId: null,
      liquidityTier: "illiquid",
      metal: "silver",
      metalValueMinor: null,
      name: "Moneda c1",
      numismaticFetchedAt: null,
      numismaticValueMinor: 300_00,
      obverseThumbUrl: null,
      purchaseDate: DATE_D,
      purchasePriceMinor: null,
      quantity: 1,
      weightGrams: null,
      year: null,
    } satisfies Omit<CoinPosition, "id" | "sourceId">;
    store.syncConnectedSource({
      positions: [coinPosition],
      sourceId: source.sourceId,
      syncedAt: "2026-06-01T10:00:00.000Z",
    });

    // Now DELETE the fund op that ORIGINALLY justified D. D must SURVIVE because the
    // coin acquisition on D still justifies it.
    deleteFundOp(store, DATE_D);

    expect(survivesAt(store, DATE_D)).toBe(true);
    store.close();
  });
});
