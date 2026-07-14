/**
 * Single-date snapshot unit-price correction apply seam (#926).
 *
 * `correctInvestmentSnapshotUnitPrice` freezes one historical unit price on one
 * date across scopes — explicit, never a refresh side effect. ADR-0012/0008-
 * faithful: only the corrected asset's row moves; every other frozen row stays
 * verbatim and reconciliation still holds.
 */

import type { WorthlineStore } from "@db/index";
import { createInMemoryStore } from "@db/index";
import { multiplyToMinor } from "@worthline/domain";
import { describe, expect, test } from "vitest";

const TODAY = "2026-07-15";

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "gold",
    liquidityTier: "market",
    name: "Oro físico",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    priceProvider: "yahoo",
    providerSymbol: "GBSE.MI",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 1_000_00,
    id: "cash",
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "cash",
  });
}

async function rowsFor(store: WorthlineStore, holdingId: string) {
  return (await store.snapshots.readSnapshotHoldings({ holdingId, kind: "asset" })).sort(
    (a, b) => a.dateKey.localeCompare(b.dateKey),
  );
}

async function rowAt(store: WorthlineStore, holdingId: string, dateKey: string) {
  return (await rowsFor(store, holdingId)).find((r) => r.dateKey === dateKey);
}

describe("correctInvestmentSnapshotUnitPrice (#926)", () => {
  test("re-values one daily snapshot at units × price with a frozen unit price", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await store.command.recordInvestmentOperation(
      {
        assetId: "gold",
        currency: "EUR",
        executedAt: "2026-07-01",
        feesMinor: 0,
        id: "op_jul",
        kind: "buy",
        pricePerUnit: "10",
        units: "3",
      },
      { today: TODAY },
    );

    const before = await rowAt(store, "gold", "2026-07-01");
    expect(before?.valueMinor).toBe(multiplyToMinor("3", "10"));
    expect(before?.unitPrice).toBeUndefined();

    const result = await store.command.correctInvestmentSnapshotUnitPrice({
      assetId: "gold",
      dateKey: "2026-07-09",
      unitPriceDecimal: "12.5",
    });

    expect(result).toEqual({ created: 1, dateKey: "2026-07-09", updated: 0 });

    const corrected = await rowAt(store, "gold", "2026-07-09");
    expect(corrected?.valueMinor).toBe(multiplyToMinor("3", "12.5"));
    expect(corrected?.unitPrice).toBe("12.5");

    const untouched = await rowAt(store, "gold", "2026-07-01");
    expect(untouched?.valueMinor).toBe(before?.valueMinor);
    store.close();
  });

  test("updates an existing snapshot in place without touching other holdings", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await store.command.recordInvestmentOperation(
      {
        assetId: "gold",
        currency: "EUR",
        executedAt: "2026-07-09",
        feesMinor: 0,
        id: "op_jul",
        kind: "buy",
        pricePerUnit: "10",
        units: "3",
      },
      { today: TODAY },
    );

    const cashBefore = (await rowsFor(store, "cash")).map((r) => ({
      dateKey: r.dateKey,
      valueMinor: r.valueMinor,
    }));

    const result = await store.command.correctInvestmentSnapshotUnitPrice({
      assetId: "gold",
      dateKey: "2026-07-09",
      unitPriceDecimal: "12.5",
    });

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);

    const gold = await rowAt(store, "gold", "2026-07-09");
    expect(gold?.valueMinor).toBe(multiplyToMinor("3", "12.5"));

    const cashAfter = (await rowsFor(store, "cash")).map((r) => ({
      dateKey: r.dateKey,
      valueMinor: r.valueMinor,
    }));
    for (const before of cashBefore) {
      const after = cashAfter.find((r) => r.dateKey === before.dateKey);
      expect(after?.valueMinor).toBe(before.valueMinor);
    }
    store.close();
  });

  test("keeps the reconciliation invariant after a single-date correction", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await store.command.recordInvestmentOperation(
      {
        assetId: "gold",
        currency: "EUR",
        executedAt: "2026-07-09",
        feesMinor: 0,
        id: "op_jul",
        kind: "buy",
        pricePerUnit: "10",
        units: "3",
      },
      { today: TODAY },
    );

    await store.command.correctInvestmentSnapshotUnitPrice({
      assetId: "gold",
      dateKey: "2026-07-09",
      unitPriceDecimal: "12.5",
    });

    for (const snapshot of await store.snapshots.readSnapshots()) {
      const rows = (
        await store.snapshots.readSnapshotHoldings({ scopeId: snapshot.scopeId })
      ).filter((r) => r.dateKey === snapshot.dateKey && r.kind === "asset");
      const sum = rows.reduce((acc, r) => acc + r.valueMinor, 0);
      expect(sum).toBe(snapshot.grossAssets.amountMinor);
    }
    store.close();
  });

  test("dry run counts without writing", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await store.command.recordInvestmentOperation(
      {
        assetId: "gold",
        currency: "EUR",
        executedAt: "2026-07-09",
        feesMinor: 0,
        id: "op_jul",
        kind: "buy",
        pricePerUnit: "10",
        units: "3",
      },
      { today: TODAY },
    );

    const preview = await store.command.correctInvestmentSnapshotUnitPrice({
      assetId: "gold",
      dateKey: "2026-07-09",
      dryRun: true,
      unitPriceDecimal: "12.5",
    });
    expect(preview.updated).toBe(1);

    const beforeConfirm = await rowAt(store, "gold", "2026-07-09");
    expect(beforeConfirm?.valueMinor).toBe(multiplyToMinor("3", "10"));

    const confirm = await store.command.correctInvestmentSnapshotUnitPrice({
      assetId: "gold",
      dateKey: "2026-07-09",
      unitPriceDecimal: "12.5",
    });
    expect(confirm.updated).toBe(1);

    const afterConfirm = await rowAt(store, "gold", "2026-07-09");
    expect(afterConfirm?.valueMinor).toBe(multiplyToMinor("3", "12.5"));
    store.close();
  });
});
