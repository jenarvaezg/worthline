import { describe, expect, test } from "vitest";

import {
  amortizationPlanFromBalanceRebaseline,
  amortizableBalanceAtDate,
} from "./amortization";
import { debtBalanceAtDate, effectiveAmortizationPlan } from "./debt-balance";
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

describe("debtBalanceAtDate — revolving step (default, ADR 0031)", () => {
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

  test("between two anchors holds the most recent anchor (step), not interpolated", () => {
    // Step: the balance on a between-anchor date is the last anchor with date ≤ target,
    // flat until the next — not the 501_370 the linear curve would give on 2024-07-01.
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2024-07-01" })).toBe(10_000_00);
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2024-12-30" })).toBe(10_000_00);
  });

  test("before the first anchor is flat at the first balance (no extrapolation)", () => {
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2020-01-01" })).toBe(10_000_00);
  });

  test("after the last anchor is flat at the last balance (no extrapolation)", () => {
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2030-01-01" })).toBe(0);
  });

  test("three anchors: holds the most recent anchor within each segment", () => {
    const anchors = [
      { anchorDate: "2024-01-01", balanceMinor: 10_000_00 },
      { anchorDate: "2024-07-01", balanceMinor: 6_000_00 },
      { anchorDate: "2025-01-01", balanceMinor: 6_000_00 },
    ];
    // First segment holds the 2024-01-01 anchor (the linear curve would give 800_000).
    expect(
      debtBalanceAtDate({
        debtModel: "revolving",
        anchors,
        currentBalanceMinor: 6_000_00,
        targetDate: "2024-04-01",
      }),
    ).toBe(10_000_00);
    // Second segment holds the 2024-07-01 anchor.
    expect(
      debtBalanceAtDate({
        debtModel: "revolving",
        anchors,
        currentBalanceMinor: 6_000_00,
        targetDate: "2024-10-01",
      }),
    ).toBe(600_000);
  });

  test("anchors out of order are sorted before stepping", () => {
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
    ).toBe(10_000_00);
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

  test("a revolving debt and an informal debt with the same anchors share a curve in range", () => {
    const anchors = [
      { anchorDate: "2024-01-01", balanceMinor: 10_000_00 },
      { anchorDate: "2024-07-01", balanceMinor: 6_000_00 },
    ];
    // Within the declared anchor range the two share a curve. Before the first
    // anchor they diverge by design (revolving flattens to the first anchor,
    // informal falls back to its initial/current balance), so compare from the
    // first anchor onward.
    for (const targetDate of ["2024-01-01", "2024-04-01", "2024-07-01", "2025-01-01"]) {
      const revolving = debtBalanceAtDate({
        debtModel: "revolving",
        anchors,
        currentBalanceMinor: 6_000_00,
        targetDate,
      });
      const informal = debtBalanceAtDate({
        debtModel: "informal",
        anchors,
        currentBalanceMinor: 6_000_00,
        targetDate,
      });
      expect(revolving).toBe(informal);
    }
  });
});

describe("debtBalanceAtDate — revolving interpolated (opt-in regression guard, ADR 0031)", () => {
  const REVOLVING: DebtBalanceAtDateInput = {
    debtModel: "revolving",
    cadence: "interpolated",
    anchors: [
      { anchorDate: "2024-01-01", balanceMinor: 10_000_00 },
      { anchorDate: "2024-12-31", balanceMinor: 0 },
    ],
    currentBalanceMinor: 0,
    targetDate: "2024-01-01",
  };

  test("interpolates linearly by days between two anchors (pre-#392 behaviour)", () => {
    // 2024 is a leap year. 2024-07-01 is 182 days after the first anchor (span 365).
    // balance = 10_000_00 × (1 − 182/365) = 501369.86… → 501370
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2024-07-01" })).toBe(501_370);
  });

  test("on anchors and outside the range it matches the step curve", () => {
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2024-01-01" })).toBe(10_000_00);
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2024-12-31" })).toBe(0);
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2020-01-01" })).toBe(10_000_00);
    expect(debtBalanceAtDate({ ...REVOLVING, targetDate: "2030-01-01" })).toBe(0);
  });

  test("three anchors: interpolates within the correct segment", () => {
    const anchors = [
      { anchorDate: "2024-01-01", balanceMinor: 10_000_00 },
      { anchorDate: "2024-07-01", balanceMinor: 6_000_00 },
      { anchorDate: "2025-01-01", balanceMinor: 6_000_00 },
    ];
    // 2024-04-01: 91 days into the 182-day first segment → 800_000.
    expect(
      debtBalanceAtDate({
        debtModel: "revolving",
        cadence: "interpolated",
        anchors,
        currentBalanceMinor: 6_000_00,
        targetDate: "2024-04-01",
      }),
    ).toBe(800_000);
    // Second segment is flat at 6_000_00.
    expect(
      debtBalanceAtDate({
        debtModel: "revolving",
        cadence: "interpolated",
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
        cadence: "interpolated",
        anchors: [
          { anchorDate: "2024-12-31", balanceMinor: 0 },
          { anchorDate: "2024-01-01", balanceMinor: 10_000_00 },
        ],
        currentBalanceMinor: 0,
        targetDate: "2024-07-01",
      }),
    ).toBe(501_370);
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

  test("a current-state re-baseline is forward-only before its baseline", () => {
    const input: DebtBalanceAtDateInput = {
      balanceRebaselines: [
        {
          annualInterestRate: "0",
          baselineDate: "2026-07-02",
          endDate: "2026-09-30",
          nextPaymentDate: "2026-08-31",
          outstandingBalanceMinor: 100_000_00,
          startsAtBaseline: true,
        },
      ],
      currentBalanceMinor: 100_000_00,
      debtModel: "amortizable",
      targetDate: "2026-07-01",
    };

    expect(debtBalanceAtDate(input)).toBe(0);
    expect(debtBalanceAtDate({ ...input, targetDate: "2026-07-02" })).toBe(100_000_00);
    expect(debtBalanceAtDate({ ...input, targetDate: "2026-08-31" })).toBe(50_000_00);
  });

  test("a re-baseline composes later revisions and early repayments on the derived plan", () => {
    const rebaseline = {
      annualInterestRate: "0.02",
      baselineDate: "2026-07-02",
      endDate: "2027-08-05",
      nextPaymentDate: "2026-08-05",
      outstandingBalanceMinor: 120_000_00,
    };
    const revisions = [{ revisionDate: "2026-11-05", newAnnualInterestRate: "0.04" }];
    const earlyRepayments = [
      { repaymentDate: "2026-12-05", amountMinor: 10_000_00, mode: "reduce-payment" },
    ] as const;
    const targetDate = "2027-03-05";

    expect(
      debtBalanceAtDate({
        balanceRebaselines: [rebaseline],
        currentBalanceMinor: 0,
        debtModel: "amortizable",
        earlyRepayments,
        plan: {
          annualInterestRate: "0.01",
          disbursementDate: "2020-01-01",
          firstPaymentDate: "2020-02-01",
          initialCapitalMinor: 200_000_00,
          termMonths: 360,
        },
        revisions,
        targetDate,
      }),
    ).toBe(
      amortizableBalanceAtDate({
        earlyRepayments,
        plan: amortizationPlanFromBalanceRebaseline(rebaseline),
        revisions,
        targetDate,
      }),
    );
  });
});

describe("effectiveAmortizationPlan — exported for recalibration (PRD #670 S3, #678)", () => {
  const PLAN = {
    annualInterestRate: "0.01",
    disbursementDate: "2020-01-01",
    firstPaymentDate: "2020-02-01",
    initialCapitalMinor: 200_000_00,
    termMonths: 360,
  };

  test("with no re-baselines, the plan itself governs from its own disbursement date", () => {
    const result = effectiveAmortizationPlan({ plan: PLAN, targetDate: "2024-01-01" });
    expect(result).toEqual({ effectiveFrom: PLAN.disbursementDate, plan: PLAN });
  });

  test("the latest re-baseline on/before the target date governs instead of the plan", () => {
    const rebaseline = {
      annualInterestRate: "0.02",
      baselineDate: "2026-07-02",
      endDate: "2027-08-05",
      nextPaymentDate: "2026-08-05",
      outstandingBalanceMinor: 120_000_00,
    };
    const result = effectiveAmortizationPlan({
      balanceRebaselines: [rebaseline],
      plan: PLAN,
      targetDate: "2026-09-01",
    });
    expect(result).toEqual({
      effectiveFrom: rebaseline.baselineDate,
      plan: amortizationPlanFromBalanceRebaseline(rebaseline),
    });
  });

  test("a target before a startsAtBaseline re-baseline reports startsAfterTarget", () => {
    const result = effectiveAmortizationPlan({
      balanceRebaselines: [
        {
          annualInterestRate: "0",
          baselineDate: "2026-07-02",
          endDate: "2026-09-30",
          nextPaymentDate: "2026-08-31",
          outstandingBalanceMinor: 100_000_00,
          startsAtBaseline: true,
        },
      ],
      targetDate: "2026-07-01",
    });
    expect(result).toEqual({ startsAfterTarget: true });
  });

  test("with neither a plan nor re-baselines, returns null", () => {
    expect(effectiveAmortizationPlan({ targetDate: "2024-01-01" })).toBeNull();
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
