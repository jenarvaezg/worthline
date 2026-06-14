import { describe, expect, test } from "vitest";

import { debtBalanceAtDate } from "./debt-balance";
import type { DebtBalanceAtDateInput } from "./debt-balance";

/**
 * Pure debt-balance dispatcher (PRD #109, slice 8). The single "balance of a debt
 * on date X" entry point for the three debt models. Revolving interpolates
 * linearly between balance anchors by calendar days (flat outside the anchor
 * range); informal is a step function on the anchors with no interest ever;
 * amortizable delegates to the French-amortization curve. A null/empty model
 * returns the current balance constant.
 *
 * Pinned figures are computed at full big.js precision, rounded to the cent half
 * up only at the edge — the same single-rounding rule as amortization.ts (#116)
 * and housing-valuation.ts (#113).
 */

describe("debtBalanceAtDate — revolving (linear interpolation by days)", () => {
  const REVOLVING: DebtBalanceAtDateInput = {
    debtModel: "revolving",
    anchors: [
      { anchorDate: "2024-01-01", balanceMinor: 10_000_00 },
      { anchorDate: "2024-12-31", balanceMinor: 0 },
    ],
    currentBalanceMinor: 0,
    targetDate: "2024-01-01",
  };

  test("on the first anchor returns that anchor's balance", () => {
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2024-01-01" })).toBe(10_000_00);
  });

  test("on the last anchor returns that anchor's balance", () => {
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2024-12-31" })).toBe(0);
  });

  test("interpolates linearly by days between two anchors", () => {
    // 2024 is a leap year. From 2024-01-01 to 2024-12-31 is 365 days.
    // 2024-07-01 is 182 days after the first anchor.
    // balance = 10_000_00 + (0 - 10_000_00) * 182 / 365
    //         = 1_000_000 * (1 - 182/365) = 1_000_000 * 183/365 = 501369.86… → 501370
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2024-07-01" })).toBe(501_370);
  });

  test("before the first anchor is flat at the first balance (no extrapolation)", () => {
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2020-01-01" })).toBe(10_000_00);
  });

  test("after the last anchor is flat at the last balance (no extrapolation)", () => {
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2030-01-01" })).toBe(0);
  });

  test("three anchors: interpolates within the correct segment", () => {
    const anchors = [
      { anchorDate: "2024-01-01", balanceMinor: 10_000_00 },
      { anchorDate: "2024-07-01", balanceMinor: 6_000_00 },
      { anchorDate: "2025-01-01", balanceMinor: 6_000_00 },
    ];
    // 2024-04-01 is in the first segment: 91 days after 2024-01-01,
    // segment span 2024-01-01..2024-07-01 = 182 days.
    // balance = 1_000_000 + (600_000 - 1_000_000) * 91 / 182 = 1_000_000 - 400_000*0.5 = 800_000
    expect(
      debtBalanceAtDate({
        debtModel: "revolving",
        anchors,
        currentBalanceMinor: 6_000_00,
        targetDate: "2024-04-01",
      }),
    ).toBe(800_000);
    // Second segment is flat at 6_000_00.
    expect(
      debtBalanceAtDate({
        debtModel: "revolving",
        anchors,
        currentBalanceMinor: 6_000_00,
        targetDate: "2024-10-01",
      }),
    ).toBe(600_000);
  });

  test("anchors out of order are sorted before interpolation", () => {
    expect(
      debtBalanceAtDate({
        debtModel: "revolving",
        anchors: [
          { anchorDate: "2024-12-31", balanceMinor: 0 },
          { anchorDate: "2024-01-01", balanceMinor: 10_000_00 },
        ],
        currentBalanceMinor: 0,
        targetDate: "2024-07-01",
      }),
    ).toBe(501_370);
  });

  test("with no anchors falls back to the current balance constant", () => {
    expect(
      debtBalanceAtDate({
        debtModel: "revolving",
        anchors: [],
        currentBalanceMinor: 3_210_00,
        targetDate: "2024-07-01",
      }),
    ).toBe(3_210_00);
  });
});

describe("debtBalanceAtDate — informal (step function, no interest ever)", () => {
  const ANCHORS = [
    { anchorDate: "2023-01-01", balanceMinor: 5_000_00 },
    { anchorDate: "2023-06-01", balanceMinor: 3_000_00 },
    { anchorDate: "2024-01-01", balanceMinor: 1_000_00 },
  ];

  test("balance is the last anchor with date <= target (step, no interpolation)", () => {
    // Halfway between two anchors does NOT interpolate — it holds the earlier one.
    expect(
      debtBalanceAtDate({
        debtModel: "informal",
        anchors: ANCHORS,
        currentBalanceMinor: 1_000_00,
        targetDate: "2023-03-15",
      }),
    ).toBe(5_000_00);
    expect(
      debtBalanceAtDate({
        debtModel: "informal",
        anchors: ANCHORS,
        currentBalanceMinor: 1_000_00,
        targetDate: "2023-06-01",
      }),
    ).toBe(3_000_00);
    expect(
      debtBalanceAtDate({
        debtModel: "informal",
        anchors: ANCHORS,
        currentBalanceMinor: 1_000_00,
        targetDate: "2023-09-09",
      }),
    ).toBe(3_000_00);
  });

  test("the declared balance is used as-is, never accruing interest", () => {
    // Far in the future, the step holds the last declared figure flat — no growth.
    expect(
      debtBalanceAtDate({
        debtModel: "informal",
        anchors: ANCHORS,
        currentBalanceMinor: 1_000_00,
        targetDate: "2099-12-31",
      }),
    ).toBe(1_000_00);
  });

  test("before the first anchor with an initial capital uses that capital", () => {
    expect(
      debtBalanceAtDate({
        debtModel: "informal",
        anchors: ANCHORS,
        initialCapitalMinor: 6_000_00,
        currentBalanceMinor: 1_000_00,
        targetDate: "2020-01-01",
      }),
    ).toBe(6_000_00);
  });

  test("before the first anchor with no initial capital uses the current balance", () => {
    expect(
      debtBalanceAtDate({
        debtModel: "informal",
        anchors: ANCHORS,
        currentBalanceMinor: 1_000_00,
        targetDate: "2020-01-01",
      }),
    ).toBe(1_000_00);
  });

  test("with no anchors and no initial capital uses the current balance", () => {
    expect(
      debtBalanceAtDate({
        debtModel: "informal",
        anchors: [],
        currentBalanceMinor: 7_777_77,
        targetDate: "2024-07-01",
      }),
    ).toBe(7_777_77);
  });

  test("with no anchors but an initial capital uses the capital before nothing", () => {
    // No anchor with date <= target → initial capital.
    expect(
      debtBalanceAtDate({
        debtModel: "informal",
        anchors: [],
        initialCapitalMinor: 9_000_00,
        currentBalanceMinor: 7_777_77,
        targetDate: "2024-07-01",
      }),
    ).toBe(9_000_00);
  });
});

describe("debtBalanceAtDate — amortizable (delegates to French curve)", () => {
  test("dispatches to amortizableBalanceAtDate using the plan + revisions", () => {
    const input: DebtBalanceAtDateInput = {
      debtModel: "amortizable",
      plan: {
        annualInterestRate: "0.025",
        initialCapitalMinor: 200_000_00,
        disbursementDate: "2020-01-01",
        firstPaymentDate: "2020-02-01",
        termMonths: 360,
      },
      currentBalanceMinor: 0,
      targetDate: "2019-06-01",
    };
    // Before the loan starts → full initial capital (the amortization contract).
    expect(debtBalanceAtDate(input)).toBe(200_000_00);
    // After the final payment → zero.
    expect(debtBalanceAtDate({ ...input, targetDate: "2050-01-01" })).toBe(0);
  });

  test("threads early repayments through to the amortization curve", () => {
    const plan = {
      annualInterestRate: "0.03",
      initialCapitalMinor: 100_000_00,
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 120,
    };
    const at = "2022-01-01";
    const withoutRepayment = debtBalanceAtDate({
      currentBalanceMinor: 0,
      debtModel: "amortizable",
      plan,
      targetDate: at,
    });
    const withRepayment = debtBalanceAtDate({
      currentBalanceMinor: 0,
      debtModel: "amortizable",
      earlyRepayments: [
        { amountMinor: 20_000_00, mode: "reduce-payment", repaymentDate: "2022-01-01" },
      ],
      plan,
      targetDate: at,
    });
    // The lump lands on the target date, so the balance drops by exactly it —
    // the dispatcher must thread early repayments into the curve, not drop them.
    expect(withRepayment).toBe(withoutRepayment - 20_000_00);
  });

  test("with no plan falls back to the current balance constant", () => {
    expect(
      debtBalanceAtDate({
        debtModel: "amortizable",
        currentBalanceMinor: 4_500_00,
        targetDate: "2024-07-01",
      }),
    ).toBe(4_500_00);
  });
});

describe("debtBalanceAtDate — null / unmodelled", () => {
  test("null debt model returns the current balance constant", () => {
    expect(
      debtBalanceAtDate({
        debtModel: null,
        currentBalanceMinor: 12_345_67,
        targetDate: "2024-07-01",
      }),
    ).toBe(12_345_67);
  });

  test("null debt model ignores any incidental anchors", () => {
    expect(
      debtBalanceAtDate({
        debtModel: null,
        anchors: [{ anchorDate: "2024-01-01", balanceMinor: 999_99 }],
        currentBalanceMinor: 12_345_67,
        targetDate: "2024-07-01",
      }),
    ).toBe(12_345_67);
  });
});
