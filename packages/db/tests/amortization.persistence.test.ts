/**
 * Amortization plans + interest-rate revisions persistence (PRD #109, slice 7).
 *
 * Integration tests against a real in-memory store: the debt_model setter, CRUD
 * of amortization plans and rate revisions, and the balance-at-date method that
 * reads the plan + revisions and delegates to the pure domain curve.
 */
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "../src/index";
import type { WorthlineStore } from "../src/index";

function seed(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  store.liabilities.createLiability({
    balanceMinor: 195_465_37,
    currency: "EUR",
    id: "loan",
    name: "Hipoteca",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
}

describe("debt model setter", () => {
  test("sets and reads back a debt model", () => {
    const store = createInMemoryStore();
    seed(store);

    expect(store.liabilities.readDebtModel("loan")).toBeNull();
    store.liabilities.setDebtModel("loan", "amortizable");
    expect(store.liabilities.readDebtModel("loan")).toBe("amortizable");
    store.liabilities.setDebtModel("loan", null);
    expect(store.liabilities.readDebtModel("loan")).toBeNull();
  });
});

describe("amortization plan — CRUD", () => {
  test("create + read a plan back", () => {
    const store = createInMemoryStore();
    seed(store);

    store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      id: "plan1",
      initialCapitalMinor: 200_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    });

    const plan = store.liabilities.readAmortizationPlan("loan");
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

  test("the plan is 1:1 with its liability (unique index)", () => {
    const store = createInMemoryStore();
    seed(store);

    store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      id: "plan1",
      initialCapitalMinor: 200_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    });
    expect(() =>
      store.liabilities.createAmortizationPlan({
        annualInterestRate: "0.03",
        id: "plan2",
        initialCapitalMinor: 100_000_00,
        liabilityId: "loan",
        disbursementDate: "2020-01-01",
        firstPaymentDate: "2020-02-01",
        termMonths: 240,
      }),
    ).toThrow();
  });

  test("update a plan in place", () => {
    const store = createInMemoryStore();
    seed(store);
    store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      id: "plan1",
      initialCapitalMinor: 200_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    });

    const updated = store.liabilities.updateAmortizationPlan("plan1", {
      annualInterestRate: "0.03",
      termMonths: 240,
    });
    expect(updated).toBe(1);
    expect(store.liabilities.readAmortizationPlan("loan")).toMatchObject({
      annualInterestRate: "0.03",
      termMonths: 240,
    });
  });

  test("delete a plan by id", () => {
    const store = createInMemoryStore();
    seed(store);
    store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      id: "plan1",
      initialCapitalMinor: 200_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    });

    expect(store.liabilities.deleteAmortizationPlan("plan1")).toBe(1);
    expect(store.liabilities.readAmortizationPlan("loan")).toBeNull();
    expect(store.liabilities.deleteAmortizationPlan("plan1")).toBe(0);
  });

  test("rejects a non-integer initial capital", () => {
    const store = createInMemoryStore();
    seed(store);
    expect(() =>
      store.liabilities.createAmortizationPlan({
        annualInterestRate: "0.025",
        id: "bad",
        initialCapitalMinor: 100.5,
        liabilityId: "loan",
        disbursementDate: "2020-01-01",
        firstPaymentDate: "2020-02-01",
        termMonths: 360,
      }),
    ).toThrow();
  });

  test("rejects a malformed disbursement date", () => {
    const store = createInMemoryStore();
    seed(store);
    expect(() =>
      store.liabilities.createAmortizationPlan({
        annualInterestRate: "0.025",
        disbursementDate: "01/01/2020",
        firstPaymentDate: "2020-02-01",
        id: "bad",
        initialCapitalMinor: 200_000_00,
        liabilityId: "loan",
        termMonths: 360,
      }),
    ).toThrow();
  });

  test("rejects a malformed first-payment date", () => {
    const store = createInMemoryStore();
    seed(store);
    expect(() =>
      store.liabilities.createAmortizationPlan({
        annualInterestRate: "0.025",
        disbursementDate: "2020-01-01",
        firstPaymentDate: "01/02/2020",
        id: "bad",
        initialCapitalMinor: 200_000_00,
        liabilityId: "loan",
        termMonths: 360,
      }),
    ).toThrow();
  });

  test("rejects an unparseable interest rate", () => {
    const store = createInMemoryStore();
    seed(store);
    expect(() =>
      store.liabilities.createAmortizationPlan({
        annualInterestRate: "abc",
        id: "bad",
        initialCapitalMinor: 200_000_00,
        liabilityId: "loan",
        disbursementDate: "2020-01-01",
        firstPaymentDate: "2020-02-01",
        termMonths: 360,
      }),
    ).toThrow();
  });
});

describe("interest-rate revisions — CRUD", () => {
  function seedPlan(store: WorthlineStore): void {
    seed(store);
    store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.05",
      id: "plan1",
      initialCapitalMinor: 100_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 120,
    });
  }

  test("create + read revisions back, ordered by date", () => {
    const store = createInMemoryStore();
    seedPlan(store);

    store.liabilities.addInterestRateRevision({
      id: "r2",
      newAnnualInterestRate: "0.07",
      planId: "plan1",
      revisionDate: "2024-01-01",
    });
    store.liabilities.addInterestRateRevision({
      id: "r1",
      newAnnualInterestRate: "0.03",
      planId: "plan1",
      revisionDate: "2022-01-01",
    });

    const revisions = store.liabilities.readInterestRateRevisions("plan1");
    expect(revisions.map((r) => r.revisionDate)).toEqual(["2022-01-01", "2024-01-01"]);
    expect(revisions[0]).toMatchObject({
      id: "r1",
      newAnnualInterestRate: "0.03",
      revisionDate: "2022-01-01",
    });
  });

  test("update a revision's date and rate in place", () => {
    const store = createInMemoryStore();
    seedPlan(store);
    store.liabilities.addInterestRateRevision({
      id: "r1",
      newAnnualInterestRate: "0.03",
      planId: "plan1",
      revisionDate: "2022-01-01",
    });

    expect(
      store.liabilities.updateInterestRateRevision("r1", {
        newAnnualInterestRate: "0.04",
        revisionDate: "2022-06-01",
      }),
    ).toBe(1);

    const [revision] = store.liabilities.readInterestRateRevisions("plan1");
    expect(revision).toMatchObject({
      id: "r1",
      newAnnualInterestRate: "0.04",
      revisionDate: "2022-06-01",
    });
  });

  test("update returns 0 for an unknown revision", () => {
    const store = createInMemoryStore();
    seedPlan(store);
    expect(
      store.liabilities.updateInterestRateRevision("nope", {
        newAnnualInterestRate: "0.04",
      }),
    ).toBe(0);
  });

  test("delete a revision by id", () => {
    const store = createInMemoryStore();
    seedPlan(store);
    store.liabilities.addInterestRateRevision({
      id: "r1",
      newAnnualInterestRate: "0.03",
      planId: "plan1",
      revisionDate: "2022-01-01",
    });

    expect(store.liabilities.deleteInterestRateRevision("r1")).toBe(1);
    expect(store.liabilities.readInterestRateRevisions("plan1")).toHaveLength(0);
    expect(store.liabilities.deleteInterestRateRevision("r1")).toBe(0);
  });

  test("rejects a malformed revision date", () => {
    const store = createInMemoryStore();
    seedPlan(store);
    expect(() =>
      store.liabilities.addInterestRateRevision({
        id: "bad",
        newAnnualInterestRate: "0.03",
        planId: "plan1",
        revisionDate: "2022/01/01",
      }),
    ).toThrow();
  });
});

describe("amortizableBalanceAtDate — store reads plan + revisions and delegates", () => {
  test("PRD example: exact balance after 12 and 60 cuotas", () => {
    const store = createInMemoryStore();
    seed(store);
    store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      id: "plan1",
      initialCapitalMinor: 200_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    });

    expect(store.liabilities.amortizableBalanceAtDate("loan", "2021-01-01")).toBe(
      195_465_37,
    );
    expect(store.liabilities.amortizableBalanceAtDate("loan", "2025-01-01")).toBe(
      176_150_76,
    );
  });

  test("applies a stored rate revision", () => {
    const store = createInMemoryStore();
    seed(store);
    store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.05",
      id: "plan1",
      initialCapitalMinor: 100_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 120,
    });
    store.liabilities.addInterestRateRevision({
      id: "r1",
      newAnnualInterestRate: "0.03",
      planId: "plan1",
      revisionDate: "2022-01-01",
    });

    // At the revision boundary the balance matches the no-revision schedule.
    expect(store.liabilities.amortizableBalanceAtDate("loan", "2022-01-01")).toBe(
      83_780_56,
    );
  });

  test("throws when the liability has no amortization plan", () => {
    const store = createInMemoryStore();
    seed(store);
    expect(() =>
      store.liabilities.amortizableBalanceAtDate("loan", "2021-01-01"),
    ).toThrow();
  });
});

describe("early repayments — CRUD", () => {
  function seedPlan(store: WorthlineStore): void {
    seed(store);
    store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.03",
      id: "plan1",
      initialCapitalMinor: 100_000_00,
      liabilityId: "loan",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 120,
    });
  }

  test("create + read repayments back, ordered by date", () => {
    const store = createInMemoryStore();
    seedPlan(store);

    store.liabilities.addEarlyRepayment({
      amountMinor: 10_000_00,
      id: "e2",
      mode: "reduce-term",
      planId: "plan1",
      repaymentDate: "2024-01-01",
    });
    store.liabilities.addEarlyRepayment({
      amountMinor: 20_000_00,
      id: "e1",
      mode: "reduce-payment",
      planId: "plan1",
      repaymentDate: "2022-01-01",
    });

    const repayments = store.liabilities.readEarlyRepayments("plan1");
    expect(repayments.map((r) => r.repaymentDate)).toEqual(["2022-01-01", "2024-01-01"]);
    expect(repayments[0]).toMatchObject({
      amountMinor: 20_000_00,
      id: "e1",
      mode: "reduce-payment",
      repaymentDate: "2022-01-01",
    });
  });

  test("update a repayment's date, amount and mode in place", () => {
    const store = createInMemoryStore();
    seedPlan(store);
    store.liabilities.addEarlyRepayment({
      amountMinor: 20_000_00,
      id: "e1",
      mode: "reduce-payment",
      planId: "plan1",
      repaymentDate: "2022-01-01",
    });

    expect(
      store.liabilities.updateEarlyRepayment("e1", {
        amountMinor: 25_000_00,
        mode: "reduce-term",
        repaymentDate: "2022-06-01",
      }),
    ).toBe(1);

    const [repayment] = store.liabilities.readEarlyRepayments("plan1");
    expect(repayment).toMatchObject({
      amountMinor: 25_000_00,
      id: "e1",
      mode: "reduce-term",
      repaymentDate: "2022-06-01",
    });
  });

  test("update returns 0 for an unknown repayment", () => {
    const store = createInMemoryStore();
    seedPlan(store);
    expect(store.liabilities.updateEarlyRepayment("nope", { amountMinor: 1_00 })).toBe(0);
  });

  test("delete a repayment by id", () => {
    const store = createInMemoryStore();
    seedPlan(store);
    store.liabilities.addEarlyRepayment({
      amountMinor: 20_000_00,
      id: "e1",
      mode: "reduce-payment",
      planId: "plan1",
      repaymentDate: "2022-01-01",
    });

    expect(store.liabilities.deleteEarlyRepayment("e1")).toBe(1);
    expect(store.liabilities.readEarlyRepayments("plan1")).toHaveLength(0);
    expect(store.liabilities.deleteEarlyRepayment("e1")).toBe(0);
  });

  test("rejects a malformed repayment date", () => {
    const store = createInMemoryStore();
    seedPlan(store);
    expect(() =>
      store.liabilities.addEarlyRepayment({
        amountMinor: 20_000_00,
        id: "bad",
        mode: "reduce-payment",
        planId: "plan1",
        repaymentDate: "2022/01/01",
      }),
    ).toThrow();
  });

  test("amortizableBalanceAtDate applies a stored early repayment", () => {
    const store = createInMemoryStore();
    seedPlan(store);
    const withoutRepayment = store.liabilities.amortizableBalanceAtDate(
      "loan",
      "2022-01-01",
    );
    store.liabilities.addEarlyRepayment({
      amountMinor: 20_000_00,
      id: "e1",
      mode: "reduce-payment",
      planId: "plan1",
      repaymentDate: "2022-01-01",
    });
    // The lump lands on the target date → the balance drops by exactly it.
    expect(store.liabilities.amortizableBalanceAtDate("loan", "2022-01-01")).toBe(
      withoutRepayment - 20_000_00,
    );
  });
});
