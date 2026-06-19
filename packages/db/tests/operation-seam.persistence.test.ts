/**
 * Operation dated-fact seam (ADR 0020, #239).
 *
 * The store folds persist-and-ripple into ONE typed method per fact kind, in a
 * single transaction, deriving `today` and the from-date window behind the seam.
 * These tests exercise the OPERATION seam methods directly at the store (not
 * through Next.js actions): one call must both persist the operation AND ripple
 * the snapshots it affects. The public `rippleHistoricalSnapshotsFor*` methods no
 * longer exist on the store surface (ADR 0020): every persist+ripple pair rides a
 * seam method, which wraps the standalone ripple logic behind a single transaction.
 */
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "@db/index";
import type { WorthlineStore } from "@db/index";

const TODAY = "2026-06-12";

function seed(store: WorthlineStore): void {
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

function grossAt(store: WorthlineStore, dateKey: string): number | undefined {
  return store.snapshots.readSnapshots().find((snap) => snap.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

describe("recordOperationAndRipple (operation seam, ADR 0020)", () => {
  test("one call persists the operation AND generates the snapshot at its date", () => {
    const store = createInMemoryStore();
    seed(store);

    store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2024-01-10",
        feesMinor: 0,
        id: "op1",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    // The persist happened: the operation row exists.
    expect(store.operations.readOperations("fund")).toHaveLength(1);
    // The ripple happened: a snapshot was generated at the backdated date.
    // 10 units × 100 EUR = 1000.00, 100% owned by the only scope.
    expect(grossAt(store, "2024-01-10")).toBe(1_000_00);
    store.close();
  });

  test("a backdated operation ripples a later existing snapshot", () => {
    const store = createInMemoryStore();
    seed(store);

    store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2024-03-01",
        feesMinor: 0,
        id: "op_mar",
        kind: "buy",
        pricePerUnit: "200",
        units: "5",
      },
      { today: TODAY },
    );
    expect(grossAt(store, "2024-03-01")).toBe(5 * 200_00);

    // A backdated buy generates its own snapshot AND ripples 2024-03-01 (now 15
    // units, cost basis 10×100 + 5×200 = 2000.00, #183).
    store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2024-01-10",
        feesMinor: 0,
        id: "op_jan",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    expect(store.operations.readOperations("fund")).toHaveLength(2);
    expect(grossAt(store, "2024-01-10")).toBe(10 * 100_00);
    expect(grossAt(store, "2024-03-01")).toBe(10 * 100_00 + 5 * 200_00);
    store.close();
  });
});

describe("recordOperationsAndRipple (batched statement seam, ADR 0020)", () => {
  test("one call records many backdated operations AND ripples once", () => {
    const store = createInMemoryStore();
    seed(store);
    // A cash asset keeps every snapshot non-empty and confirms the ripple ran.
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });

    store.recordOperationsAndRipple({
      assetId: "fund",
      creates: [
        {
          assetId: "fund",
          currency: "EUR",
          executedAt: "2024-01-10",
          feesMinor: 0,
          id: "op_jan",
          kind: "buy",
          pricePerUnit: "100",
          units: "10",
        },
        {
          assetId: "fund",
          currency: "EUR",
          executedAt: "2024-03-01",
          feesMinor: 0,
          id: "op_mar",
          kind: "buy",
          pricePerUnit: "200",
          units: "5",
        },
      ],
      overwrites: [],
      today: TODAY,
    });

    // Both operations persisted in the single call.
    expect(store.operations.readOperations("fund")).toHaveLength(2);
    // Both backdated dates rippled: each snapshot folds the fund + cash.
    expect(grossAt(store, "2024-01-10")).toBe(10 * 100_00 + 1_000_00);
    expect(grossAt(store, "2024-03-01")).toBe(10 * 100_00 + 5 * 200_00 + 1_000_00);
    store.close();
  });

  test("overwriting an operation in the batch re-ripples its date", () => {
    const store = createInMemoryStore();
    seed(store);

    // Seed an operation through the seam, then overwrite it via the batch.
    store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2024-01-10",
        feesMinor: 0,
        id: "op1",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );
    expect(grossAt(store, "2024-01-10")).toBe(10 * 100_00);

    // The file wins: same operation, now 20 units at 100.
    store.recordOperationsAndRipple({
      assetId: "fund",
      creates: [],
      overwrites: [
        {
          currency: "EUR",
          feesMinor: 0,
          id: "op1",
          kind: "buy",
          pricePerUnit: "100",
          units: "20",
        },
      ],
      today: TODAY,
    });

    // Still one operation; its snapshot re-rippled to the overwritten value.
    expect(store.operations.readOperations("fund")).toHaveLength(1);
    expect(grossAt(store, "2024-01-10")).toBe(20 * 100_00);
    store.close();
  });
});

describe("deleteOperationAndRipple (operation seam, ADR 0020)", () => {
  test("one call removes the operation AND ripples snapshots from its date", () => {
    const store = createInMemoryStore();
    seed(store);
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });

    store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2024-01-10",
        feesMinor: 0,
        id: "op_jan",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );
    store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2024-03-01",
        feesMinor: 0,
        id: "op_mar",
        kind: "buy",
        pricePerUnit: "200",
        units: "5",
      },
      { today: TODAY },
    );
    expect(grossAt(store, "2024-01-10")).toBe(10 * 100_00 + 1_000_00);

    const deleted = store.deleteOperationAndRipple({
      operationId: "op_jan",
      today: TODAY,
    });

    // The persist (delete) happened.
    expect(deleted).not.toBeNull();
    expect(store.operations.readOperations("fund")).toHaveLength(1);
    // The ripple happened: 2024-01-10 was a backfilled snapshot justified ONLY by
    // op_jan, so deleting it prunes the now-orphaned snapshot (#305) rather than
    // leaving a cash-only fossil. 2024-03-01 (still justified by op_mar) survives.
    expect(grossAt(store, "2024-01-10")).toBeUndefined();
    expect(grossAt(store, "2024-03-01")).toBe(5 * 200_00 + 1_000_00);
    store.close();
  });

  test("returns null when the operation is unknown", () => {
    const store = createInMemoryStore();
    seed(store);

    const deleted = store.deleteOperationAndRipple({
      operationId: "missing",
      today: TODAY,
    });

    expect(deleted).toBeNull();
    store.close();
  });
});
