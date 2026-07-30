import { describe, expect, test } from "vitest";

import type {
  AmortizationPlanInput,
  EarlyRepayment,
  InterestRateRevision,
} from "./amortization";
import { amortizableBalanceAtDate } from "./amortization";
import { accruedInterestAtDate } from "./debt-accrual";

/**
 * A round plan so every figure below is checkable by hand: 12.000 € at 12 %
 * annual over 12 months, disbursed 2026-01-01 with the first cuota 2026-02-01.
 * The monthly rate is exactly 1 %, so the first period's interest is 120,00 €
 * over a 31-day cycle.
 */
const ROUND: AmortizationPlanInput = {
  annualInterestRate: "0.12",
  disbursementDate: "2026-01-01",
  firstPaymentDate: "2026-02-01",
  initialCapitalMinor: 12_000_00,
  termMonths: 12,
};

describe("accruedInterestAtDate: principal vs the bank's settlement figure (#1292)", () => {
  test("prorates the running cycle's interest by elapsed days", () => {
    // 2026-01-16 is 15 days into the 31-day stub: 120,00 × 15/31 = 58,06 €.
    const accrual = accruedInterestAtDate({ plan: ROUND, targetDate: "2026-01-16" });

    expect(accrual).not.toBeNull();
    expect(accrual!.accruedInterestMinor).toBe(58_06);
    expect(accrual!.cycleStartDate).toBe("2026-01-01");
    expect(accrual!.cycleEndDate).toBe("2026-02-01");
    expect(accrual!.elapsedDays).toBe(15);
    expect(accrual!.cycleDays).toBe(31);
    expect(accrual!.annualInterestRate).toBe("0.12");
  });

  test("the settlement estimate is the principal curve plus the accrual, never a second curve", () => {
    const targetDate = "2026-04-20";
    const accrual = accruedInterestAtDate({ plan: ROUND, targetDate })!;

    // The principal is byte-identical to the figure the rest of the app paints,
    // so the two readings can never drift into being two different balances.
    expect(accrual.principalMinor).toBe(
      amortizableBalanceAtDate({ plan: ROUND, targetDate }),
    );
    expect(accrual.settlementEstimateMinor).toBe(
      accrual.principalMinor + accrual.accruedInterestMinor,
    );
  });

  test("on a cuota date the interest has just been paid, so nothing has accrued yet", () => {
    for (const cuotaDate of ["2026-02-01", "2026-03-01", "2026-11-01"]) {
      const accrual = accruedInterestAtDate({ plan: ROUND, targetDate: cuotaDate })!;
      expect(accrual.accruedInterestMinor).toBe(0);
      expect(accrual.elapsedDays).toBe(0);
      expect(accrual.settlementEstimateMinor).toBe(accrual.principalMinor);
      // The cycle reported is the one that STARTS on the cuota, not the one it closed.
      expect(accrual.cycleStartDate).toBe(cuotaDate);
    }
  });

  test("no cycle is running before the money is disbursed, or after the debt is repaid", () => {
    expect(accruedInterestAtDate({ plan: ROUND, targetDate: "2025-12-31" })).toBeNull();
    // The 12th cuota (2027-01-01) closes the loan: there is no running cycle on or
    // after it, and no interest to accrue on a balance of zero.
    expect(accruedInterestAtDate({ plan: ROUND, targetDate: "2027-01-01" })).toBeNull();
    expect(accruedInterestAtDate({ plan: ROUND, targetDate: "2027-06-01" })).toBeNull();
  });

  test("a rate revision hands the running cycle its own rate", () => {
    const revisions: InterestRateRevision[] = [
      { newAnnualInterestRate: "0.24", revisionDate: "2026-05-01" },
    ];
    const accrual = accruedInterestAtDate({
      plan: ROUND,
      revisions,
      targetDate: "2026-05-16",
    })!;

    expect(accrual.annualInterestRate).toBe("0.24");
    // Doubling the rate doubles the accrual of the cycle it governs.
    const atOldRate = accruedInterestAtDate({ plan: ROUND, targetDate: "2026-05-16" })!;
    expect(accrual.accruedInterestMinor).toBeGreaterThan(
      atOldRate.accruedInterestMinor * 1.9,
    );
  });

  test("the real case: the gap the user sees against the bank is the accrual (#1292)", () => {
    // `Préstamos Revolut` (workspace de Jose): 6.000 € at 5,89 % over 42 months,
    // disbursed 2026-05-08, first cuota 2026-06-08, with a 154,34 € reduce-plazo
    // lump on 2026-07-03 — the same fixture the dating fix uses (#1291).
    const plan: AmortizationPlanInput = {
      annualInterestRate: "0.0589",
      disbursementDate: "2026-05-08",
      firstPaymentDate: "2026-06-08",
      initialCapitalMinor: 6_000_00,
      termMonths: 42,
    };
    const earlyRepayments: EarlyRepayment[] = [
      { amountMinor: 154_34, mode: "reduce-term", repaymentDate: "2026-07-03" },
    ];
    const targetDate = "2026-07-27";
    const accrual = accruedInterestAtDate({ earlyRepayments, plan, targetDate })!;

    // Worthline's figure is the principal; the bank quotes principal + accrual,
    // and the difference is a fraction of a cuota — not a modelling error.
    expect(accrual.principalMinor).toBe(
      amortizableBalanceAtDate({ earlyRepayments, plan, targetDate }),
    );
    expect(accrual.settlementEstimateMinor).toBeGreaterThan(accrual.principalMinor);
    // The July cycle accrues 5.586,30 × 0,0589/12 = 27,42 € over 31 days; 19 of
    // them have run by the 27th → 16,81 €. Same order as the 17,87 € the user
    // read on the bank's screen, whose loan carries a few more months of history:
    // a fraction of one cuota, not a modelling error.
    expect(accrual.accruedInterestMinor).toBe(16_81);
    // 19 of the 31 days of the 2026-07-08 → 2026-08-08 cycle.
    expect(accrual.cycleStartDate).toBe("2026-07-08");
    expect(accrual.elapsedDays).toBe(19);
  });

  test("a lump paid inside the running cycle lowers the accrual with the principal", () => {
    const lump: EarlyRepayment = {
      amountMinor: 2_000_00,
      mode: "reduce-term",
      repaymentDate: "2026-04-10",
    };
    const targetDate = "2026-04-20";
    const withLump = accruedInterestAtDate({
      earlyRepayments: [lump],
      plan: ROUND,
      targetDate,
    })!;
    const without = accruedInterestAtDate({ plan: ROUND, targetDate })!;

    expect(withLump.principalMinor).toBeLessThan(without.principalMinor);
    // The accrual rides the period's interest, which the engine accrues on the
    // post-lump opening balance for the WHOLE cycle (#1291) — an approximation
    // that favours the user by cents, inherited here on purpose rather than
    // re-derived with a second, divergent arithmetic.
    expect(withLump.accruedInterestMinor).toBeLessThan(without.accruedInterestMinor);
  });

  test("a zero-rate plan accrues nothing, and the settlement figure is the principal", () => {
    const free: AmortizationPlanInput = { ...ROUND, annualInterestRate: "0" };
    const accrual = accruedInterestAtDate({ plan: free, targetDate: "2026-03-15" })!;

    expect(accrual.accruedInterestMinor).toBe(0);
    expect(accrual.settlementEstimateMinor).toBe(accrual.principalMinor);
  });
});
