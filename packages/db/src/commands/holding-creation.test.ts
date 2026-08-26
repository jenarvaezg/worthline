/**
 * The alta gate (#1599): creating a holding is ONE unit of work.
 *
 * What this suite is for. An alta was two calls — the asset (or the liability)
 * first, its opening operation / its entry traspaso / its debt model second — and
 * nothing tied them: a second write that failed left the first one standing, so
 * the owner kept a 0 € fund with no operations, or a deuda with no model, plus an
 * error message. That promise ("both or neither") is a property of the
 * transaction, not of any pure function, so everything here drives the command
 * against a real (in-memory) book and then asks the book what happened —
 * including after a write that fails halfway.
 */

import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import type { CreateInvestmentOperationInput, OwnershipShare } from "@worthline/domain";
import { describe, expect, test } from "vitest";

const TODAY = "2026-08-26";
const OWNERSHIP: OwnershipShare[] = [{ memberId: "mJ", shareBps: 10_000 }];

async function seed(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

function investmentAsset(id = "fondo") {
  return {
    currency: "EUR",
    id,
    instrument: "fund" as const,
    liquidityTier: "market" as const,
    name: "Vanguard Global Stock",
    ownership: OWNERSHIP,
  };
}

function openingOperation(
  overrides: Partial<CreateInvestmentOperationInput> = {},
): CreateInvestmentOperationInput {
  return {
    assetId: "fondo",
    currency: "EUR",
    executedAt: TODAY,
    id: "op_apertura",
    kind: "buy",
    pricePerUnit: "10",
    source: "opening",
    units: "100",
    ...overrides,
  };
}

async function assetIds(store: WorthlineStore): Promise<string[]> {
  return (await store.assets.readAssets()).map((asset) => asset.id);
}

async function liabilityIds(store: WorthlineStore): Promise<string[]> {
  return (await store.liabilities.readLiabilities()).map((liability) => liability.id);
}

describe("createInvestmentHolding — the holding and its opening, or neither", () => {
  test("the alta lands valued: the asset and its opening BUY are both there", async () => {
    const store = await seed();

    const result = await store.command.createInvestmentHolding({
      asset: investmentAsset(),
      entry: { kind: "opening", operation: openingOperation() },
      today: TODAY,
    });

    expect(result.ok).toBe(true);
    expect(await assetIds(store)).toEqual(["fondo"]);
    expect((await store.operations.readOperations("fondo")).map((op) => op.kind)).toEqual(
      ["buy"],
    );
  });

  test("an opening that collides on its id leaves NO holding behind", async () => {
    const store = await seed();
    // A holding that already owns the operation id the alta is about to mint, so
    // the second INSERT fails once the asset row is already written — the exact
    // mid-flight failure the gate exists for.
    await store.assets.createInvestmentAsset(investmentAsset("otro"));
    await store.command.recordInvestmentOperation(
      openingOperation({ assetId: "otro", id: "op_apertura" }),
      { today: TODAY },
    );

    await expect(
      store.command.createInvestmentHolding({
        asset: investmentAsset(),
        entry: { kind: "opening", operation: openingOperation() },
        today: TODAY,
      }),
    ).rejects.toThrow();

    expect(await assetIds(store)).toEqual(["otro"]);
    expect(await store.operations.readOperations("fondo")).toEqual([]);
  });

  test("«viene traspasada de otra entidad» lands as ONE transfer_in on a new holding", async () => {
    const store = await seed();

    const result = await store.command.createInvestmentHolding({
      asset: { ...investmentAsset(), manualPricePerUnit: "10" },
      entry: {
        kind: "external_transfer_in",
        transfer: {
          amountMinor: 1_000_00,
          destinationPricePerUnit: "10",
          executedAt: TODAY,
          inheritedCostMinor: 800_00,
          inOperationId: "op_in",
          transferId: "trf_1",
        },
      },
      today: TODAY,
    });

    expect(result.ok).toBe(true);
    const operations = await store.operations.readOperations("fondo");
    expect(operations.map((op) => op.kind)).toEqual(["transfer_in"]);
    expect(operations[0]?.transferId).toBe("trf_1");
  });

  test("a traspaso the gate refuses leaves NO holding behind", async () => {
    const store = await seed();

    const result = await store.command.createInvestmentHolding({
      asset: investmentAsset(),
      entry: {
        kind: "external_transfer_in",
        transfer: {
          amountMinor: 1_000_00,
          // A VL of zero: the gate refuses with data, and it can only refuse once
          // the destination exists — inside the unit of work.
          destinationPricePerUnit: "0",
          executedAt: TODAY,
          inOperationId: "op_in",
          transferId: "trf_1",
        },
      },
      today: TODAY,
    });

    expect(result.ok).toBe(false);
    expect(await assetIds(store)).toEqual([]);
  });

  test("without an entry the alta creates the empty container it was asked for", async () => {
    const store = await seed();

    const result = await store.command.createInvestmentHolding({
      asset: investmentAsset(),
      today: TODAY,
    });

    expect(result.ok).toBe(true);
    expect(await assetIds(store)).toEqual(["fondo"]);
    expect(await store.operations.readOperations("fondo")).toEqual([]);
  });
});

describe("createDebtHolding — the deuda and its model, or neither", () => {
  const liability = {
    balanceMinor: 120_000_00,
    currency: "EUR" as const,
    id: "hipoteca",
    name: "Hipoteca Plasencia",
    ownership: OWNERSHIP,
    type: "mortgage" as const,
  };

  const currentState = (planId = "plan_1") => ({
    plan: {
      annualInterestRate: "0.025",
      disbursementDate: TODAY,
      firstPaymentDate: "2026-09-26",
      id: planId,
      initialCapitalMinor: 120_000_00,
      liabilityId: "hipoteca",
      termMonths: 240,
    },
    rebaseline: {
      annualInterestRate: "0.025",
      baselineDate: TODAY,
      endDate: "2046-08-26",
      id: "reb_1",
      liabilityId: "hipoteca",
      nextPaymentDate: "2026-09-26",
      outstandingBalanceMinor: 120_000_00,
      startsAtBaseline: true as const,
    },
  });

  test("the deuda lands with its model and its current-state plan", async () => {
    const store = await seed();

    await store.command.createDebtHolding({
      currentState: currentState(),
      debtModel: "amortizable",
      liability,
      today: TODAY,
    });

    expect(await liabilityIds(store)).toEqual(["hipoteca"]);
    expect(await store.liabilities.readDebtModel("hipoteca")).toBe("amortizable");
    expect((await store.liabilities.readAmortizationPlan("hipoteca"))?.id).toBe("plan_1");
    expect((await store.liabilities.readBalanceRebaselines("hipoteca")).length).toBe(1);
  });

  test("a plan that collides on its id leaves NO deuda behind", async () => {
    const store = await seed();
    // Another debt already owns the plan id, so the plan INSERT fails once the
    // liability row and its model are already written.
    await store.liabilities.createLiability({ ...liability, id: "otra" });
    await store.command.createAmortizationPlan(
      { ...currentState("plan_1").plan, liabilityId: "otra" },
      { today: TODAY },
    );

    await expect(
      store.command.createDebtHolding({
        currentState: currentState("plan_1"),
        debtModel: "amortizable",
        liability,
        today: TODAY,
      }),
    ).rejects.toThrow();

    expect(await liabilityIds(store)).toEqual(["otra"]);
  });

  test("without a current state the deuda still lands with its model", async () => {
    const store = await seed();

    await store.command.createDebtHolding({
      debtModel: "informal",
      liability: { ...liability, id: "prestamo", type: "debt" },
      today: TODAY,
    });

    expect(await liabilityIds(store)).toEqual(["prestamo"]);
    expect(await store.liabilities.readDebtModel("prestamo")).toBe("informal");
    expect(await store.liabilities.readAmortizationPlan("prestamo")).toBeNull();
  });
});
