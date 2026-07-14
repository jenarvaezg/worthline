/**
 * Amortization plans + interest-rate revisions persistence (PRD #109, slice 7).
 *
 * Integration tests against a real in-memory store: the debt_model setter, CRUD
 * of amortization plans and rate revisions, and the balance-at-date method that
 * reads the plan + revisions and delegates to the pure domain curve.
 */

import type { PersistenceTestStore as WorthlineStore } from "@db/testing";
import { createInMemoryStore } from "@db/testing";
import { describe, expect, test } from "vitest";

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 195_465_37,
    currency: "EUR",
    id: "loan",
    name: "Hipoteca",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
}

describe("debt model setter", () => {
  test("sets and reads back a debt model", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    expect(await store.liabilities.readDebtModel("loan")).toBeNull();
    await store.liabilities.setDebtModel("loan", "amortizable");
    expect(await store.liabilities.readDebtModel("loan")).toBe("amortizable");
    await store.liabilities.setDebtModel("loan", null);
    expect(await store.liabilities.readDebtModel("loan")).toBeNull();
  });
});

describe("amortization plan — CRUD", () => {
  test("create + read a plan back", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      id: "plan1",
      initialCapitalMinor: 200_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    });

    const plan = await store.liabilities.readAmortizationPlan("loan");
    expect(plan).toMatchObject({
      annualInterestRate: "0.025",
      id: "plan1",
      initialCapitalMinor: 200_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    });
  });

  test("the plan is 1:1 with its liability (unique index)", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      id: "plan1",
      initialCapitalMinor: 200_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    });
    await expect(
      store.liabilities.createAmortizationPlan({
        annualInterestRate: "0.03",
        id: "plan2",
        initialCapitalMinor: 100_000_00,
        liabilityId: "loan",
        disbursementDate: "2020-01-01",
        firstPaymentDate: "2020-02-01",
        termMonths: 240,
      }),
    ).rejects.toThrow();
  });

  test("update a plan in place", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      id: "plan1",
      initialCapitalMinor: 200_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    });

    const updated = await store.liabilities.updateAmortizationPlan("plan1", {
      annualInterestRate: "0.03",
      termMonths: 240,
    });
    expect(updated).toBe(1);
    expect(await store.liabilities.readAmortizationPlan("loan")).toMatchObject({
      annualInterestRate: "0.03",
      termMonths: 240,
    });
  });

  test("delete a plan by id", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      id: "plan1",
      initialCapitalMinor: 200_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    });

    expect(await store.liabilities.deleteAmortizationPlan("plan1")).toBe(1);
    expect(await store.liabilities.readAmortizationPlan("loan")).toBeNull();
    expect(await store.liabilities.deleteAmortizationPlan("plan1")).toBe(0);
  });

  test("rejects a non-integer initial capital", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await expect(
      store.liabilities.createAmortizationPlan({
        annualInterestRate: "0.025",
        id: "bad",
        initialCapitalMinor: 100.5,
        liabilityId: "loan",
        disbursementDate: "2020-01-01",
        firstPaymentDate: "2020-02-01",
        termMonths: 360,
      }),
    ).rejects.toThrow();
  });

  test("rejects a malformed disbursement date", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await expect(
      store.liabilities.createAmortizationPlan({
        annualInterestRate: "0.025",
        disbursementDate: "01/01/2020",
        firstPaymentDate: "2020-02-01",
        id: "bad",
        initialCapitalMinor: 200_000_00,
        liabilityId: "loan",
        termMonths: 360,
      }),
    ).rejects.toThrow();
  });

  test("rejects a malformed first-payment date", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await expect(
      store.liabilities.createAmortizationPlan({
        annualInterestRate: "0.025",
        disbursementDate: "2020-01-01",
        firstPaymentDate: "01/02/2020",
        id: "bad",
        initialCapitalMinor: 200_000_00,
        liabilityId: "loan",
        termMonths: 360,
      }),
    ).rejects.toThrow();
  });

  test("rejects an unparseable interest rate", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await expect(
      store.liabilities.createAmortizationPlan({
        annualInterestRate: "abc",
        id: "bad",
        initialCapitalMinor: 200_000_00,
        liabilityId: "loan",
        disbursementDate: "2020-01-01",
        firstPaymentDate: "2020-02-01",
        termMonths: 360,
      }),
    ).rejects.toThrow();
  });
});

describe("balance re-baselines — CRUD", () => {
  test("create, update, delete and audit a liability-level re-baseline fact", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.liabilities.setDebtModel("loan", "amortizable");

    await store.liabilities.addBalanceRebaseline({
      annualInterestRate: "0",
      baselineDate: "2026-07-02",
      endDate: "2026-09-30",
      id: "base1",
      liabilityId: "loan",
      nextPaymentDate: "2026-08-31",
      outstandingBalanceMinor: 100_000_00,
      startsAtBaseline: true,
    });

    expect(await store.liabilities.readBalanceRebaselines("loan")).toEqual([
      {
        annualInterestRate: "0",
        baselineDate: "2026-07-02",
        endDate: "2026-09-30",
        id: "base1",
        inputMode: "annual-rate",
        liabilityId: "loan",
        monthlyPaymentMinor: 50_000_00,
        nextPaymentDate: "2026-08-31",
        outstandingBalanceMinor: 100_000_00,
        source: "manual",
        startsAtBaseline: true,
      },
    ]);

    expect(
      await store.liabilities.updateBalanceRebaseline("base1", {
        monthlyPaymentMinor: 60_000_00,
      }),
    ).toMatchObject({ baselineDate: "2026-07-02", changes: 1, liabilityId: "loan" });
    const [updated] = await store.liabilities.readBalanceRebaselines("loan");
    expect(updated).toMatchObject({
      inputMode: "monthly-payment",
      monthlyPaymentMinor: 60_000_00,
    });
    expect(Number(updated!.annualInterestRate)).toBeGreaterThan(0);

    expect(await store.liabilities.deleteBalanceRebaseline("base1")).toMatchObject({
      baselineDate: "2026-07-02",
      changes: 1,
      liabilityId: "loan",
    });
    expect(await store.liabilities.readBalanceRebaselines("loan")).toEqual([]);

    expect(
      (await store.readAuditLog({ entityId: "loan" })).map((row) => row.action),
    ).toEqual(
      expect.arrayContaining([
        "add_balance_rebaseline",
        "update_balance_rebaseline",
        "delete_balance_rebaseline",
      ]),
    );
    store.close();
  });
});

describe("interest-rate revisions — CRUD", () => {
  async function seedPlan(store: WorthlineStore): Promise<void> {
    await seed(store);
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.05",
      id: "plan1",
      initialCapitalMinor: 100_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 120,
    });
  }

  test("create + read revisions back, ordered by date", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);

    await store.liabilities.addInterestRateRevision({
      id: "r2",
      newAnnualInterestRate: "0.07",
      planId: "plan1",
      revisionDate: "2024-01-01",
    });
    await store.liabilities.addInterestRateRevision({
      id: "r1",
      newAnnualInterestRate: "0.03",
      planId: "plan1",
      revisionDate: "2022-01-01",
    });

    const revisions = await store.liabilities.readInterestRateRevisions("plan1");
    expect(revisions.map((r) => r.revisionDate)).toEqual(["2022-01-01", "2024-01-01"]);
    expect(revisions[0]).toMatchObject({
      id: "r1",
      newAnnualInterestRate: "0.03",
      revisionDate: "2022-01-01",
    });
  });

  test("update a revision's date and rate in place", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);
    await store.liabilities.addInterestRateRevision({
      id: "r1",
      newAnnualInterestRate: "0.03",
      planId: "plan1",
      revisionDate: "2022-01-01",
    });

    expect(
      (
        await store.liabilities.updateInterestRateRevision("r1", {
          newAnnualInterestRate: "0.04",
          revisionDate: "2022-06-01",
        })
      ).changes,
    ).toBe(1);

    const [revision] = await store.liabilities.readInterestRateRevisions("plan1");
    expect(revision).toMatchObject({
      id: "r1",
      newAnnualInterestRate: "0.04",
      revisionDate: "2022-06-01",
    });
  });

  test("update returns 0 for an unknown revision", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);
    expect(
      (
        await store.liabilities.updateInterestRateRevision("nope", {
          newAnnualInterestRate: "0.04",
        })
      ).changes,
    ).toBe(0);
  });

  test("delete a revision by id", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);
    await store.liabilities.addInterestRateRevision({
      id: "r1",
      newAnnualInterestRate: "0.03",
      planId: "plan1",
      revisionDate: "2022-01-01",
    });

    expect((await store.liabilities.deleteInterestRateRevision("r1")).changes).toBe(1);
    expect(await store.liabilities.readInterestRateRevisions("plan1")).toHaveLength(0);
    expect((await store.liabilities.deleteInterestRateRevision("r1")).changes).toBe(0);
  });

  test("rejects a malformed revision date", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);
    await expect(
      store.liabilities.addInterestRateRevision({
        id: "bad",
        newAnnualInterestRate: "0.03",
        planId: "plan1",
        revisionDate: "2022/01/01",
      }),
    ).rejects.toThrow();
  });

  // #210: the 120-month plan first-paid 2020-02-01 ends on its final payment
  // boundary 2030-01-01. A revision dated after that resolves past termMonths and
  // would be silently dropped by the build loop — reject it at intake instead.
  test("rejects a rate revision dated after the loan's final boundary (not silently dropped)", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);
    await expect(
      store.liabilities.addInterestRateRevision({
        id: "far",
        newAnnualInterestRate: "0.03",
        planId: "plan1",
        revisionDate: "2035-06-15",
      }),
    ).rejects.toThrow();
    // The bad revision was never persisted.
    expect(await store.liabilities.readInterestRateRevisions("plan1")).toHaveLength(0);
  });

  test("accepts a rate revision well inside the term", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);
    await expect(
      store.liabilities.addInterestRateRevision({
        id: "ok",
        newAnnualInterestRate: "0.03",
        planId: "plan1",
        revisionDate: "2024-01-01",
      }),
    ).resolves.not.toThrow();
    expect(await store.liabilities.readInterestRateRevisions("plan1")).toHaveLength(1);
  });
});

describe("amortizableBalanceAtDate — store reads plan + revisions and delegates", () => {
  test("PRD example: exact balance after 12 and 60 cuotas", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      id: "plan1",
      initialCapitalMinor: 200_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    });

    expect(await store.liabilities.amortizableBalanceAtDate("loan", "2021-01-01")).toBe(
      195_465_37,
    );
    expect(await store.liabilities.amortizableBalanceAtDate("loan", "2025-01-01")).toBe(
      176_150_76,
    );
  });

  test("applies a stored rate revision", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.05",
      id: "plan1",
      initialCapitalMinor: 100_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 120,
    });
    await store.liabilities.addInterestRateRevision({
      id: "r1",
      newAnnualInterestRate: "0.03",
      planId: "plan1",
      revisionDate: "2022-01-01",
    });

    // At the revision boundary the balance matches the no-revision schedule.
    expect(await store.liabilities.amortizableBalanceAtDate("loan", "2022-01-01")).toBe(
      83_780_56,
    );
  });

  test("throws when the liability has no amortization plan", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await expect(
      store.liabilities.amortizableBalanceAtDate("loan", "2021-01-01"),
    ).rejects.toThrow();
  });
});

describe("early repayments — CRUD", () => {
  async function seedPlan(store: WorthlineStore): Promise<void> {
    await seed(store);
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.03",
      id: "plan1",
      initialCapitalMinor: 100_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 120,
    });
  }

  test("create + read repayments back, ordered by date", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);

    await store.liabilities.addEarlyRepayment({
      amountMinor: 10_000_00,
      id: "e2",
      mode: "reduce-term",
      planId: "plan1",
      repaymentDate: "2024-01-01",
    });
    await store.liabilities.addEarlyRepayment({
      amountMinor: 20_000_00,
      id: "e1",
      mode: "reduce-payment",
      planId: "plan1",
      repaymentDate: "2022-01-01",
    });

    const repayments = await store.liabilities.readEarlyRepayments("plan1");
    expect(repayments.map((r) => r.repaymentDate)).toEqual(["2022-01-01", "2024-01-01"]);
    expect(repayments[0]).toMatchObject({
      amountMinor: 20_000_00,
      id: "e1",
      mode: "reduce-payment",
      repaymentDate: "2022-01-01",
    });
  });

  test("update a repayment's date, amount and mode in place", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);
    await store.liabilities.addEarlyRepayment({
      amountMinor: 20_000_00,
      id: "e1",
      mode: "reduce-payment",
      planId: "plan1",
      repaymentDate: "2022-01-01",
    });

    expect(
      (
        await store.liabilities.updateEarlyRepayment("e1", {
          amountMinor: 25_000_00,
          mode: "reduce-term",
          repaymentDate: "2022-06-01",
        })
      ).changes,
    ).toBe(1);

    const [repayment] = await store.liabilities.readEarlyRepayments("plan1");
    expect(repayment).toMatchObject({
      amountMinor: 25_000_00,
      id: "e1",
      mode: "reduce-term",
      repaymentDate: "2022-06-01",
    });
  });

  test("update returns 0 for an unknown repayment", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);
    expect(
      (await store.liabilities.updateEarlyRepayment("nope", { amountMinor: 1_00 }))
        .changes,
    ).toBe(0);
  });

  test("delete a repayment by id", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);
    await store.liabilities.addEarlyRepayment({
      amountMinor: 20_000_00,
      id: "e1",
      mode: "reduce-payment",
      planId: "plan1",
      repaymentDate: "2022-01-01",
    });

    expect((await store.liabilities.deleteEarlyRepayment("e1")).changes).toBe(1);
    expect(await store.liabilities.readEarlyRepayments("plan1")).toHaveLength(0);
    expect((await store.liabilities.deleteEarlyRepayment("e1")).changes).toBe(0);
  });

  test("rejects a malformed repayment date", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);
    await expect(
      store.liabilities.addEarlyRepayment({
        amountMinor: 20_000_00,
        id: "bad",
        mode: "reduce-payment",
        planId: "plan1",
        repaymentDate: "2022/01/01",
      }),
    ).rejects.toThrow();
  });

  // #210: the 120-month plan first-paid 2020-02-01 ends on its final payment
  // boundary 2030-01-01. A repayment dated after that (e.g. a mistyped 2040 date)
  // resolves to month 240, past termMonths, and would be silently dropped by the
  // build loop — reject it at intake instead.
  test("rejects an early repayment dated after the loan's final boundary (not silently dropped)", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);
    await expect(
      store.liabilities.addEarlyRepayment({
        amountMinor: 20_000_00,
        id: "far",
        mode: "reduce-payment",
        planId: "plan1",
        repaymentDate: "2040-01-01",
      }),
    ).rejects.toThrow();
    // The bad repayment was never persisted.
    expect(await store.liabilities.readEarlyRepayments("plan1")).toHaveLength(0);
  });

  test("accepts an early repayment well inside the term", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);
    await expect(
      store.liabilities.addEarlyRepayment({
        amountMinor: 20_000_00,
        id: "ok",
        mode: "reduce-payment",
        planId: "plan1",
        repaymentDate: "2024-01-01",
      }),
    ).resolves.not.toThrow();
    expect(await store.liabilities.readEarlyRepayments("plan1")).toHaveLength(1);
  });

  test("amortizableBalanceAtDate applies a stored early repayment", async () => {
    const store = await createInMemoryStore();
    await seedPlan(store);
    const withoutRepayment = await store.liabilities.amortizableBalanceAtDate(
      "loan",
      "2022-01-01",
    );
    await store.liabilities.addEarlyRepayment({
      amountMinor: 20_000_00,
      id: "e1",
      mode: "reduce-payment",
      planId: "plan1",
      repaymentDate: "2022-01-01",
    });
    // The lump lands on the target date → the balance drops by exactly it.
    expect(await store.liabilities.amortizableBalanceAtDate("loan", "2022-01-01")).toBe(
      withoutRepayment - 20_000_00,
    );
  });
});
