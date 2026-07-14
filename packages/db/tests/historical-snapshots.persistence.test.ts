/**
 * Historical snapshots from investment operations (ADR 0012, PRD #107).
 *
 * Integration tests against a real in-memory store: recording a backdated
 * operation generates the snapshot for that date and ripples later ones;
 * deleting it ripples snapshots on or after its date; importing a workspace
 * gap-fills operation dates that have no snapshot in the file without ever
 * recalculating the snapshots the file carried.
 */

import type { WorthlineStore } from "@db/index";

import { createInMemoryStore } from "@db/index";
import { describe, expect, test } from "vitest";

const TODAY = "2026-06-12";

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    name: "Fondo indexado",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
}

async function recordBuy(
  store: WorthlineStore,
  executedAt: string,
  units: string,
  pricePerUnit: string,
): Promise<void> {
  // ADR 0020: the persist-and-ripple loop rides ONE store seam method.
  await store.command.recordInvestmentOperation(
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

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

describe("historical snapshots from operations", () => {
  test("recording a backdated operation generates a snapshot for that date", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await recordBuy(store, "2024-01-10", "10", "100");

    // 10 units × 100 EUR = 1000.00, 100% owned by the only scope.
    expect(await grossAt(store, "2024-01-10")).toBe(1_000_00);
    store.close();
  });

  test("a no-price investment keeps cost basis through a ripple, not last-op price (#183)", async () => {
    const store = await createInMemoryStore();
    await seed(store); // fund has no provider/manual price → valued at cost basis (ADR 0006)

    // An operation at 2024-03-01 generates that snapshot at cost basis (5 × 200).
    await recordBuy(store, "2024-03-01", "5", "200");
    expect(await grossAt(store, "2024-03-01")).toBe(5 * 200_00);

    // A backdated buy at 2024-01-10 generates its own snapshot AND ripples the
    // 2024-03-01 one (now 15 units). With no price known, the frozen value stays
    // at COST BASIS — 10×100 + 5×200 = 2000.00 — never units × last-op price 200
    // (3000.00), the #183 jump for a multi-buy weighted-avg ≠ last-op price.
    await recordBuy(store, "2024-01-10", "10", "100");

    expect(await grossAt(store, "2024-01-10")).toBe(10 * 100_00);
    expect(await grossAt(store, "2024-03-01")).toBe(10 * 100_00 + 5 * 200_00);
    store.close();
  });

  test("a priced investment keeps its captured price through a ripple (ADR 0012)", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    // A manual quote (200) makes the fund priced — valued at market, not cost basis.
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "200",
      name: "Fondo indexado",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });

    // 2024-03-01 generates at the known price 200 (5 × 200 = 1000.00).
    await recordBuy(store, "2024-03-01", "5", "200");
    expect(await grossAt(store, "2024-03-01")).toBe(5 * 200_00);

    // A backdated buy at 2024-01-10 generates its own snapshot (at that date's
    // last-op price 100) AND ripples 2024-03-01 (now 15 units) — which keeps the
    // price 2024-03-01 already captured (200), not the older op price 100: the
    // ADR-0012 carry-over for a row frozen WITH a unit price, unchanged by #183.
    await recordBuy(store, "2024-01-10", "10", "100");

    expect(await grossAt(store, "2024-01-10")).toBe(10 * 100_00);
    expect(await grossAt(store, "2024-03-01")).toBe(15 * 200_00);
    store.close();
  });

  test("an operation dated today or in the future generates no historical snapshot", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await recordBuy(store, TODAY, "3", "100");
    await recordBuy(store, "2099-01-01", "3", "100");

    expect(await store.snapshots.readSnapshots()).toHaveLength(0);
    store.close();
  });

  test("deleting a backdated operation prunes its now-orphaned snapshot and ripples later ones (#305)", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    // A cash asset keeps every snapshot non-empty after the fund is removed.
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });

    await recordBuy(store, "2024-01-10", "10", "100");
    await recordBuy(store, "2024-03-01", "5", "200");

    expect(await grossAt(store, "2024-01-10")).toBe(10 * 100_00 + 1_000_00);
    // No-price fund frozen at cost basis (10×100 + 5×200), not last-op price (#183).
    expect(await grossAt(store, "2024-03-01")).toBe(10 * 100_00 + 5 * 200_00 + 1_000_00);

    // Delete the 2024-01-10 buy through the seam (persist + ripple, ADR 0020).
    const ops = await store.operations.readOperations("fund");
    const target = ops.find((op) => op.executedAt === "2024-01-10")!;
    const deleted = await store.command.deleteInvestmentOperation({
      operationId: target.id,
      today: TODAY,
    });
    expect(deleted).not.toBeNull();

    // 2024-01-10 was a backfilled (histsnap_) snapshot whose ONLY basis was this
    // operation. With it gone, no operation justifies the date, so the snapshot is
    // pruned outright (#305) — not left as a cash-only fossil the per-day bridge
    // would misread as a fund dip.
    expect(await grossAt(store, "2024-01-10")).toBeUndefined();
    // 2024-03-01: still justified by op_mar — only the 5-unit buy remains
    // (priced at captured 200) + cash.
    expect(await grossAt(store, "2024-03-01")).toBe(5 * 200_00 + 1_000_00);
    store.close();
  });
});

describe("historical snapshots from imported operations (gap-fill)", () => {
  test("import gap-fills missing operation dates and leaves file snapshots intact", async () => {
    const source = await createInMemoryStore();
    await seed(source);
    await recordBuy(source, "2024-01-10", "10", "100");
    await recordBuy(source, "2024-03-01", "5", "200");

    const doc = await source.workspace.exportWorkspace();
    const marchSnapshot = doc.snapshots.find((s) => s.dateKey === "2024-03-01")!;
    // Simulate a file missing the 2024-01-10 snapshot (a gap) but carrying the
    // 2024-03-01 one — which import must restore intact, never recalculate.
    doc.snapshots = doc.snapshots.filter((s) => s.dateKey !== "2024-01-10");
    source.close();

    const target = await createInMemoryStore();
    await target.workspace.importWorkspace(doc);

    // Gap at 2024-01-10 is regenerated.
    expect(await grossAt(target, "2024-01-10")).toBe(10 * 100_00);
    // 2024-03-01 survives exactly as imported — a no-price fund frozen at COST
    // BASIS (10×100 + 5×200 = 2000.00, ADR 0006/#183), never recalculated on import.
    expect(await grossAt(target, "2024-03-01")).toBe(
      marchSnapshot.grossAssets.amountMinor,
    );
    expect(await grossAt(target, "2024-03-01")).toBe(10 * 100_00 + 5 * 200_00);
    target.close();
  });
});

describe("ripple preserves frozen history (ADR 0012)", () => {
  test("a ripple never drops a holding that was later trashed", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });

    // A snapshot at 2024-03-01 captures the fund AND cash.
    await recordBuy(store, "2024-03-01", "5", "200");
    expect(await grossAt(store, "2024-03-01")).toBe(5 * 200_00 + 1_000_00);

    // Trash the cash account — a present-state edit; frozen snapshots must not move.
    await store.assets.softDeleteAsset("cash", "2026-06-10T00:00:00.000Z");

    // A backdated fund operation ripples 2024-03-01. The fund row updates (the
    // no-price fund stays at cost basis 10×100 + 5×200 = 2000.00, not last-op
    // price, #183); the (now trashed) cash row must survive in that frozen snapshot.
    await recordBuy(store, "2024-01-10", "10", "100");

    expect(await grossAt(store, "2024-03-01")).toBe(10 * 100_00 + 5 * 200_00 + 1_000_00);
    store.close();
  });

  test("deleting the only basis of a snapshot removes it instead of leaving it stale", async () => {
    const store = await createInMemoryStore();
    await seed(store); // fund only, no manual holdings

    await recordBuy(store, "2024-01-10", "10", "100");
    expect(await grossAt(store, "2024-01-10")).toBe(10 * 100_00);

    const op = (await store.operations.readOperations("fund")).find(
      (o) => o.executedAt === "2024-01-10",
    )!;
    await store.command.deleteInvestmentOperation({
      operationId: op.id,
      today: TODAY,
    });

    // Nothing remains on that date → the snapshot is gone, not stale at 100000.
    expect(await grossAt(store, "2024-01-10")).toBeUndefined();
    store.close();
  });

  test("generates scope-weighted snapshots for every affected scope (household)", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      name: "Fondo compartido",
      ownership: [
        { memberId: "mJ", shareBps: 5_000 },
        { memberId: "mA", shareBps: 5_000 },
      ],
    });

    await recordBuy(store, "2024-01-10", "10", "100"); // full value 1000.00, split 50/50

    const at = (await store.snapshots.readSnapshots()).filter(
      (s) => s.dateKey === "2024-01-10",
    );
    const grosses = at.map((s) => s.grossAssets.amountMinor).sort((a, b) => b - a);

    // More than one scope captured (household + members).
    expect(at.length).toBeGreaterThan(1);
    // The household scope sees the full value; a 50% member scope sees half.
    expect(grosses[0]).toBe(10 * 100_00);
    expect(grosses).toContain((10 * 100_00) / 2);
    store.close();
  });
});
