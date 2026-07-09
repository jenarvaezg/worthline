/**
 * Store-level tests for createCurrentStateDebtAndRipple (ADR 0056, PRD #670
 * S2, #677 review H2) — the atomic seam that replaces three separate
 * transactions (plan insert, rebaseline insert, balance sync) with one. A
 * current-state debt must never land with one dated fact but not the other:
 * a plan without a rebaseline reads as an origin-declared debt and blocks a
 * retry (the unique index on `amortization_plans.liability_id`); a rebaseline
 * without the balance sync leaves `currentBalanceMinor` stale.
 */

import type {
  AddBalanceRebaselineInput,
  CreateAmortizationPlanInput,
  WorthlineStore,
} from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

const TODAY = "2026-07-02";

async function seedAmortizableMortgage(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 1, // deliberately stale — the seam must overwrite it
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  return store;
}

const PLAN: CreateAmortizationPlanInput = {
  annualInterestRate: "0.0235",
  disbursementDate: TODAY,
  firstPaymentDate: "2026-08-01",
  id: "plan1",
  initialCapitalMinor: 118_000_00,
  liabilityId: "mortgage",
  termMonths: 72,
};

const REBASELINE: AddBalanceRebaselineInput = {
  annualInterestRate: "0.0235",
  baselineDate: TODAY,
  endDate: "2032-06-30",
  id: "reb1",
  liabilityId: "mortgage",
  nextPaymentDate: "2026-08-01",
  outstandingBalanceMinor: 118_000_00,
  startsAtBaseline: true,
};

describe("createCurrentStateDebtAndRipple — atomicity (#677 review H2)", () => {
  test("lands the plan, the startsAtBaseline rebaseline, and the balance sync together", async () => {
    const store = await seedAmortizableMortgage();

    await store.createCurrentStateDebtAndRipple({
      plan: PLAN,
      rebaseline: REBASELINE,
      today: TODAY,
    });

    expect(await store.liabilities.readAmortizationPlan("mortgage")).toMatchObject({
      id: "plan1",
      initialCapitalMinor: 118_000_00,
    });

    const rebaselines = await store.liabilities.readBalanceRebaselines("mortgage");
    expect(rebaselines).toHaveLength(1);
    expect(rebaselines[0]).toMatchObject({ id: "reb1", startsAtBaseline: true });

    const liability = (await store.liabilities.readLiabilities()).find(
      (l) => l.id === "mortgage",
    )!;
    expect(liability.currentBalance.amountMinor).toBe(118_000_00);

    // The ripple wired the curve: a future date reads the amortized balance,
    // not the (now-stale) currentBalanceMinor the liability started with.
    expect(
      await store.liabilities.debtBalanceAtDate("mortgage", "2027-08-01"),
    ).toBeLessThan(118_000_00);

    store.close();
  });

  test("a forced mid-failure (invalid rebaseline) persists NEITHER fact nor the balance sync", async () => {
    const store = await seedAmortizableMortgage();

    // Neither annualInterestRate nor monthlyPaymentMinor: addBalanceRebaseline's
    // internal deriveRebaselineStorage throws ("Provide exactly one of...") —
    // AFTER the plan insert already ran in the same transaction.
    const invalidRebaseline = {
      baselineDate: TODAY,
      endDate: "2032-06-30",
      id: "reb1",
      liabilityId: "mortgage",
      nextPaymentDate: "2026-08-01",
      outstandingBalanceMinor: 118_000_00,
      startsAtBaseline: true,
    } as AddBalanceRebaselineInput;

    await expect(
      store.createCurrentStateDebtAndRipple({
        plan: PLAN,
        rebaseline: invalidRebaseline,
        today: TODAY,
      }),
    ).rejects.toThrow();

    // Rolled back whole: the plan the failed transaction inserted first is gone too.
    expect(await store.liabilities.readAmortizationPlan("mortgage")).toBeNull();
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);
    const liability = (await store.liabilities.readLiabilities()).find(
      (l) => l.id === "mortgage",
    )!;
    expect(liability.currentBalance.amountMinor).toBe(1);

    store.close();
  });
});
