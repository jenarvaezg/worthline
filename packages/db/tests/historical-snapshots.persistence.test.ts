/**
 * Historical snapshots from investment operations (ADR 0012, PRD #107).
 *
 * Integration tests against a real in-memory store: recording a backdated
 * operation generates the snapshot for that date and ripples later ones;
 * deleting it ripples snapshots on or after its date; importing a workspace
 * gap-fills operation dates that have no snapshot in the file without ever
 * recalculating the snapshots the file carried.
 */
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "../src/index";
import type { WorthlineStore } from "../src/index";

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

function recordBuy(
  store: WorthlineStore,
  executedAt: string,
  units: string,
  pricePerUnit: string,
): void {
  store.operations.recordOperation({
    assetId: "fund",
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id: `op_${executedAt}_${units}`,
    kind: "buy",
    pricePerUnit,
    units,
  });
  store.rippleHistoricalSnapshotsForOperation({
    assetId: "fund",
    mode: "record",
    operationDateKey: executedAt,
    today: TODAY,
  });
}

function grossAt(store: WorthlineStore, dateKey: string): number | undefined {
  return store
    .snapshots.readSnapshots()
    .find((snap) => snap.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

describe("historical snapshots from operations", () => {
  test("recording a backdated operation generates a snapshot for that date", () => {
    const store = createInMemoryStore();
    seed(store);

    recordBuy(store, "2024-01-10", "10", "100");

    // 10 units × 100 EUR = 1000.00, 100% owned by the only scope.
    expect(grossAt(store, "2024-01-10")).toBe(1_000_00);
    store.close();
  });

  test("a later snapshot ripples and keeps its own captured price", () => {
    const store = createInMemoryStore();
    seed(store);

    // First, an operation at 2024-03-01 generates that snapshot at price 200.
    recordBuy(store, "2024-03-01", "5", "200");
    expect(grossAt(store, "2024-03-01")).toBe(5 * 200_00);

    // A backdated buy at 2024-01-10 generates its own snapshot AND ripples the
    // 2024-03-01 one (now 15 units) — valued at the price 2024-03-01 already
    // captured (200), not the older op price (100).
    recordBuy(store, "2024-01-10", "10", "100");

    expect(grossAt(store, "2024-01-10")).toBe(10 * 100_00);
    expect(grossAt(store, "2024-03-01")).toBe(15 * 200_00);
    store.close();
  });

  test("an operation dated today or in the future generates no historical snapshot", () => {
    const store = createInMemoryStore();
    seed(store);

    recordBuy(store, TODAY, "3", "100");
    recordBuy(store, "2099-01-01", "3", "100");

    expect(store.snapshots.readSnapshots()).toHaveLength(0);
    store.close();
  });

  test("deleting a backdated operation ripples snapshots on or after its date", () => {
    const store = createInMemoryStore();
    seed(store);
    // A cash asset keeps every snapshot non-empty after the fund is removed.
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });

    recordBuy(store, "2024-01-10", "10", "100");
    recordBuy(store, "2024-03-01", "5", "200");

    expect(grossAt(store, "2024-01-10")).toBe(10 * 100_00 + 1_000_00);
    expect(grossAt(store, "2024-03-01")).toBe(15 * 200_00 + 1_000_00);

    // Delete the 2024-01-10 buy.
    const ops = store.operations.readOperations("fund");
    const target = ops.find((op) => op.executedAt === "2024-01-10")!;
    const deleted = store.operations.deleteOperation(target.id);
    expect(deleted).not.toBeNull();
    store.rippleHistoricalSnapshotsForOperation({
      assetId: "fund",
      mode: "delete",
      operationDateKey: "2024-01-10",
      today: TODAY,
    });

    // 2024-01-10: fund no longer has an operation ≤ that date → cash only.
    expect(grossAt(store, "2024-01-10")).toBe(1_000_00);
    // 2024-03-01: now only the 5-unit buy remains (priced at captured 200) + cash.
    expect(grossAt(store, "2024-03-01")).toBe(5 * 200_00 + 1_000_00);
    store.close();
  });
});

describe("historical snapshots from imported operations (gap-fill)", () => {
  test("import gap-fills missing operation dates and leaves file snapshots intact", () => {
    const source = createInMemoryStore();
    seed(source);
    recordBuy(source, "2024-01-10", "10", "100");
    recordBuy(source, "2024-03-01", "5", "200");

    const doc = source.workspace.exportWorkspace();
    const marchSnapshot = doc.snapshots.find((s) => s.dateKey === "2024-03-01")!;
    // Simulate a file missing the 2024-01-10 snapshot (a gap) but carrying the
    // 2024-03-01 one — which import must restore intact, never recalculate.
    doc.snapshots = doc.snapshots.filter((s) => s.dateKey !== "2024-01-10");
    source.close();

    const target = createInMemoryStore();
    target.workspace.importWorkspace(doc);

    // Gap at 2024-01-10 is regenerated.
    expect(grossAt(target, "2024-01-10")).toBe(10 * 100_00);
    // 2024-03-01 survives exactly as imported (15 units × the captured 200).
    expect(grossAt(target, "2024-03-01")).toBe(marchSnapshot.grossAssets.amountMinor);
    expect(grossAt(target, "2024-03-01")).toBe(15 * 200_00);
    target.close();
  });
});

describe("ripple preserves frozen history (ADR 0012)", () => {
  test("a ripple never drops a holding that was later trashed", () => {
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

    // A snapshot at 2024-03-01 captures the fund AND cash.
    recordBuy(store, "2024-03-01", "5", "200");
    expect(grossAt(store, "2024-03-01")).toBe(5 * 200_00 + 1_000_00);

    // Trash the cash account — a present-state edit; frozen snapshots must not move.
    store.assets.softDeleteAsset("cash", "2026-06-10T00:00:00.000Z");

    // A backdated fund operation ripples 2024-03-01. The fund row updates; the
    // (now trashed) cash row must survive in that frozen snapshot.
    recordBuy(store, "2024-01-10", "10", "100");

    expect(grossAt(store, "2024-03-01")).toBe(15 * 200_00 + 1_000_00);
    store.close();
  });

  test("deleting the only basis of a snapshot removes it instead of leaving it stale", () => {
    const store = createInMemoryStore();
    seed(store); // fund only, no manual holdings

    recordBuy(store, "2024-01-10", "10", "100");
    expect(grossAt(store, "2024-01-10")).toBe(10 * 100_00);

    const op = store.operations.readOperations("fund").find((o) => o.executedAt === "2024-01-10")!;
    store.operations.deleteOperation(op.id);
    store.rippleHistoricalSnapshotsForOperation({
      assetId: "fund",
      mode: "delete",
      operationDateKey: "2024-01-10",
      today: TODAY,
    });

    // Nothing remains on that date → the snapshot is gone, not stale at 100000.
    expect(grossAt(store, "2024-01-10")).toBeUndefined();
    store.close();
  });

  test("generates scope-weighted snapshots for every affected scope (household)", () => {
    const store = createInMemoryStore();
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
      name: "Fondo compartido",
      ownership: [
        { memberId: "mJ", shareBps: 5_000 },
        { memberId: "mA", shareBps: 5_000 },
      ],
    });

    recordBuy(store, "2024-01-10", "10", "100"); // full value 1000.00, split 50/50

    const at = store.snapshots.readSnapshots().filter((s) => s.dateKey === "2024-01-10");
    const grosses = at.map((s) => s.grossAssets.amountMinor).sort((a, b) => b - a);

    // More than one scope captured (household + members).
    expect(at.length).toBeGreaterThan(1);
    // The household scope sees the full value; a 50% member scope sees half.
    expect(grosses[0]).toBe(10 * 100_00);
    expect(grosses).toContain((10 * 100_00) / 2);
    store.close();
  });
});
