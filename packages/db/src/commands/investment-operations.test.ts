/**
 * Investment operation commands (#971): exercise the command interface directly
 * against an in-memory store — no server actions.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  executeDeleteInvestmentOperationCommand,
  executeMergeStatementOperationsCommand,
  executeRecordInvestmentOperationCommand,
  runCommand,
} from "./index";

const TODAY = "2026-06-12";

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
    ?.grossAssets.amountMinor;
}

async function positionUnits(
  store: WorthlineStore,
  assetId: string,
): Promise<string | undefined> {
  return (await store.snapshots.readPositions()).find((p) => p.assetId === assetId)
    ?.currentUnits;
}

async function seedFund(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    manualPricePerUnit: "100",
    name: "Fondo indexado",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
}

describe("investment operation commands (#971)", () => {
  test("record operation via command persists and ripples at the operation date", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const result = await runCommand(
      executeRecordInvestmentOperationCommand,
      {
        today: TODAY,
        operation: {
          assetId: "fund",
          currency: "EUR",
          executedAt: "2024-01-10",
          feesMinor: 0,
          id: "op1",
          kind: "buy",
          pricePerUnit: "100",
          units: "10",
        },
      },
      store,
    );

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await store.operations.readOperations("fund")).toHaveLength(1);
    expect(await grossAt(store, "2024-01-10")).toBe(1_000_00);
    expect(await positionUnits(store, "fund")).toBe("10");

    store.close();
  });

  test("record sell reduces derived units", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    await executeRecordInvestmentOperationCommand(store, {
      today: TODAY,
      operation: {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2024-01-10",
        feesMinor: 0,
        id: "op_buy",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
    });

    const result = await executeRecordInvestmentOperationCommand(store, {
      today: TODAY,
      operation: {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2024-02-10",
        feesMinor: 0,
        id: "op_sell",
        kind: "sell",
        pricePerUnit: "120",
        units: "4",
      },
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await store.operations.readOperations("fund")).toHaveLength(2);
    expect(await positionUnits(store, "fund")).toBe("6");

    store.close();
  });

  test("delete operation via command removes the row and ripples units", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    await executeRecordInvestmentOperationCommand(store, {
      today: TODAY,
      operation: {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2024-01-10",
        feesMinor: 0,
        id: "op1",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
    });
    expect(await positionUnits(store, "fund")).toBe("10");

    const result = await executeDeleteInvestmentOperationCommand(store, {
      operationId: "op1",
      today: TODAY,
    });

    expect(result).toEqual({
      ok: true,
      value: { assetId: "fund", executedAt: "2024-01-10" },
    });
    expect(await store.operations.readOperations("fund")).toHaveLength(0);
    expect(await positionUnits(store, "fund")).toBe("0");

    store.close();
  });

  test("delete unknown operation returns null without rippling", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const result = await executeDeleteInvestmentOperationCommand(store, {
      operationId: "missing",
      today: TODAY,
    });

    expect(result).toEqual({ ok: true, value: null });

    store.close();
  });

  test("merge statement operations creates rows and runs one batched ripple", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    const dates = ["2024-02-01", "2024-03-01", "2024-04-01"] as const;
    const result = await executeMergeStatementOperationsCommand(store, {
      assetId: "fund",
      today: TODAY,
      creates: dates.map((executedAt, i) => ({
        assetId: "fund",
        currency: "EUR" as const,
        executedAt,
        feesMinor: 0,
        id: `op_${i}`,
        kind: "buy" as const,
        pricePerUnit: "100",
        source: "statement" as const,
        units: "10",
      })),
      overwrites: [],
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await store.operations.readOperations("fund")).toHaveLength(3);
    expect(
      (await store.snapshots.readSnapshots("household")).map((s) => s.dateKey).sort(),
    ).toEqual([...dates]);
  });

  test("merge overwrites an existing operation on the same date", async () => {
    const store = await createInMemoryStore();
    await seedFund(store);

    await store.operations.recordOperation({
      assetId: "fund",
      currency: "EUR",
      executedAt: "2024-03-01",
      id: "op_handtyped",
      kind: "buy",
      pricePerUnit: "1",
      units: "999",
    });

    const result = await executeMergeStatementOperationsCommand(store, {
      assetId: "fund",
      today: TODAY,
      creates: [
        {
          assetId: "fund",
          currency: "EUR",
          executedAt: "2024-02-01",
          feesMinor: 0,
          id: "op_new",
          kind: "buy",
          pricePerUnit: "100",
          source: "statement",
          units: "7.226",
        },
      ],
      overwrites: [
        {
          currency: "EUR",
          feesMinor: 0,
          id: "op_handtyped",
          kind: "buy",
          pricePerUnit: "100",
          source: "statement",
          units: "7.18",
        },
      ],
    });

    expect(result).toEqual({ ok: true, value: undefined });

    const ops = await store.operations.readOperations("fund");
    expect(ops).toHaveLength(2);
    const march = ops.find((op) => op.executedAt === "2024-03-01")!;
    expect(march.id).toBe("op_handtyped");
    expect(march.units).toBe("7.18");

    store.close();
  });
});
