import { describe, expect, test } from "vitest";

import { amortizableBalanceAtDate } from "./amortization";
import type { AmortizationPlanInput, InterestRateRevision } from "./amortization";

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
    expect(
      amortizableBalanceAtDate({ plan: zeroRate, targetDate: "2020-07-01" }),
    ).toBe(600_00);
    expect(
      amortizableBalanceAtDate({ plan: zeroRate, targetDate: "2021-01-01" }),
    ).toBe(0);
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
      amortizableBalanceAtDate({ plan, revisions: oneRevision, targetDate: "2024-01-01" }),
    ).toBe(
      amortizableBalanceAtDate({ plan, revisions: twoRevisions, targetDate: "2024-01-01" }),
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
    expect(
      amortizableBalanceAtDate({ plan, targetDate: "2020-02-29" }),
    ).toBe(265_833);
    // Intra-month interpolation must use the correct 29-day February span.
    expect(
      amortizableBalanceAtDate({ plan, targetDate: "2020-02-15" }),
    ).toBe(277_500);
  });
});
