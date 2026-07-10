/**
 * Store-level tests for importBalanceHistoryAndRipple (ADR 0056, #696) — the
 * batched balance-history seam: N re-baselines (`startsAtBaseline: false`) with
 * ONE ripple from the oldest checkpoint. Past before that date stays intact;
 * each fact is audit-trailed individually.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

const TODAY = "2026-07-02";

async function snapAt(store: WorthlineStore, dateKey: string) {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey);
}

async function debtsAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await snapAt(store, dateKey))?.debts.amountMinor;
}

async function seedAmortizableMortgage(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 150_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  await store.createAmortizationPlanAndRipple(
    {
      annualInterestRate: "0.03",
      disbursementDate: "2026-01-15",
      firstPaymentDate: "2026-02-15",
      id: "plan1",
      initialCapitalMinor: 150_000_00,
      liabilityId: "mortgage",
      termMonths: 240,
    },
    { today: TODAY },
  );
  return store;
}

describe("importBalanceHistoryAndRipple — batched re-baseline seam (#696)", () => {
  test("creates a chain of re-baselines with ONE ripple from the oldest checkpoint", async () => {
    const store = await seedAmortizableMortgage();
    const beforeOldest = await debtsAt(store, "2026-03-15");
    expect(beforeOldest).toBeDefined();

    await store.importBalanceHistoryAndRipple({
      liabilityId: "mortgage",
      rebaselines: [
        {
          annualInterestRate: "0.03",
          baselineDate: "2026-04-15",
          endDate: "2046-01-15",
          id: "reb1",
          liabilityId: "mortgage",
          nextPaymentDate: "2026-05-15",
          outstandingBalanceMinor: 145_000_00,
          startsAtBaseline: false,
        },
        {
          annualInterestRate: "0.03",
          baselineDate: "2026-06-15",
          endDate: "2046-01-15",
          id: "reb2",
          liabilityId: "mortgage",
          nextPaymentDate: "2026-07-15",
          outstandingBalanceMinor: 140_000_00,
          startsAtBaseline: false,
        },
      ],
      today: TODAY,
    });

    const rebaselines = await store.liabilities.readBalanceRebaselines("mortgage");
    expect(rebaselines).toHaveLength(2);
    expect(rebaselines.every((r) => r.startsAtBaseline === false)).toBe(true);

    expect(await debtsAt(store, "2026-03-15")).toBe(beforeOldest);
    expect(await debtsAt(store, "2026-04-15")).toBe(145_000_00);
    expect(await debtsAt(store, "2026-06-15")).toBe(140_000_00);

    store.close();
  });

  test("audit-trails each created re-baseline", async () => {
    const store = await seedAmortizableMortgage();

    await store.importBalanceHistoryAndRipple({
      liabilityId: "mortgage",
      rebaselines: [
        {
          annualInterestRate: "0.03",
          baselineDate: "2026-04-15",
          endDate: "2046-01-15",
          id: "reb1",
          liabilityId: "mortgage",
          nextPaymentDate: "2026-05-15",
          outstandingBalanceMinor: 145_000_00,
          startsAtBaseline: false,
        },
        {
          annualInterestRate: "0.03",
          baselineDate: "2026-06-15",
          endDate: "2046-01-15",
          id: "reb2",
          liabilityId: "mortgage",
          nextPaymentDate: "2026-07-15",
          outstandingBalanceMinor: 140_000_00,
          startsAtBaseline: false,
        },
      ],
      today: TODAY,
    });

    const audit = await store.readAuditLog({ entityId: "mortgage" });
    expect(
      audit.filter((entry) => entry.action === "add_balance_rebaseline"),
    ).toHaveLength(2);

    store.close();
  });

  test("returns 0 and ripples nothing for an empty batch", async () => {
    const store = await seedAmortizableMortgage();
    const before = await debtsAt(store, "2026-03-15");

    const created = await store.importBalanceHistoryAndRipple({
      liabilityId: "mortgage",
      rebaselines: [],
      today: TODAY,
    });
    expect(created).toBe(0);
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);
    expect(await debtsAt(store, "2026-03-15")).toBe(before);

    store.close();
  });

  test("rolls back the whole batch when a mid-insert fails", async () => {
    const store = await seedAmortizableMortgage();

    await expect(
      store.importBalanceHistoryAndRipple({
        liabilityId: "mortgage",
        rebaselines: [
          {
            annualInterestRate: "0.03",
            baselineDate: "2026-04-15",
            endDate: "2046-01-15",
            id: "reb_ok",
            liabilityId: "mortgage",
            nextPaymentDate: "2026-05-15",
            outstandingBalanceMinor: 145_000_00,
            startsAtBaseline: false,
          },
          {
            baselineDate: "2026-06-15",
            endDate: "2046-01-15",
            id: "reb_bad",
            liabilityId: "mortgage",
            nextPaymentDate: "2026-07-15",
            outstandingBalanceMinor: 140_000_00,
            startsAtBaseline: false,
          },
        ],
        today: TODAY,
      }),
    ).rejects.toThrow();

    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);

    store.close();
  });
});
