/**
 * Amortizable debt commands (#970): exercise the command interface directly
 * against an in-memory store — no server actions.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

const TODAY = "2026-07-02";

async function debtsAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey)
    ?.debts.amountMinor;
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
  return store;
}

describe("amortizable debt commands (#970)", () => {
  test("create plan via command generates snapshots along the amortization schedule", async () => {
    const store = await seedAmortizableMortgage();

    await store.command.createAmortizationPlan(
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

    expect(await store.liabilities.readAmortizationPlan("mortgage")).toBeTruthy();
    expect(await debtsAt(store, "2026-02-15")).toBe(
      await store.liabilities.debtBalanceAtDate("mortgage", "2026-02-15"),
    );

    store.close();
  });

  test("update interest rate revision ripples from the earlier of old and new dates", async () => {
    const store = await seedAmortizableMortgage();
    await store.command.createAmortizationPlan(
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
    await store.command.addInterestRateRevision(
      {
        id: "rev1",
        newAnnualInterestRate: "0.06",
        planId: "plan1",
        revisionDate: "2026-04-15",
      },
      { liabilityId: "mortgage", today: TODAY },
    );
    const before0515 = (await debtsAt(store, "2026-05-15"))!;

    const changes = await store.command.updateInterestRateRevision(
      "rev1",
      { revisionDate: "2026-03-15" },
      { today: TODAY },
    );

    expect(changes).toBe(1);
    for (const dateKey of ["2026-03-15", "2026-04-15", "2026-05-15"]) {
      expect(await debtsAt(store, dateKey)).toBe(
        await store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    expect(await debtsAt(store, "2026-05-15")).not.toBe(before0515);

    store.close();
  });

  test("create current-state debt persists plan and startsAtBaseline rebaseline atomically", async () => {
    const store = await seedAmortizableMortgage();

    await store.command.createCurrentStateDebt({
      plan: {
        annualInterestRate: "0.0235",
        disbursementDate: TODAY,
        firstPaymentDate: "2026-08-01",
        id: "plan_cs",
        initialCapitalMinor: 118_000_00,
        liabilityId: "mortgage",
        termMonths: 72,
      },
      rebaseline: {
        annualInterestRate: "0.0235",
        baselineDate: TODAY,
        endDate: "2032-06-30",
        id: "reb_cs",
        liabilityId: "mortgage",
        nextPaymentDate: "2026-08-01",
        outstandingBalanceMinor: 118_000_00,
        startsAtBaseline: true,
      },
      today: TODAY,
    });

    expect(await store.liabilities.readAmortizationPlan("mortgage")).toBeTruthy();
    const rebaselines = await store.liabilities.readBalanceRebaselines("mortgage");
    expect(rebaselines).toHaveLength(1);
    expect(rebaselines[0]?.startsAtBaseline).toBe(true);

    const liability = (await store.liabilities.readLiabilities()).find(
      (l) => l.id === "mortgage",
    )!;
    expect(liability.currentBalance.amountMinor).toBe(118_000_00);
    expect(
      await store.liabilities.debtBalanceAtDate("mortgage", "2027-08-01"),
    ).toBeLessThan(118_000_00);

    store.close();
  });

  test("recalibrate debt balance ripples forward only from the declared checkpoint", async () => {
    const store = await seedAmortizableMortgage();
    await store.command.createAmortizationPlan(
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
    const beforeRecalibration = await debtsAt(store, "2026-03-15");
    expect(beforeRecalibration).toBeDefined();

    await store.command.addBalanceRebaseline(
      {
        annualInterestRate: "0.03",
        baselineDate: "2026-06-15",
        endDate: "2046-01-15",
        id: "reb1",
        liabilityId: "mortgage",
        nextPaymentDate: "2026-07-15",
        outstandingBalanceMinor: 140_000_00,
        startsAtBaseline: false,
      },
      { today: TODAY },
    );

    expect(await debtsAt(store, "2026-03-15")).toBe(beforeRecalibration);
    expect(await debtsAt(store, "2026-06-15")).toBe(140_000_00);
    expect(await store.liabilities.debtBalanceAtDate("mortgage", "2026-06-15")).toBe(
      140_000_00,
    );

    store.close();
  });
});
