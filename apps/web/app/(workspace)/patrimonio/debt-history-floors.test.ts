/**
 * The debt-history floors the alta's acquisition question reads (#1561): which
 * debts declare a start date at all, and which date that is.
 */

import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { beforeEach, describe, expect, test } from "vitest";

import { readDebtHistoryFloors } from "./debt-history-floors";

const TODAY = "2026-08-26";
const MEMBER_ID = "mJ";

let store: WorthlineStore;

beforeEach(async () => {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jorge" }],
    mode: "individual",
  });
});

async function seedDebt(id: string, name: string): Promise<void> {
  await store.liabilities.createLiability({
    balanceMinor: 100_000_00,
    currency: "EUR",
    id,
    name,
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel(id, "amortizable");
}

describe("readDebtHistoryFloors", () => {
  test("an amortizable debt floors at its disbursement date, not its first payment", async () => {
    await seedDebt("hipoteca", "Hipoteca Plasencia");
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.04",
      disbursementDate: "2004-05-19",
      firstPaymentDate: "2004-06-19",
      id: "plan1",
      initialCapitalMinor: 120_000_00,
      liabilityId: "hipoteca",
      termMonths: 300,
    });

    expect(await readDebtHistoryFloors(store)).toEqual([
      { liabilityId: "hipoteca", startDate: "2004-05-19" },
    ]);
  });

  test("an «estado actual» debt floors at the declared firma, older than its re-baseline", async () => {
    await seedDebt("hipoteca", "Hipoteca");
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.02",
      disbursementDate: TODAY,
      firstPaymentDate: "2026-09-26",
      id: "plan1",
      initialCapitalMinor: 90_000_00,
      liabilityId: "hipoteca",
      originalSigningDate: "2004-05-19",
      termMonths: 120,
    });

    expect(await readDebtHistoryFloors(store)).toEqual([
      { liabilityId: "hipoteca", startDate: "2004-05-19" },
    ]);
  });

  test("a debt with no plan declares no start date and is left out", async () => {
    await seedDebt("tarjeta", "Tarjeta");

    expect(await readDebtHistoryFloors(store)).toEqual([]);
  });

  test("no debts at all → no floors", async () => {
    expect(await readDebtHistoryFloors(store)).toEqual([]);
  });
});
