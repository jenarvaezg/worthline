/**
 * Bulk "who takes their balance from the curve?" read (#1334).
 *
 * The per-debt reading of the rule already exists (`storedBalanceGovernsDebtFigure`,
 * consumed one debt at a time by the ficha and by `updateLiabilityBalanceAction`).
 * The «puesta al día» lists EVERY debt, so it needs the same answer for all of them
 * without 3-4 reads per row: these tests pin the answer per debt model and pin that
 * the read stays one pass over the curve tables however many debts there are.
 */
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { openLibsqlClient } from "./libsql-client";
import { createStoreFromSqlite, type PersistenceTestStore } from "./testing";

interface SeededStore {
  store: PersistenceTestStore;
  client: Client;
}

async function seedStore(): Promise<SeededStore> {
  const client = openLibsqlClient(":memory:");
  const store = await createStoreFromSqlite(client);
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Jose" }],
    mode: "individual",
  });
  return { client, store };
}

async function seedLiability(store: PersistenceTestStore, id: string): Promise<void> {
  await store.liabilities.createLiability({
    balanceMinor: 100_000_00,
    currency: "EUR",
    id,
    name: id,
    ownership: [{ memberId: "m1", shareBps: 10_000 }],
    type: "debt",
  });
}

/** Count the SQL round-trips one call makes, whatever the reader does inside. */
async function countQueries(
  client: Client,
  run: () => Promise<unknown>,
): Promise<number> {
  const execute = client.execute.bind(client);
  let queries = 0;
  const counting = client as { execute: Client["execute"] };
  counting.execute = ((...args: Parameters<Client["execute"]>) => {
    queries += 1;
    return execute(...args);
  }) as Client["execute"];
  try {
    await run();
  } finally {
    counting.execute = execute;
  }
  return queries;
}

describe("readCurveGovernedLiabilityIds (#1334)", () => {
  test("an unmodelled debt is not curve-governed — the stored balance is all it has", async () => {
    const { store } = await seedStore();
    await seedLiability(store, "l_bare");

    expect(await store.liabilities.readCurveGovernedLiabilityIds()).toEqual(new Set());
  });

  test("an amortizable debt with no plan yet is not curve-governed either", async () => {
    const { store } = await seedStore();
    await seedLiability(store, "l_amort");
    await store.liabilities.setDebtModel("l_amort", "amortizable");

    expect(await store.liabilities.readCurveGovernedLiabilityIds()).toEqual(new Set());
  });

  test("a plan makes the curve the source of the figure", async () => {
    const { store } = await seedStore();
    await seedLiability(store, "l_amort");
    await store.liabilities.setDebtModel("l_amort", "amortizable");
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.0325",
      disbursementDate: "2020-01-15",
      firstPaymentDate: "2020-02-15",
      id: "plan_1",
      initialCapitalMinor: 120_000_00,
      liabilityId: "l_amort",
      termMonths: 240,
    });

    expect(await store.liabilities.readCurveGovernedLiabilityIds()).toEqual(
      new Set(["l_amort"]),
    );
  });

  test("a re-baseline alone (no plan row) is enough", async () => {
    const { store } = await seedStore();
    await seedLiability(store, "l_rebased");
    await store.liabilities.setDebtModel("l_rebased", "amortizable");
    await store.liabilities.addBalanceRebaseline({
      annualInterestRate: "0.0325",
      baselineDate: "2026-01-01",
      endDate: "2030-01-01",
      id: "reb_1",
      liabilityId: "l_rebased",
      nextPaymentDate: "2026-02-01",
      outstandingBalanceMinor: 90_000_00,
      startsAtBaseline: true,
    });

    expect(await store.liabilities.readCurveGovernedLiabilityIds()).toEqual(
      new Set(["l_rebased"]),
    );
  });

  test("one declared balance governs a revolving debt", async () => {
    const { store } = await seedStore();
    await seedLiability(store, "l_card");
    await store.liabilities.setDebtModel("l_card", "revolving");
    await store.liabilities.addBalanceAnchor({
      anchorDate: "2026-07-01",
      balanceMinor: 1_200_00,
      id: "anchor_1",
      liabilityId: "l_card",
    });

    expect(await store.liabilities.readCurveGovernedLiabilityIds()).toEqual(
      new Set(["l_card"]),
    );
  });

  test("a plan on ONE debt does not contaminate the debt next to it", async () => {
    const { store } = await seedStore();
    await seedLiability(store, "l_bare");
    await seedLiability(store, "l_amort");
    await store.liabilities.setDebtModel("l_amort", "amortizable");
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.0325",
      disbursementDate: "2020-01-15",
      firstPaymentDate: "2020-02-15",
      id: "plan_1",
      initialCapitalMinor: 120_000_00,
      liabilityId: "l_amort",
      termMonths: 240,
    });

    expect(await store.liabilities.readCurveGovernedLiabilityIds()).toEqual(
      new Set(["l_amort"]),
    );
  });

  test("the decision costs the same number of queries for 1 debt as for 12", async () => {
    // The N+1 the ticket forbids: deciding per row would be 3-4 reads per debt.
    const { client, store } = await seedStore();
    const read = () => store.liabilities.readCurveGovernedLiabilityIds();

    await seedLiability(store, "l_1");
    const forOne = await countQueries(client, read);

    for (let i = 2; i <= 12; i += 1) {
      await seedLiability(store, `l_${i}`);
      await store.liabilities.setDebtModel(`l_${i}`, "revolving");
      await store.liabilities.addBalanceAnchor({
        anchorDate: "2026-07-01",
        balanceMinor: 1_000_00 + i,
        id: `anchor_${i}`,
        liabilityId: `l_${i}`,
      });
    }
    const forTwelve = await countQueries(client, read);

    expect(forOne).toBeGreaterThan(0);
    expect(forTwelve).toBe(forOne);
    expect((await read()).size).toBe(11);
  });
});
