import { describe, expect, test } from "vitest";

import { amortizableBalanceAtDate } from "./amortization";
import type {
  AmortizationPlanInput,
  EarlyRepayment,
  InterestRateRevision,
} from "./amortization";

/**
 * Pure French-amortization balance curve (PRD #109, slice 7).
 *
 * The pinned euro figures are the EXACT output of this module's formula (carried
 * at full big.js precision, rounded to the cent half up only at the edge). The
 * PRD quotes rough approximations ("~196.500€" after 12, "~183.200€" after 60);
 * the exact values below are what the cuota-francesa schedule actually produces
 * and are the source of truth for the test.
 */

const PRD_EXAMPLE: AmortizationPlanInput = {
  annualInterestRate: "0.025",
  initialCapitalMinor: 200_000_00,
  startDate: "2020-01-01",
  termMonths: 360,
};

describe("amortizableBalanceAtDate — French amortization (cuota fija)", () => {
  test("balance before the start date is the full initial capital", () => {
    expect(
      amortizableBalanceAtDate({ plan: PRD_EXAMPLE, targetDate: "2019-06-01" }),
    ).toBe(200_000_00);
    // Exactly on the start date counts as not yet amortized.
    expect(
      amortizableBalanceAtDate({ plan: PRD_EXAMPLE, targetDate: "2020-01-01" }),
    ).toBe(200_000_00);
  });

  test("balance after the final payment is zero", () => {
    // Term is 360 months from 2020-01-01 → ends 2050-01-01.
    expect(
      amortizableBalanceAtDate({ plan: PRD_EXAMPLE, targetDate: "2050-01-01" }),
    ).toBe(0);
    expect(
      amortizableBalanceAtDate({ plan: PRD_EXAMPLE, targetDate: "2060-01-01" }),
    ).toBe(0);
  });

  test("PRD example: exact balance on a payment date after 12 cuotas", () => {
    // Start of month 12 = 2021-01-01: balance at the start of that month.
    expect(
      amortizableBalanceAtDate({ plan: PRD_EXAMPLE, targetDate: "2021-01-01" }),
    ).toBe(195_465_37);
  });

  test("PRD example: exact balance on a payment date after 60 cuotas", () => {
    // Start of month 60 = 2025-01-01.
    expect(
      amortizableBalanceAtDate({ plan: PRD_EXAMPLE, targetDate: "2025-01-01" }),
    ).toBe(176_150_76);
  });

  test("intra-month interpolation: a date between two cuota dates", () => {
    // Mid-January 2021 is between the month-12 (2021-01-01) and month-13
    // (2021-02-01) boundaries; the balance is interpolated linearly by days.
    const onBoundary = amortizableBalanceAtDate({
      plan: PRD_EXAMPLE,
      targetDate: "2021-01-01",
    });
    const midMonth = amortizableBalanceAtDate({
      plan: PRD_EXAMPLE,
      targetDate: "2021-01-16",
    });
    const nextBoundary = amortizableBalanceAtDate({
      plan: PRD_EXAMPLE,
      targetDate: "2021-02-01",
    });
    // Strictly decreasing and strictly between the two boundaries.
    expect(midMonth).toBeLessThan(onBoundary);
    expect(midMonth).toBeGreaterThan(nextBoundary);
    // 2021-01 has 31 days; 2021-01-16 is 15 days in → fraction 15/31.
    expect(midMonth).toBe(195_280_04);
  });

  test("0% interest: payment is capital / n, balance falls linearly by month", () => {
    const zeroRate: AmortizationPlanInput = {
      annualInterestRate: "0",
      initialCapitalMinor: 1_200_00,
      startDate: "2020-01-01",
      termMonths: 12,
    };
    // 100€/month. After 6 months → 600€ remaining.
    expect(amortizableBalanceAtDate({ plan: zeroRate, targetDate: "2020-07-01" })).toBe(
      600_00,
    );
    expect(amortizableBalanceAtDate({ plan: zeroRate, targetDate: "2021-01-01" })).toBe(
      0,
    );
  });

  test("a single rate revision recomputes the payment from its date", () => {
    const plan: AmortizationPlanInput = {
      annualInterestRate: "0.05",
      initialCapitalMinor: 100_000_00,
      startDate: "2020-01-01",
      termMonths: 120,
    };
    const revisions: InterestRateRevision[] = [
      { newAnnualInterestRate: "0.03", revisionDate: "2022-01-01" }, // after 24 months
    ];
    // At the revision boundary (month 24 = 2022-01-01) the balance equals the
    // no-revision schedule's month-24 balance.
    const atRevision = amortizableBalanceAtDate({
      plan,
      revisions,
      targetDate: "2022-01-01",
    });
    expect(atRevision).toBe(83_780_56);
    const withoutRevision = amortizableBalanceAtDate({
      plan,
      targetDate: "2022-01-01",
    });
    expect(withoutRevision).toBe(83_780_56);

    // A lower rate from month 24 means more principal is repaid afterwards, so by
    // a later date the revised balance is below the un-revised one.
    const revisedLater = amortizableBalanceAtDate({
      plan,
      revisions,
      targetDate: "2025-01-01",
    });
    const unrevisedLater = amortizableBalanceAtDate({
      plan,
      targetDate: "2025-01-01",
    });
    expect(revisedLater).toBeLessThan(unrevisedLater);
  });

  test("multiple revisions each recompute from their own date", () => {
    const plan: AmortizationPlanInput = {
      annualInterestRate: "0.05",
      initialCapitalMinor: 100_000_00,
      startDate: "2020-01-01",
      termMonths: 120,
    };
    const oneRevision: InterestRateRevision[] = [
      { newAnnualInterestRate: "0.03", revisionDate: "2022-01-01" },
    ];
    const twoRevisions: InterestRateRevision[] = [
      { newAnnualInterestRate: "0.03", revisionDate: "2022-01-01" },
      { newAnnualInterestRate: "0.07", revisionDate: "2024-01-01" }, // back up at month 48
    ];
    // Up to the second revision date the two schedules agree.
    expect(
      amortizableBalanceAtDate({
        plan,
        revisions: oneRevision,
        targetDate: "2024-01-01",
      }),
    ).toBe(
      amortizableBalanceAtDate({
        plan,
        revisions: twoRevisions,
        targetDate: "2024-01-01",
      }),
    );
    // After the second revision (higher rate → less principal repaid) the
    // two-revision balance sits above the one-revision balance.
    const afterOne = amortizableBalanceAtDate({
      plan,
      revisions: oneRevision,
      targetDate: "2027-01-01",
    });
    const afterTwo = amortizableBalanceAtDate({
      plan,
      revisions: twoRevisions,
      targetDate: "2027-01-01",
    });
    expect(afterTwo).toBeGreaterThan(afterOne);
  });
});

describe("early repayments (amortización anticipada) — PRD #146, slice S4", () => {
  const LOAN: AmortizationPlanInput = {
    annualInterestRate: "0.03",
    initialCapitalMinor: 100_000_00,
    startDate: "2020-01-01",
    termMonths: 120,
  };

  test("a reduce-payment lump sum drops the balance on its date by the lump", () => {
    // Month 24 = 2022-01-01. The lump is applied at that boundary, so the
    // outstanding balance on the repayment date is the un-repaid balance minus
    // the lump, exactly (both share the same start-of-month balance).
    const repayments: EarlyRepayment[] = [
      { amountMinor: 20_000_00, mode: "reduce-payment", repaymentDate: "2022-01-01" },
    ];
    const withoutRepayment = amortizableBalanceAtDate({
      plan: LOAN,
      targetDate: "2022-01-01",
    });
    const withRepayment = amortizableBalanceAtDate({
      earlyRepayments: repayments,
      plan: LOAN,
      targetDate: "2022-01-01",
    });
    expect(withRepayment).toBe(withoutRepayment - 20_000_00);
  });

  test("reduce-payment keeps the term: still owing near the original end date", () => {
    // Month 119 = 2029-12-01, one month before the 120-month loan ends.
    // reduce-payment lowers the cuota and keeps the end date, so the loan is
    // NOT paid off early — there is still a balance just before the term.
    const balanceNearEnd = amortizableBalanceAtDate({
      earlyRepayments: [
        { amountMinor: 20_000_00, mode: "reduce-payment", repaymentDate: "2022-01-01" },
      ],
      plan: LOAN,
      targetDate: "2029-12-01",
    });
    expect(balanceNearEnd).toBeGreaterThan(0);
  });

  test("reduce-term keeps the cuota: same balance on the date, paid off early", () => {
    const onDate = (mode: "reduce-payment" | "reduce-term", targetDate: string) =>
      amortizableBalanceAtDate({
        earlyRepayments: [{ amountMinor: 20_000_00, mode, repaymentDate: "2022-01-01" }],
        plan: LOAN,
        targetDate,
      });

    // On the repayment date the lump applies identically; only the forward
    // schedule differs by mode, so both balances coincide there.
    expect(onDate("reduce-term", "2022-01-01")).toBe(
      onDate("reduce-payment", "2022-01-01"),
    );
    // Holding the cuota retires principal faster, so by a later date the
    // reduce-term balance sits below the reduce-payment one …
    expect(onDate("reduce-term", "2025-01-01")).toBeLessThan(
      onDate("reduce-payment", "2025-01-01"),
    );
    // … and the loan is fully repaid before the original term (0 near the end,
    // where reduce-payment is still positive).
    expect(onDate("reduce-term", "2029-12-01")).toBe(0);
  });

  test("a total repayment (lump ≥ balance) closes the loan from its date on", () => {
    const repayments: EarlyRepayment[] = [
      { amountMinor: 100_000_00, mode: "reduce-payment", repaymentDate: "2022-01-01" },
    ];
    // Still owing on the cuota date just before the repayment …
    expect(
      amortizableBalanceAtDate({
        earlyRepayments: repayments,
        plan: LOAN,
        targetDate: "2021-12-01",
      }),
    ).toBeGreaterThan(0);
    // … zero on the repayment date and every date after it.
    expect(
      amortizableBalanceAtDate({
        earlyRepayments: repayments,
        plan: LOAN,
        targetDate: "2022-01-01",
      }),
    ).toBe(0);
    expect(
      amortizableBalanceAtDate({
        earlyRepayments: repayments,
        plan: LOAN,
        targetDate: "2025-06-01",
      }),
    ).toBe(0);
  });

  test("a repayment combines with a rate revision on the same loan", () => {
    const revisions: InterestRateRevision[] = [
      { newAnnualInterestRate: "0.05", revisionDate: "2021-01-01" }, // month 12
    ];
    const repayments: EarlyRepayment[] = [
      { amountMinor: 20_000_00, mode: "reduce-payment", repaymentDate: "2022-01-01" }, // month 24
    ];
    const withRevisionOnly = amortizableBalanceAtDate({
      plan: LOAN,
      revisions,
      targetDate: "2022-01-01",
    });
    const withBoth = amortizableBalanceAtDate({
      earlyRepayments: repayments,
      plan: LOAN,
      revisions,
      targetDate: "2022-01-01",
    });
    // The lump still drops the (revised-rate) balance by exactly the lump.
    expect(withBoth).toBe(withRevisionOnly - 20_000_00);
  });

  test("a repayment has no effect on dates before it (past or future lump)", () => {
    const baseline = amortizableBalanceAtDate({ plan: LOAN, targetDate: "2021-01-01" });
    // A repayment dated AFTER the target leaves the earlier balance untouched.
    const beforeFutureLump = amortizableBalanceAtDate({
      earlyRepayments: [
        { amountMinor: 20_000_00, mode: "reduce-term", repaymentDate: "2022-01-01" },
      ],
      plan: LOAN,
      targetDate: "2021-01-01",
    });
    expect(beforeFutureLump).toBe(baseline);
  });
});

describe("addMonths day-clamping — end-of-month start dates", () => {
  test("intra-month interpolation uses the real calendar span, not a rolled date", () => {
    // startDate = 2020-01-31. Month 1 boundary is 2020-02-29 (leap year, clamped),
    // so that month has 29 days, not 31. A target of 2020-02-15 is 15 days in.
    //
    // 0% loan: payment = capital / n, balance falls linearly. With capital =
    // 2_900_00 cents and 12 months, each month retires 2_900_00/12 cents of
    // principal.
    //
    // Month 0 runs from 2020-01-31 to 2020-02-29 (clamped — leap year).
    //   boundaries[0] = 2_900_00  (balance at startDate, before any payment)
    //   boundaries[1] = 2_900_00 − 2_900_00/12 = 265_833 cents
    //
    // On 2020-02-15 (15 days into month 0, span=29 days):
    //   interpolated = 2_900_00 − (2_900_00/12) × (15/29) = 277_500 cents (half-up)
    //
    // The buggy addMonths produced "2020-02-31", which JS rolls to 2020-03-02,
    // giving span=31 instead of 29 → wrong interpolated result of 278_306 cents,
    // and also shifted the month-locator so 2020-02-29 fell in month 0.
    const plan: AmortizationPlanInput = {
      annualInterestRate: "0",
      initialCapitalMinor: 2_900_00,
      startDate: "2020-01-31",
      termMonths: 12,
    };
    // On 2020-02-29 the locator places us in month 1 (offset=0 from monthStart),
    // so the result is boundaries[1] = 265_833 (after month-0's payment).
    expect(amortizableBalanceAtDate({ plan, targetDate: "2020-02-29" })).toBe(265_833);
    // Intra-month interpolation must use the correct 29-day February span.
    expect(amortizableBalanceAtDate({ plan, targetDate: "2020-02-15" })).toBe(277_500);
  });
});

/**
 * Regression for #158. The historical-snapshot ripple values an amortizable
 * liability at one date per past payment boundary (per scope) — dozens to
 * hundreds of calls with the SAME loan terms but different `targetDate`s. We
 * memoise the date-independent month-boundary curve so this is O(termMonths +
 * dates) instead of O(dates × termMonths) of big.js work (a ~30s plan save that
 * tripped the dev server's server-action timeout → the page appeared stuck).
 *
 * These tests pin the memo's correctness: caching must NEVER change a result,
 * and the cache key must distinguish loans that differ only in their revisions
 * or early repayments — even when those queries are interleaved by date.
 */
describe("amortizableBalanceAtDate — boundary memo (#158)", () => {
  test("repeated and interleaved date queries are byte-identical to single ones", () => {
    const dates = [
      "2020-06-15",
      "2021-01-01",
      "2025-01-01",
      "2021-01-16",
      "2025-01-01", // a repeat, to exercise the cache hit path
      "2049-12-01",
    ];

    // Reference values computed fresh (first call per date primes the cache).
    const reference = dates.map((targetDate) =>
      amortizableBalanceAtDate({ plan: PRD_EXAMPLE, targetDate }),
    );

    // A second sweep (now served from the cached curve) must match exactly.
    for (let i = 0; i < dates.length; i += 1) {
      expect(amortizableBalanceAtDate({ plan: PRD_EXAMPLE, targetDate: dates[i]! })).toBe(
        reference[i]!,
      );
    }
  });

  test("a revision changes the curve even when interleaved with the unrevised loan", () => {
    const revisions: InterestRateRevision[] = [
      { revisionDate: "2022-01-01", newAnnualInterestRate: "0.05" },
    ];
    const targetDate = "2025-01-01";

    // Prime the cache with the unrevised loan, then query the revised one, then
    // the unrevised one again — the memo must key on the revisions, not reuse
    // the wrong curve for a different loan.
    const unrevised = amortizableBalanceAtDate({ plan: PRD_EXAMPLE, targetDate });
    const revised = amortizableBalanceAtDate({
      plan: PRD_EXAMPLE,
      revisions,
      targetDate,
    });
    const unrevisedAgain = amortizableBalanceAtDate({ plan: PRD_EXAMPLE, targetDate });

    expect(revised).not.toBe(unrevised); // a higher rate leaves a higher balance
    expect(revised).toBeGreaterThan(unrevised);
    expect(unrevisedAgain).toBe(unrevised); // cache must not have been polluted
  });

  test("an early repayment changes the curve even when interleaved", () => {
    const earlyRepayments: EarlyRepayment[] = [
      { repaymentDate: "2021-06-01", amountMinor: 20_000_00, mode: "reduce-term" },
    ];
    const targetDate = "2025-01-01";

    const withoutLump = amortizableBalanceAtDate({ plan: PRD_EXAMPLE, targetDate });
    const withLump = amortizableBalanceAtDate({
      plan: PRD_EXAMPLE,
      earlyRepayments,
      targetDate,
    });
    const withoutLumpAgain = amortizableBalanceAtDate({ plan: PRD_EXAMPLE, targetDate });

    expect(withLump).toBeLessThan(withoutLump); // a lump leaves a lower balance
    expect(withoutLumpAgain).toBe(withoutLump); // cache must not have been polluted
  });
});
