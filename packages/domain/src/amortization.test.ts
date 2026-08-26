import { describe, expect, test } from "vitest";
import type {
  AmortizableBalanceAtDateInput,
  AmortizationPlanInput,
  EarlyRepayment,
  InterestRateRevision,
} from "./amortization";
import {
  amortizableBalanceAtDate,
  amortizationScheduleTrace,
  assertEventWithinTerm,
  deriveCurrentStateAmortizationPlan,
  eventBoundaryDate,
  firstCuota,
  remainingMonthlyPayments,
  suggestFirstPaymentDate,
} from "./amortization";
import type { ValuationCadence } from "./valuation-cadence";

/**
 * Pure French-amortization balance curve (PRD #109, slice 7).
 *
 * The pinned euro figures are the EXACT output of this module's formula (carried
 * at full big.js precision, rounded to the cent half up only at the edge). The
 * PRD quotes rough approximations ("~196.500€" after 12, "~183.200€" after 60);
 * the exact values below are what the cuota-francesa schedule actually produces
 * and are the source of truth for the test.
 */

// Migrated to the two-date model (ADR 0019): the old single `start_date:
// "2020-01-01"` becomes disbursement = start and firstPayment = start + 1 month —
// the migration's backfill, which reproduces the old single-date curve exactly on
// every old payment-boundary date addMonths(start, m). Every pinned figure below
// is therefore byte-identical to the pre-#188 engine.
const PRD_EXAMPLE: AmortizationPlanInput = {
  annualInterestRate: "0.025",
  initialCapitalMinor: 200_000_00,
  disbursementDate: "2020-01-01",
  firstPaymentDate: "2020-02-01",
  termMonths: 360,
};

/**
 * Two-date model (ADR 0019, #188). A plan carries a DISBURSEMENT date (firma —
 * the debt appears at its initial capital and interest begins to accrue) and a
 * FIRST-PAYMENT date (the first cuota; the balance amortizes from here, on this
 * date's day-of-month, with the term counted from here). Between the two the
 * balance is FLAT at the initial capital; the stub interest only enlarges the
 * displayed first cuota and never moves the balance.
 */
describe("two-date model — disbursement + first payment (ADR 0019, #188)", () => {
  // Mid-month firma, first payment on a later 1st-of-month (a >1-month stub —
  // the ING shape). 200.000€, 3% annual, 240 months.
  const BANK_PLAN: AmortizationPlanInput = {
    annualInterestRate: "0.03",
    initialCapitalMinor: 200_000_00,
    disbursementDate: "2020-01-15",
    firstPaymentDate: "2020-03-01",
    termMonths: 240,
  };

  test("balance is flat at the initial capital between disbursement and first payment", () => {
    // Before the firma → full capital (the debt does not yet exist).
    expect(amortizableBalanceAtDate({ plan: BANK_PLAN, targetDate: "2019-12-31" })).toBe(
      200_000_00,
    );
    // On the firma → full capital.
    expect(amortizableBalanceAtDate({ plan: BANK_PLAN, targetDate: "2020-01-15" })).toBe(
      200_000_00,
    );
    // Mid-stub (after the firma, before the first payment) → still flat at the
    // full capital, NOT amortizing. The stub interest is cosmetic for balances.
    expect(amortizableBalanceAtDate({ plan: BANK_PLAN, targetDate: "2020-02-10" })).toBe(
      200_000_00,
    );
    // The day before the first payment is still flat.
    expect(amortizableBalanceAtDate({ plan: BANK_PLAN, targetDate: "2020-02-29" })).toBe(
      200_000_00,
    );
  });

  test("amortizes from the first payment on its day-of-month", () => {
    // The first cuota lands ON the first-payment date: the balance there is the
    // initial capital less the first ordinary French principal.
    expect(amortizableBalanceAtDate({ plan: BANK_PLAN, targetDate: "2020-03-01" })).toBe(
      199_390_80,
    );
    // Subsequent payments fall on the first-payment day-of-month (the 1st).
    expect(amortizableBalanceAtDate({ plan: BANK_PLAN, targetDate: "2020-04-01" })).toBe(
      198_780_09,
    );
  });

  test("the term counts payments from the first payment (regression to the cent)", () => {
    // The 13th payment (firstPayment + 12 months = 2021-03-01).
    expect(amortizableBalanceAtDate({ plan: BANK_PLAN, targetDate: "2021-03-01" })).toBe(
      191_960_57,
    );
    // The 61st payment (firstPayment + 60 months = 2025-03-01).
    expect(amortizableBalanceAtDate({ plan: BANK_PLAN, targetDate: "2025-03-01" })).toBe(
      159_909_88,
    );
    // One cuota before the end: payment 240 lands on firstPayment + 239 months =
    // 2040-02-01, so on 2040-01-01 the final principal is still owed.
    expect(amortizableBalanceAtDate({ plan: BANK_PLAN, targetDate: "2040-01-01" })).toBe(
      1_106_43,
    );
    // The loan is fully repaid on the last payment (firstPayment + 239 months).
    expect(amortizableBalanceAtDate({ plan: BANK_PLAN, targetDate: "2040-02-01" })).toBe(
      0,
    );
    expect(amortizableBalanceAtDate({ plan: BANK_PLAN, targetDate: "2050-01-01" })).toBe(
      0,
    );
  });

  test("backfill (firstPayment = disbursement + 1 month) reproduces the single-date curve to the cent", () => {
    // The migration backfills disbursement = old start_date and firstPayment =
    // start_date + 1 month. With that mapping every old payment boundary date —
    // addMonths(start, m) — is a boundary of the new schedule, and the new curve
    // must equal the old single-date curve on those dates to the cent.
    const backfilled: AmortizationPlanInput = {
      annualInterestRate: "0.025",
      initialCapitalMinor: 200_000_00,
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 360,
    };
    // The historical single-date pins (the old engine's exact output) survive:
    //   start date itself → initial capital
    expect(amortizableBalanceAtDate({ plan: backfilled, targetDate: "2020-01-01" })).toBe(
      200_000_00,
    );
    //   12 boundaries later (2021-01-01) and 60 later (2025-01-01).
    expect(amortizableBalanceAtDate({ plan: backfilled, targetDate: "2021-01-01" })).toBe(
      195_465_37,
    );
    expect(amortizableBalanceAtDate({ plan: backfilled, targetDate: "2025-01-01" })).toBe(
      176_150_76,
    );
  });
});

/**
 * The exact FIRST CUOTA (ADR 0019, #190). The opening period runs from the
 * disbursement to the first payment and is LONGER than one month, so the first
 * cuota carries the stub interest for that period plus that period's ordinary
 * French principal:
 *   stub interest = capital × annual rate × days(disbursement → first payment) / 360
 *   first cuota   = stub interest + first ordinary French principal
 * This is DISPLAY ONLY — it never moves the balance curve (the principal the
 * first payment amortizes is the ordinary French principal; the stub only
 * enlarges the displayed cuota).
 */
describe("firstCuota — exact first payment with stub interest (ADR 0019, #190)", () => {
  // Mid-month firma, first payment on a later 1st-of-month: a 46-day stub.
  // 200.000€, 3% annual, 240 months.
  const BANK_PLAN: AmortizationPlanInput = {
    annualInterestRate: "0.03",
    initialCapitalMinor: 200_000_00,
    disbursementDate: "2020-01-15",
    firstPaymentDate: "2020-03-01",
    termMonths: 240,
  };

  test("computes the stub interest from the day count, to the cent", () => {
    // days(2020-01-15 → 2020-03-01) = 46. stub = 200000_00 × 0.03 × 46/360 =
    // 766,6666…€ → 766,67€ (76667 cents, half up at the edge).
    expect(firstCuota(BANK_PLAN).stubInterestMinor).toBe(76_667);
  });

  test("the first-period principal is the ordinary French principal", () => {
    // cuota = 1.109,1951…€; interest of the first ordinary month = 200000 × i =
    // 500,00€; principal = 609,1951…€ → 609,20€ (60920 cents). This matches the
    // balance the engine reports after the first payment (200000_00 − 60920 =
    // 199_390_80), so the stub never changes the curve.
    expect(firstCuota(BANK_PLAN).firstPrincipalMinor).toBe(60_920);
    expect(amortizableBalanceAtDate({ plan: BANK_PLAN, targetDate: "2020-03-01" })).toBe(
      200_000_00 - 60_920,
    );
  });

  test("the first cuota is stub interest + first-period principal (single edge round)", () => {
    // 766,6666…€ + 609,1951…€ = 1.375,8618…€ → 1.375,86€ (137586 cents), rounded
    // once at the edge (not the sum of the two separately-rounded parts).
    expect(firstCuota(BANK_PLAN).amountMinor).toBe(137_586);
    // It is strictly larger than the regular cuota (1.109,20€) because the stub
    // period is longer than a month.
    expect(firstCuota(BANK_PLAN).amountMinor).toBeGreaterThan(
      firstCuota(BANK_PLAN).regularCuotaMinor,
    );
    expect(firstCuota(BANK_PLAN).regularCuotaMinor).toBe(110_920);
  });

  test("a calendar-month stub charges that month's exact day-count interest", () => {
    // disbursement = firstPayment − 1 month → 31 days (Jan). The 360-day
    // convention bills 31/360, slightly above a 30/360 month, so the first cuota
    // sits just above the regular cuota: stub = 200000_00 × 0.03 × 31/360 =
    // 516,67€; + 609,20€ principal = 1.125,86€ (137586 vs the regular 1.109,20€).
    const monthlyStub: AmortizationPlanInput = {
      annualInterestRate: "0.03",
      initialCapitalMinor: 200_000_00,
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      termMonths: 240,
    };
    const result = firstCuota(monthlyStub);
    expect(result.stubInterestMinor).toBe(51_667);
    expect(result.amountMinor).toBe(112_586);
    expect(result.amountMinor).toBeGreaterThan(result.regularCuotaMinor);
  });

  test("0% loan: the first cuota carries no stub interest, only principal", () => {
    const zeroRate: AmortizationPlanInput = {
      annualInterestRate: "0",
      initialCapitalMinor: 1_200_00,
      disbursementDate: "2020-01-15",
      firstPaymentDate: "2020-03-01",
      termMonths: 12,
    };
    const result = firstCuota(zeroRate);
    expect(result.stubInterestMinor).toBe(0);
    // payment = capital / n = 100,00€; with no interest the principal is the whole
    // cuota, and the first cuota equals the regular cuota.
    expect(result.firstPrincipalMinor).toBe(100_00);
    expect(result.amountMinor).toBe(100_00);
    expect(result.amountMinor).toBe(result.regularCuotaMinor);
  });
});

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

  test("step (default): balance between two cuotas is flat at the last cuota", () => {
    // Mid-January 2021 is between the month-12 (2021-01-01) and month-13
    // (2021-02-01) boundaries. Under the default `step` cadence (ADR 0031, #390)
    // the balance holds the 2021-01-01 cuota's value flat until 2021-02-01, then
    // drops only on the cuota day.
    const onBoundary = amortizableBalanceAtDate({
      plan: PRD_EXAMPLE,
      targetDate: "2021-01-01",
    });
    const midMonth = amortizableBalanceAtDate({
      plan: PRD_EXAMPLE,
      targetDate: "2021-01-16",
    });
    const dayBeforeNext = amortizableBalanceAtDate({
      plan: PRD_EXAMPLE,
      targetDate: "2021-01-31",
    });
    const nextBoundary = amortizableBalanceAtDate({
      plan: PRD_EXAMPLE,
      targetDate: "2021-02-01",
    });
    expect(midMonth).toBe(onBoundary);
    expect(dayBeforeNext).toBe(onBoundary);
    expect(nextBoundary).toBeLessThan(onBoundary);
  });

  test("interpolated cadence reproduces the prior prorated curve (regression guard)", () => {
    // The pre-#390 behaviour, now a per-holding opt-in: interpolated linearly by
    // calendar days between the same two cuota boundaries.
    const onBoundary = amortizableBalanceAtDate({
      plan: PRD_EXAMPLE,
      targetDate: "2021-01-01",
      cadence: "interpolated",
    });
    const midMonth = amortizableBalanceAtDate({
      plan: PRD_EXAMPLE,
      targetDate: "2021-01-16",
      cadence: "interpolated",
    });
    const nextBoundary = amortizableBalanceAtDate({
      plan: PRD_EXAMPLE,
      targetDate: "2021-02-01",
      cadence: "interpolated",
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
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
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
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
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
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
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
    disbursementDate: "2020-01-01",
    firstPaymentDate: "2020-02-01",
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

/**
 * Regression for #182, preserved over the two-date model (ADR 0019, #188). The
 * schedule pins a dated event (early repayment or rate revision) to a payment
 * boundary, and the balance locator pins a query date to a boundary. These two
 * mappings must AGREE: an event placed on boundary `m` is the boundary the same
 * date resolves to when queried — the largest `m` with `boundaryDate(m) ≤
 * eventDate` (the cycle the event actually falls in). The payment cadence now
 * runs from the FIRST-PAYMENT date, so the clamping anchor is the first-payment
 * day-of-month rather than the old single start date.
 *
 * The two disagreed when the event/target day-of-month precedes the cadence-anchor
 * day, because the old event pin floored a partial month (`monthsBetween`'s
 * `if (toDay < fromDay) months -= 1`) while the locator preserves the day via
 * `addMonths` + clamping. A non-day-1 first payment whose day clamps on the
 * destination month (here a day-31 first payment, so Feb clamps to the 28th —
 * event day 28 < anchor day 31) lands an event one cycle EARLIER under the floor
 * than the locator resolves it to: a lump declared on D appeared partly amortized
 * away when valued on D, instead of the balance ON the boundary date reflecting it.
 *
 * Each case values the balance on the boundary the event date resolves to, where
 * the on-date drop must equal the declared lump within a single edge-rounding
 * cent (the acceptance criterion). The boundary D resolves to is
 * `addMonths(firstPayment, m − 1)`; for a day-31 first payment that is 2021-02-28
 * for the Feb cycle.
 */
describe("event month-mapping when the event day precedes the first-payment day (#182)", () => {
  // Day-31 first payment (disbursement a month earlier, so the cadence anchor is
  // the day-31 first payment): addMonths(2020-01-31, 13) = 2021-02-28 (clamped,
  // leap-aware → 28 in 2021). The old floor mapped 2021-02-28 one cycle earlier
  // than the locator → the divergence under test, now on the first-payment anchor.
  const CLAMPING_LOAN: AmortizationPlanInput = {
    annualInterestRate: "0.03",
    initialCapitalMinor: 100_000_00,
    disbursementDate: "2019-12-31",
    firstPaymentDate: "2020-01-31",
    termMonths: 120,
  };
  // The boundary the Feb-cycle event resolves to under the locator.
  const RESOLVED_BOUNDARY = "2021-02-28";
  // An event date inside the resolved cycle, whose day (28) precedes the
  // first-payment day (31): the locator maps it to the Feb-2021 cycle, the old
  // floor mapped it one cycle earlier.
  const EVENT_DATE = "2021-02-28";

  test("reproduction: a lump whose day precedes the start day drops the on-date balance by exactly the lump", () => {
    const repayments: EarlyRepayment[] = [
      { amountMinor: 20_000_00, mode: "reduce-payment", repaymentDate: EVENT_DATE },
    ];
    const withoutRepayment = amortizableBalanceAtDate({
      plan: CLAMPING_LOAN,
      targetDate: RESOLVED_BOUNDARY,
    });
    const withRepayment = amortizableBalanceAtDate({
      earlyRepayments: repayments,
      plan: CLAMPING_LOAN,
      targetDate: RESOLVED_BOUNDARY,
    });
    const drop = withoutRepayment - withRepayment;
    // Within a single edge-rounding cent of the declared lump.
    expect(Math.abs(drop - 20_000_00)).toBeLessThanOrEqual(1);
  });

  for (const mode of ["reduce-payment", "reduce-term"] as const) {
    test(`early repayment whose day precedes the start day drops the on-date balance by the lump (${mode})`, () => {
      const repayments: EarlyRepayment[] = [
        { amountMinor: 15_000_00, mode, repaymentDate: EVENT_DATE },
      ];
      const withoutRepayment = amortizableBalanceAtDate({
        plan: CLAMPING_LOAN,
        targetDate: RESOLVED_BOUNDARY,
      });
      const withRepayment = amortizableBalanceAtDate({
        earlyRepayments: repayments,
        plan: CLAMPING_LOAN,
        targetDate: RESOLVED_BOUNDARY,
      });
      expect(Math.abs(withoutRepayment - withRepayment - 15_000_00)).toBeLessThanOrEqual(
        1,
      );
    });

    test(`rate revision whose day precedes the start day takes effect on its resolved boundary (${mode})`, () => {
      // The revision resolves to month 13 (boundary 2021-02-28). One cycle BEFORE
      // that boundary (month 12 = 2021-01-31) the revised and un-revised curves
      // must still coincide — the revision is not yet in effect there. The old
      // floor placed the revision at month 12, which would have diverged here.
      const revisions: InterestRateRevision[] = [
        { newAnnualInterestRate: "0.06", revisionDate: EVENT_DATE },
      ];
      const priorBoundary = "2021-01-31"; // month 12 start (before the revision)
      expect(
        amortizableBalanceAtDate({
          plan: CLAMPING_LOAN,
          revisions,
          targetDate: priorBoundary,
        }),
      ).toBe(
        amortizableBalanceAtDate({ plan: CLAMPING_LOAN, targetDate: priorBoundary }),
      );

      // From the resolved boundary on, the higher rate leaves a higher balance
      // than the un-revised loan at a later date.
      const later = "2025-02-28";
      expect(
        amortizableBalanceAtDate({ plan: CLAMPING_LOAN, revisions, targetDate: later }),
      ).toBeGreaterThan(
        amortizableBalanceAtDate({ plan: CLAMPING_LOAN, targetDate: later }),
      );

      // The lump on the same loan + revision still drops the on-date balance by
      // the lump on its resolved boundary (matrix symmetry across both modes).
      const repayments: EarlyRepayment[] = [
        { amountMinor: 10_000_00, mode, repaymentDate: EVENT_DATE },
      ];
      const withoutLump = amortizableBalanceAtDate({
        plan: CLAMPING_LOAN,
        revisions,
        targetDate: RESOLVED_BOUNDARY,
      });
      const withLump = amortizableBalanceAtDate({
        earlyRepayments: repayments,
        plan: CLAMPING_LOAN,
        revisions,
        targetDate: RESOLVED_BOUNDARY,
      });
      expect(Math.abs(withoutLump - withLump - 10_000_00)).toBeLessThanOrEqual(1);
    });
  }
});

describe("eventBoundaryDate — ripple from-date shares the curve's bucketing (#1042)", () => {
  // Cuota on day 8; a mid-cycle event falls after one boundary and before the
  // next, exactly the window the ripple used to leave stale.
  const DAY8_LOAN: AmortizationPlanInput = {
    annualInterestRate: "0.03",
    initialCapitalMinor: 100_000_00,
    disbursementDate: "2020-01-08",
    firstPaymentDate: "2020-02-08",
    termMonths: 120,
  };
  const CYCLE_BOUNDARY = "2022-02-08"; // the cuota starting the cycle the event lands in
  const NEXT_BOUNDARY = "2022-03-08"; // the following cuota
  const EVENT_DATE = "2022-03-03"; // mid-cycle: after CYCLE_BOUNDARY, before NEXT_BOUNDARY

  test("a mid-cycle event anchors to the start of its cuota cycle", () => {
    expect(eventBoundaryDate(DAY8_LOAN, EVENT_DATE)).toBe(CYCLE_BOUNDARY);
  });

  /**
   * The from-date stays at the CYCLE BOUNDARY even though the step-cadence curve
   * no longer moves before the repayment date (#1291): under `interpolated` the
   * whole cycle is redrawn (its upper anchor is the new post-lump closing), so the
   * boundary is the earliest date any cadence can shift. Rippling from there is a
   * superset — the step-cadence dates in [boundary, eventDate) re-derive the exact
   * same value they already hold.
   */
  test("the helper agrees with the curve: [boundary, eventDate) is untouched, the drop lands on the event date", () => {
    const lump = 20_000_00;
    const repayments: EarlyRepayment[] = [
      { amountMinor: lump, mode: "reduce-payment", repaymentDate: EVENT_DATE },
    ];
    const boundary = eventBoundaryDate(DAY8_LOAN, EVENT_DATE);
    const balanceAt = (targetDate: string, withLump: boolean) =>
      amortizableBalanceAtDate(
        withLump
          ? { earlyRepayments: repayments, plan: DAY8_LOAN, targetDate }
          : { plan: DAY8_LOAN, targetDate },
      );

    // Every date from the cycle's cuota up to (not including) the repayment keeps
    // the balance the previous cuota closed at: the lump has not been paid yet.
    for (const dateBeforeLump of [boundary, "2022-02-20", "2022-03-02"]) {
      expect(balanceAt(dateBeforeLump, true)).toBe(balanceAt(boundary, false));
    }
    // On the repayment date the balance steps down by exactly the lump …
    expect(balanceAt(boundary, false) - balanceAt(EVENT_DATE, true)).toBe(lump);
    // … and stays there through the rest of the cycle (step-by-default).
    expect(balanceAt("2022-03-07", true)).toBe(balanceAt(EVENT_DATE, true));
  });

  test("an event on a boundary anchors to that boundary itself", () => {
    expect(eventBoundaryDate(DAY8_LOAN, CYCLE_BOUNDARY)).toBe(CYCLE_BOUNDARY);
    expect(eventBoundaryDate(DAY8_LOAN, NEXT_BOUNDARY)).toBe(NEXT_BOUNDARY);
  });

  test("an event on or before the first payment floors at boundary 0 (the disbursement)", () => {
    // Between disbursement and first payment, and on the disbursement itself.
    expect(eventBoundaryDate(DAY8_LOAN, "2020-01-20")).toBe(DAY8_LOAN.disbursementDate);
    expect(eventBoundaryDate(DAY8_LOAN, DAY8_LOAN.disbursementDate)).toBe(
      DAY8_LOAN.disbursementDate,
    );
  });
});

/**
 * Regression for #1291. An early repayment used to be imputed to the CLOSING OF
 * THE PREVIOUS CUOTA: the cycle's boundary balance was overwritten with the
 * post-lump figure, so under `step` (the default, ADR 0031) the balance appeared
 * reduced weeks before the payment existed. Two measurable consequences: the
 * history stopped being reproducible (a snapshot taken in that window diverged
 * from the live recompute, and the trace called it an infidelity that no user
 * correction explains), and the drop was dated wrong on every debt curve.
 *
 * The contract now: the money leaves on its own day. The cycle's boundary keeps
 * what the previous cuota closed at, the curve steps down on the repayment date,
 * and the following cuota closes exactly where it did before — the lump is
 * reflected ONCE.
 *
 * Deliberately unchanged (noted in the issue as a separate model question): the
 * period's interest is still accrued on the post-lump opening balance, so the
 * cuota the bank charges for the cycle the lump falls in is the reduced one.
 */
describe("early repayment dating: the drop lands on the repayment date (#1291)", () => {
  // The real case (workspace de Jose, `Préstamos Revolut`): 6.000 € at 5,89 % over
  // 42 months, disbursed 2026-05-08, first cuota 2026-06-08 of 158,44 €, with a
  // 154,34 € reduce-plazo lump on 2026-07-03.
  const REVOLUT: AmortizationPlanInput = {
    annualInterestRate: "0.0589",
    initialCapitalMinor: 6_000_00,
    disbursementDate: "2026-05-08",
    firstPaymentDate: "2026-06-08",
    termMonths: 42,
  };
  const LUMP: EarlyRepayment = {
    amountMinor: 154_34,
    mode: "reduce-term",
    repaymentDate: "2026-07-03",
  };
  // First cuota: interest = 6.000 × 0.0589/12 = 29,45; principal = 158,44 − 29,45
  // = 128,99 → the June cuota closes at 5.871,01 €.
  const JUNE_CLOSING = 5_871_01;
  // The cuota that closes the cycle the lump falls in (cuotas are on day 8).
  const NEXT_CUOTA = "2026-07-08";

  const balanceAt = (
    targetDate: string,
    options: { repayments?: readonly EarlyRepayment[]; cadence?: ValuationCadence } = {},
  ) =>
    amortizableBalanceAtDate({
      earlyRepayments: options.repayments ?? [LUMP],
      plan: REVOLUT,
      targetDate,
      ...(options.cadence ? { cadence: options.cadence } : {}),
    });

  test("reproduction: the window between the cuota and the payment keeps the cuota's closing", () => {
    // The whole window is the balance the June cuota actually closed at — the
    // figure a snapshot taken on any of these days must reproduce.
    for (const dateBeforeLump of ["2026-06-08", "2026-06-30", "2026-07-02"]) {
      expect(balanceAt(dateBeforeLump)).toBe(JUNE_CLOSING);
      // …and it is the same as the curve without the lump at all: nothing has
      // been paid yet, so the two curves cannot differ here.
      expect(balanceAt(dateBeforeLump, { repayments: [] })).toBe(JUNE_CLOSING);
    }
  });

  test("on the repayment date the balance drops by exactly the lump", () => {
    expect(balanceAt("2026-07-03")).toBe(JUNE_CLOSING - LUMP.amountMinor);
    // Flat from there to the next cuota (step-by-default within a cycle).
    expect(balanceAt("2026-07-07")).toBe(JUNE_CLOSING - LUMP.amountMinor);
  });

  test("the following cuota closes where it always did: the lump counts once", () => {
    // The lump falls in the cycle [2026-06-08, 2026-07-08), whose cuota is the one
    // dated 2026-07-08. That period opens post-lump at 5.716,67 €, accrues
    // 5.716,67 × 0.0589/12 = 28,06 € of interest and keeps the 158,44 € cuota
    // (reduce-plazo), so it retires 130,37 € of principal and closes at
    // 5.586,30 € — the same closing the engine produced before the fix. The
    // dating changed; the forward schedule did not.
    expect(balanceAt(NEXT_CUOTA)).toBe(5_586_30);
    // The drop across the whole cycle is the lump plus the cuota's principal,
    // never twice the lump.
    expect(JUNE_CLOSING - balanceAt(NEXT_CUOTA)).toBe(LUMP.amountMinor + 130_37);
  });

  test("two lumps in the same cycle each land on their own date", () => {
    // Both inside [2026-06-08, 2026-07-08) — the case the real workspace does not
    // have (its 3-jul and 24-jul fall in different cycles) and that must be pinned.
    const first: EarlyRepayment = {
      amountMinor: 100_00,
      mode: "reduce-term",
      repaymentDate: "2026-06-20",
    };
    const second = LUMP; // 154,34 € on 2026-07-03
    const both = [first, second];

    expect(balanceAt("2026-06-19", { repayments: both })).toBe(JUNE_CLOSING);
    expect(balanceAt("2026-06-20", { repayments: both })).toBe(
      JUNE_CLOSING - first.amountMinor,
    );
    expect(balanceAt("2026-07-02", { repayments: both })).toBe(
      JUNE_CLOSING - first.amountMinor,
    );
    expect(balanceAt("2026-07-03", { repayments: both })).toBe(
      JUNE_CLOSING - first.amountMinor - second.amountMinor,
    );
    // Input order must not matter: the curve applies them by date.
    expect(balanceAt("2026-07-02", { repayments: [second, first] })).toBe(
      JUNE_CLOSING - first.amountMinor,
    );
    // Each is reflected exactly once in the cuota's closing: it falls by the extra
    // lump plus the month's interest that lump no longer accrues (100 € × 0.0589/12
    // = 0,49 € at full precision, 0,50 € once rounded at the edge), never by twice
    // either lump.
    const closingWithBoth = balanceAt(NEXT_CUOTA, { repayments: both });
    expect(balanceAt(NEXT_CUOTA) - closingWithBoth).toBe(100_50);
  });

  test("a lump on the cuota date itself still lands on that date", () => {
    const onCuota: EarlyRepayment = {
      amountMinor: 154_34,
      mode: "reduce-term",
      repaymentDate: NEXT_CUOTA,
    };
    // 2026-07-08 is the second cuota: the balance there is that cuota's closing
    // minus the lump, and the day before still belongs to the June cycle.
    expect(balanceAt("2026-07-07", { repayments: [onCuota] })).toBe(JUNE_CLOSING);
    expect(balanceAt(NEXT_CUOTA, { repayments: [onCuota] })).toBe(
      balanceAt(NEXT_CUOTA, { repayments: [] }) - onCuota.amountMinor,
    );
  });

  test("a lump paid inside the disbursement→first-payment stub shows from its date", () => {
    // The stub is flat at the initial capital (ADR 0019), but a lump paid inside
    // it is real money: it must show from its day, not wait for the first cuota.
    const inStub: EarlyRepayment = {
      amountMinor: 500_00,
      mode: "reduce-term",
      repaymentDate: "2026-05-20",
    };
    expect(balanceAt("2026-05-19", { repayments: [inStub] })).toBe(6_000_00);
    expect(balanceAt("2026-05-20", { repayments: [inStub] })).toBe(6_000_00 - 500_00);
    expect(balanceAt("2026-06-07", { repayments: [inStub] })).toBe(6_000_00 - 500_00);
  });

  test("the schedule hangs the lump on the period whose figures it moves", () => {
    // The issue's other half of the evidence: the frontier dated 2026-06-08 (period
    // 1) carried the 2026-07-03 event. It is period 2 (the 2026-07-08 cuota) that
    // opens on the reduced balance and closes below it, so that is the row the event
    // belongs to — otherwise one row moves 154,34 € with no event while another
    // lists an event that moves nothing.
    const trace = amortizationScheduleTrace({
      earlyRepayments: [LUMP],
      plan: REVOLUT,
      targetDate: "2026-07-03",
    });
    const june = trace.periods.find((p) => p.date === "2026-06-08")!;
    const july = trace.periods.find((p) => p.date === NEXT_CUOTA)!;

    expect(june.events).toEqual([]);
    expect(june.closingBalanceMinor).toBe(JUNE_CLOSING);
    expect(july.events).toEqual([
      {
        amountMinor: LUMP.amountMinor,
        date: LUMP.repaymentDate,
        kind: "early_repayment",
        mode: "reduce-term",
      },
    ]);
    // The row it rides is the one that opens post-lump: opening = the previous
    // closing minus the lump, so the table adds up within its own row.
    expect(july.openingBalanceMinor).toBe(JUNE_CLOSING - LUMP.amountMinor);
    // And every closing still equals the curve on its own date.
    for (const period of trace.periods) {
      expect(period.closingBalanceMinor).toBe(balanceAt(period.date));
    }
  });

  test("interpolated draws its line between the real dates, with the lump as a step", () => {
    const interpolated = { cadence: "interpolated" as ValuationCadence };
    // The cycle opens at the June closing under either cadence …
    expect(balanceAt("2026-06-08", interpolated)).toBe(JUNE_CLOSING);
    // … the line only amortizes before the lump (a few euros, never the lump) …
    const dayBefore = balanceAt("2026-07-02", interpolated);
    expect(dayBefore).toBeLessThan(JUNE_CLOSING);
    expect(dayBefore).toBeGreaterThan(JUNE_CLOSING - 150_00);
    // … and it tracks the no-lump line to within the residue of the deferred
    // accrual: the period's ordinary principal is computed on the post-lump balance
    // (the model change the issue leaves out), so prorating it makes the pre-payment
    // stretch amortize a hair faster. Cents here, against 154,34 € of backdating
    // before the fix — and exactly zero under the default `step` cadence.
    const noLump = balanceAt("2026-07-02", { cadence: "interpolated", repayments: [] });
    expect(noLump - dayBefore).toBeLessThan(1_00);
    expect(noLump - dayBefore).toBeGreaterThan(0);
    // … the lump is a step of its own size on its date (plus that one day of
    // ordinary amortization the line keeps drawing) …
    const stepOverTheLump = dayBefore - balanceAt("2026-07-03", interpolated);
    expect(stepOverTheLump).toBeGreaterThan(154_00);
    expect(stepOverTheLump).toBeLessThan(160_00);
    // … and the cycle still ends exactly on the next cuota's closing.
    expect(balanceAt(NEXT_CUOTA, interpolated)).toBe(balanceAt(NEXT_CUOTA));
  });
});

describe("addMonths day-clamping — end-of-month first-payment dates", () => {
  test("intra-month interpolation uses the real calendar span, not a rolled date", () => {
    // Two-date model (ADR 0019): the payment cadence runs from a day-31 first
    // payment (2020-01-31), so a February payment boundary clamps to 2020-02-29
    // (leap year). The disbursement→first-payment stub is flat, so this case tests
    // an AMORTIZING month boundary (boundary 1→2), not the flat stub.
    //
    // 0% loan: payment = capital / n, balance falls linearly. With capital =
    // 2_900_00 cents and 12 months, each payment retires 2_900_00/12 cents.
    //
    // Boundary 1 (first payment, 2020-01-31) = 2_900_00 − 2_900_00/12 = 265_833.
    // Boundary 2 (2020-02-29, clamped) = 2_900_00 − 2 × 2_900_00/12 = 241_667.
    // The boundary-1→2 month runs 2020-01-31 → 2020-02-29 (29 days, not 31).
    //
    // On 2020-02-15 (15 days into that month, span=29 days):
    //   interpolated = 265_833 − (2_900_00/12) × (15/29) = 253_333 cents (half-up)
    //
    // The buggy addMonths produced "2020-02-31", which JS rolls to 2020-03-02,
    // giving the wrong span and shifting the month-locator.
    const plan: AmortizationPlanInput = {
      annualInterestRate: "0",
      initialCapitalMinor: 2_900_00,
      disbursementDate: "2019-12-31",
      firstPaymentDate: "2020-01-31",
      termMonths: 12,
    };
    // The balance is flat at the initial capital through the stub (up to but not
    // including the first payment).
    expect(amortizableBalanceAtDate({ plan, targetDate: "2020-01-15" })).toBe(2_900_00);
    // On the first payment (boundary 1) → after the first payment.
    expect(amortizableBalanceAtDate({ plan, targetDate: "2020-01-31" })).toBe(265_833);
    // On 2020-02-29 the locator places us on boundary 2 (offset 0) → 241_667.
    expect(amortizableBalanceAtDate({ plan, targetDate: "2020-02-29" })).toBe(241_667);
    // Default `step`: between boundary 1 and 2 the balance holds boundary 1's value.
    expect(amortizableBalanceAtDate({ plan, targetDate: "2020-02-15" })).toBe(265_833);
    // Interpolated cadence must use the correct 29-day February span (regression).
    expect(
      amortizableBalanceAtDate({
        plan,
        targetDate: "2020-02-15",
        cadence: "interpolated",
      }),
    ).toBe(253_333);
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

/**
 * Regression for #210. An event (early repayment or rate revision) is pinned to
 * the largest boundary `m` with `boundaryDate(m) ≤ eventDate` (#182), with NO
 * upper clamp. The schedule build loop only iterates `monthIndex < termMonths`,
 * so an event resolving to `monthIndex ≥ termMonths` — a far-future / mistyped
 * date after the loan's final payment boundary — is never read and is SILENTLY
 * DROPPED. The intake must reject such an event instead of discarding it.
 *
 * For a 120-month loan first-paid on 2020-02-01, the final payment boundary is
 * `firstPayment + (termMonths − 1) months = 2030-01-01` (boundary index 120). An
 * event ON or AFTER that date resolves to index ≥ 120 and would be dropped.
 */
describe("assertEventWithinTerm — reject events after the loan's final boundary (#210)", () => {
  const FINITE_LOAN: AmortizationPlanInput = {
    annualInterestRate: "0.05",
    initialCapitalMinor: 100_000_00,
    disbursementDate: "2020-01-01",
    firstPaymentDate: "2020-02-01",
    termMonths: 120,
  };
  // boundaryDate(FINITE_LOAN, termMonths) — the final payment boundary.
  const FINAL_BOUNDARY = "2030-01-01";

  test("a far-future early repayment (would resolve to month 240) is rejected, not dropped", () => {
    expect(() =>
      assertEventWithinTerm(FINITE_LOAN, "2040-01-01", "Repayment date"),
    ).toThrow(/Repayment date 2040-01-01.*2030-01-01/);
  });

  test("a rate revision after the final boundary is rejected, not dropped", () => {
    expect(() =>
      assertEventWithinTerm(FINITE_LOAN, "2035-06-15", "Revision date"),
    ).toThrow(/Revision date 2035-06-15.*2030-01-01/);
  });

  test("an event ON the final payment boundary is rejected (it resolves to month termMonths, which the loop never reads)", () => {
    expect(() =>
      assertEventWithinTerm(FINITE_LOAN, FINAL_BOUNDARY, "Repayment date"),
    ).toThrow();
  });

  test("an event one cycle before the final boundary is accepted (in range)", () => {
    expect(() =>
      assertEventWithinTerm(FINITE_LOAN, "2029-12-01", "Repayment date"),
    ).not.toThrow();
  });

  test("an event well inside the term is accepted (in range)", () => {
    expect(() =>
      assertEventWithinTerm(FINITE_LOAN, "2025-01-01", "Revision date"),
    ).not.toThrow();
  });

  test("an event before the first payment is accepted (resolves to the disbursement boundary)", () => {
    expect(() =>
      assertEventWithinTerm(FINITE_LOAN, "2020-01-10", "Repayment date"),
    ).not.toThrow();
  });
});

describe("suggestFirstPaymentDate — editable first-payment default (ADR 0019, #189)", () => {
  test("mid-month firma → the 1st, two calendar months later (ING stub)", () => {
    // 2026-06-15: rest of June + a full July → first payment 2026-08-01.
    expect(suggestFirstPaymentDate("2026-06-15")).toBe("2026-08-01");
  });

  test("the day-of-month is always pinned to 01, whatever the firma day", () => {
    expect(suggestFirstPaymentDate("2026-06-01")).toBe("2026-08-01");
    expect(suggestFirstPaymentDate("2026-06-30")).toBe("2026-08-01");
  });

  test("two-month offset rolls the year over December", () => {
    expect(suggestFirstPaymentDate("2026-11-15")).toBe("2027-01-01");
    expect(suggestFirstPaymentDate("2026-12-20")).toBe("2027-02-01");
  });

  test("a day-31 firma in a short target month still lands on the 1st", () => {
    // addMonths(2026-12-31, 2) clamps to 2027-02-28, but the suggestion pins the
    // day to 01, so the clamp never leaks into the result.
    expect(suggestFirstPaymentDate("2026-12-31")).toBe("2027-02-01");
  });
});

describe("current-state amortization derivation — ADR 0056 / #676", () => {
  test("derives the term from the confirmed payment day, not the baseline day", () => {
    expect(
      remainingMonthlyPayments({
        endDate: "2026-09-30",
        nextPaymentDate: "2026-08-31",
      }),
    ).toBe(2);

    const derived = deriveCurrentStateAmortizationPlan({
      annualInterestRate: "0",
      baselineDate: "2026-07-02",
      endDate: "2026-09-30",
      nextPaymentDate: "2026-08-31",
      outstandingBalanceMinor: 100_000_00,
    });

    expect(derived.plan).toMatchObject({
      annualInterestRate: "0",
      disbursementDate: "2026-07-02",
      firstPaymentDate: "2026-08-31",
      initialCapitalMinor: 100_000_00,
      termMonths: 2,
    });
    expect(derived.monthlyPaymentMinor).toBe(50_000_00);
  });

  test("round-trips rate → payment → solved rate within payment rounding tolerance", () => {
    const fromRate = deriveCurrentStateAmortizationPlan({
      annualInterestRate: "0.035",
      baselineDate: "2026-07-02",
      endDate: "2036-08-05",
      nextPaymentDate: "2026-08-05",
      outstandingBalanceMinor: 180_000_00,
    });

    const fromPayment = deriveCurrentStateAmortizationPlan({
      monthlyPaymentMinor: fromRate.monthlyPaymentMinor,
      baselineDate: "2026-07-02",
      endDate: "2036-08-05",
      nextPaymentDate: "2026-08-05",
      outstandingBalanceMinor: 180_000_00,
    });

    expect(Number(fromPayment.annualInterestRate)).toBeCloseTo(0.035, 5);
    expect(fromPayment.plan.annualInterestRate).toBe(fromPayment.annualInterestRate);
  });

  test("handles zero-rate and within-epsilon zero-rate payment inputs", () => {
    const fromRate = deriveCurrentStateAmortizationPlan({
      annualInterestRate: "0",
      baselineDate: "2026-07-02",
      endDate: "2026-10-05",
      nextPaymentDate: "2026-08-05",
      outstandingBalanceMinor: 120_000_00,
    });
    expect(fromRate.monthlyPaymentMinor).toBe(40_000_00);

    const nearZeroPayment = deriveCurrentStateAmortizationPlan({
      monthlyPaymentMinor: 33_333_33,
      baselineDate: "2026-07-02",
      endDate: "2026-10-05",
      nextPaymentDate: "2026-08-05",
      outstandingBalanceMinor: 100_000_00,
    });
    expect(nearZeroPayment.annualInterestRate).toBe("0");
  });

  test("rejects invalid inputs before deriving a schedule", () => {
    expect(() =>
      deriveCurrentStateAmortizationPlan({
        annualInterestRate: "0.02",
        monthlyPaymentMinor: 500_00,
        baselineDate: "2026-07-02",
        endDate: "2026-09-05",
        nextPaymentDate: "2026-08-05",
        outstandingBalanceMinor: 100_000_00,
      }),
    ).toThrow(/exactly one/i);

    expect(() =>
      deriveCurrentStateAmortizationPlan({
        monthlyPaymentMinor: 10_00,
        baselineDate: "2026-07-02",
        endDate: "2026-09-05",
        nextPaymentDate: "2026-08-05",
        outstandingBalanceMinor: 100_000_00,
      }),
    ).toThrow(/too low/i);

    expect(() =>
      remainingMonthlyPayments({
        endDate: "2026-07-05",
        nextPaymentDate: "2026-08-05",
      }),
    ).toThrow(/before the next payment/i);
  });
});

/**
 * Amortization schedule trace (#1049): the per-cuota interest/principal split plus
 * the dated events attached to their boundaries. The load-bearing invariant is
 * that every period's closing balance equals `amortizableBalanceAtDate` on that
 * period's date — the trace never derives a curve the balance locator disagrees
 * with. All other pinned figures are the exact big.js output of the schedule.
 */
describe("amortizationScheduleTrace — the calculation cuadro (#1049)", () => {
  const PLAN: AmortizationPlanInput = {
    annualInterestRate: "0.03",
    disbursementDate: "2020-01-01",
    firstPaymentDate: "2020-02-01",
    initialCapitalMinor: 120_000_00,
    termMonths: 240,
  };

  test("period 1 splits the first cuota into interest + principal on the initial capital", () => {
    const trace = amortizationScheduleTrace({ plan: PLAN, targetDate: "2020-02-01" });
    const first = trace.periods[0]!;

    expect(first.index).toBe(1);
    expect(first.date).toBe("2020-02-01");
    expect(first.openingBalanceMinor).toBe(120_000_00);
    // interest = 120000 × 0.03/12 = 300.00 exactly.
    expect(first.interestMinor).toBe(300_00);
    expect(first.paymentMinor).toBe(first.interestMinor + first.principalMinor);
    expect(first.closingBalanceMinor).toBe(120_000_00 - first.principalMinor);
    expect(first.annualInterestRate).toBe("0.03");
    expect(first.events).toEqual([]);
  });

  test("every period's closing balance equals amortizableBalanceAtDate on its date", () => {
    const trace = amortizationScheduleTrace({ plan: PLAN, targetDate: "2020-02-01" });
    expect(trace.periods).toHaveLength(240);
    for (const period of trace.periods) {
      expect(period.closingBalanceMinor).toBe(
        amortizableBalanceAtDate({ plan: PLAN, targetDate: period.date }),
      );
    }
    // The loan fully amortizes: the final boundary is zero.
    expect(trace.periods.at(-1)!.closingBalanceMinor).toBe(0);
  });

  test("a rate revision is attached to the boundary it lands on and recomputes the cuota", () => {
    const revisions: InterestRateRevision[] = [
      { newAnnualInterestRate: "0.05", revisionDate: "2021-02-01" },
    ];
    const trace = amortizationScheduleTrace({
      earlyRepayments: [],
      plan: PLAN,
      revisions,
      targetDate: "2020-02-01",
    });
    // 2021-02-01 is boundary 13, so period 13 carries the event. Per the engine's
    // `annualRateForMonth`, the new rate governs the cuota computed FROM that
    // boundary — the next period (14, dated 2021-03-01) — so period 13 keeps the
    // old rate while period 14 is the first at 0.05.
    const revised = trace.periods.find((p) => p.date === "2021-02-01")!;
    expect(revised.events).toEqual([
      { annualInterestRate: "0.05", date: "2021-02-01", kind: "rate_revision" },
    ]);
    expect(revised.annualInterestRate).toBe("0.03");
    expect(trace.periods.find((p) => p.date === "2021-03-01")!.annualInterestRate).toBe(
      "0.05",
    );
    expect(trace.periods[0]!.annualInterestRate).toBe("0.03");

    // Closing balances still track the curve with the revision applied.
    for (const period of trace.periods) {
      expect(period.closingBalanceMinor).toBe(
        amortizableBalanceAtDate({ plan: PLAN, revisions, targetDate: period.date }),
      );
    }
  });

  test("a reduce-term lump attaches to its boundary and closes the loan early", () => {
    const earlyRepayments: EarlyRepayment[] = [
      { amountMinor: 110_000_00, mode: "reduce-term", repaymentDate: "2021-02-01" },
    ];
    const trace = amortizationScheduleTrace({
      earlyRepayments,
      plan: PLAN,
      revisions: [],
      targetDate: "2020-02-01",
    });

    const lumpPeriod = trace.periods.find((p) => p.date === "2021-02-01")!;
    expect(lumpPeriod.events).toEqual([
      {
        amountMinor: 110_000_00,
        date: "2021-02-01",
        kind: "early_repayment",
        mode: "reduce-term",
      },
    ]);
    // The lump lands on this frontier, so the period's CLOSING balance drops by
    // the 110.000€ repaid — far below the ~114.500€ it would otherwise carry —
    // exactly as a bank table shows an amortización anticipada line.
    expect(lumpPeriod.closingBalanceMinor).toBeLessThan(11_000_00);
    expect(lumpPeriod.closingBalanceMinor).toBe(
      amortizableBalanceAtDate({ plan: PLAN, earlyRepayments, targetDate: "2021-02-01" }),
    );

    // reduce-term keeps the cuota and pays the loan off well before the 240th
    // period; the schedule stops at the payoff period (closing balance zero).
    expect(trace.periods.at(-1)!.closingBalanceMinor).toBe(0);
    expect(trace.periods.length).toBeLessThan(240);
    for (const period of trace.periods) {
      expect(period.closingBalanceMinor).toBe(
        amortizableBalanceAtDate({
          plan: PLAN,
          earlyRepayments,
          targetDate: period.date,
        }),
      );
    }
  });
});

/**
 * One engine for the cuadro and the curve (#1596).
 *
 * `amortizationScheduleTrace` no longer replays the French schedule: it reads the
 * cycles and boundaries `computeBoundaries` already produced. So the invariant
 * «every period closes where `amortizableBalanceAtDate` says» holds by
 * construction, and the three shapes that used to have to be fixed twice — a
 * `reduce-payment` lump, a rate revision and a long disbursement→first-payment
 * stub — are pinned here against the single engine.
 */
describe("the cuadro is a reading of the balance curve (#1596)", () => {
  const PLAN: AmortizationPlanInput = {
    annualInterestRate: "0.03",
    disbursementDate: "2020-01-01",
    firstPaymentDate: "2020-02-01",
    initialCapitalMinor: 120_000_00,
    termMonths: 240,
  };
  /** A 2,5-month stub (firma 15-ene, primera cuota 1-abr), ADR 0019. */
  const STUB_PLAN: AmortizationPlanInput = {
    annualInterestRate: "0.03",
    disbursementDate: "2020-01-15",
    firstPaymentDate: "2020-04-01",
    initialCapitalMinor: 120_000_00,
    termMonths: 240,
  };
  /** 2021-02-01 is boundary 13: the closing of period 13, opening of period 14. */
  const BOUNDARY_13 = "2021-02-01";
  const BOUNDARY_14 = "2021-03-01";

  /** The loan, without a date: what the cuadro and the curve are both asked about. */
  type Loan = Omit<AmortizableBalanceAtDateInput, "plan" | "targetDate"> & {
    plan?: AmortizationPlanInput;
  };
  const loanOf = (loan: Loan) => ({ ...loan, plan: loan.plan ?? PLAN });

  const traceOf = (loan: Loan) =>
    amortizationScheduleTrace({ ...loanOf(loan), targetDate: "2020-02-01" });

  /** Every row closes where the curve says on its own date — the load-bearing check. */
  const expectRowsToCloseOnTheCurve = (
    periods: readonly { date: string; closingBalanceMinor: number }[],
    loan: Loan,
  ): void => {
    for (const period of periods) {
      expect(period.closingBalanceMinor).toBe(
        amortizableBalanceAtDate({ ...loanOf(loan), targetDate: period.date }),
      );
    }
  };

  test("a reduce-payment lump on a boundary drops that row's closing and lowers the cuota from the next", () => {
    const earlyRepayments: EarlyRepayment[] = [
      { amountMinor: 20_000_00, mode: "reduce-payment", repaymentDate: BOUNDARY_13 },
    ];
    const trace = traceOf({ earlyRepayments });
    const plain = traceOf({});

    const lumpRow = trace.periods.find((p) => p.date === BOUNDARY_13)!;
    const nextRow = trace.periods.find((p) => p.date === BOUNDARY_14)!;

    // The event rides the row whose figures it moves: this row's closing.
    expect(lumpRow.events).toEqual([
      {
        amountMinor: 20_000_00,
        date: BOUNDARY_13,
        kind: "early_repayment",
        mode: "reduce-payment",
      },
    ]);
    expect(lumpRow.closingBalanceMinor).toBe(
      plain.periods.find((p) => p.date === BOUNDARY_13)!.closingBalanceMinor - 20_000_00,
    );

    // reduce-payment: the cuota is re-based over the REMAINING term from the next
    // period on, and the term itself is kept — the loan still runs its 240 cuotas.
    expect(lumpRow.paymentMinor).toBe(plain.periods[0]!.paymentMinor);
    expect(nextRow.paymentMinor).toBeLessThan(lumpRow.paymentMinor);
    expect(nextRow.openingBalanceMinor).toBe(lumpRow.closingBalanceMinor);
    expect(nextRow.interestMinor + nextRow.principalMinor).toBe(nextRow.paymentMinor);
    expect(trace.periods).toHaveLength(240);
    expect(trace.periods.at(-1)!.closingBalanceMinor).toBe(0);

    expectRowsToCloseOnTheCurve(trace.periods, { earlyRepayments });
  });

  test("a reduce-payment lump paid mid-cycle opens the next row below the previous closing", () => {
    const earlyRepayments: EarlyRepayment[] = [
      { amountMinor: 20_000_00, mode: "reduce-payment", repaymentDate: "2021-02-15" },
    ];
    const trace = traceOf({ earlyRepayments });
    const plain = traceOf({});

    const beforeRow = trace.periods.find((p) => p.date === BOUNDARY_13)!;
    const lumpRow = trace.periods.find((p) => p.date === BOUNDARY_14)!;

    // Nothing is backdated to the previous cuota (#1291): that row closes exactly
    // where it closed without the lump, and the event is listed on the row that
    // opens on the reduced balance.
    expect(beforeRow.events).toEqual([]);
    expect(beforeRow.closingBalanceMinor).toBe(
      plain.periods.find((p) => p.date === BOUNDARY_13)!.closingBalanceMinor,
    );
    expect(lumpRow.events.map((e) => e.date)).toEqual(["2021-02-15"]);
    expect(lumpRow.openingBalanceMinor).toBe(beforeRow.closingBalanceMinor - 20_000_00);
    expect(lumpRow.interestMinor + lumpRow.principalMinor).toBe(lumpRow.paymentMinor);

    expectRowsToCloseOnTheCurve(trace.periods, { earlyRepayments });
  });

  test("a long disbursement→first-payment stub is one flat row, and the curve agrees", () => {
    // The balance is FLAT at the initial capital across the stub (ADR 0019) and
    // period 1 is the first cuota.
    const trace = traceOf({ plan: STUB_PLAN });
    const first = trace.periods[0]!;

    expect(first.date).toBe("2020-04-01");
    expect(first.openingBalanceMinor).toBe(120_000_00);
    for (const inStub of ["2020-01-15", "2020-02-29", "2020-03-31"]) {
      expect(amortizableBalanceAtDate({ plan: STUB_PLAN, targetDate: inStub })).toBe(
        120_000_00,
      );
    }

    // The row carries the ORDINARY month's interest and the regular cuota: the
    // stub's extra day-count interest only enlarges the first payment the owner is
    // charged (`firstCuota`, ADR 0019) and never moves the curve — which is why
    // the two figures differ, on purpose, and by exactly the stub interest.
    const cuota = firstCuota(STUB_PLAN);
    expect(first.paymentMinor).toBe(cuota.regularCuotaMinor);
    expect(first.principalMinor).toBe(cuota.firstPrincipalMinor);
    expect(cuota.amountMinor - first.paymentMinor).toBeGreaterThan(0);

    expectRowsToCloseOnTheCurve(trace.periods, { plan: STUB_PLAN });
  });

  test("a lump paid inside the stub lands on period 1, which still closes on the curve", () => {
    const earlyRepayments: EarlyRepayment[] = [
      { amountMinor: 10_000_00, mode: "reduce-payment", repaymentDate: "2020-02-10" },
    ];
    const trace = traceOf({ earlyRepayments, plan: STUB_PLAN });
    const first = trace.periods[0]!;

    // A boundary-0 event has no row of its own: it rides period 1, the cuota that
    // opens on the reduced capital.
    expect(first.events.map((e) => e.date)).toEqual(["2020-02-10"]);
    expect(first.openingBalanceMinor).toBe(120_000_00 - 10_000_00);
    // And the money shows from ITS day inside the stub, not from the first cuota.
    expect(
      amortizableBalanceAtDate({
        earlyRepayments,
        plan: STUB_PLAN,
        targetDate: "2020-02-09",
      }),
    ).toBe(120_000_00);
    expect(
      amortizableBalanceAtDate({
        earlyRepayments,
        plan: STUB_PLAN,
        targetDate: "2020-02-10",
      }),
    ).toBe(120_000_00 - 10_000_00);

    expectRowsToCloseOnTheCurve(trace.periods, { earlyRepayments, plan: STUB_PLAN });
  });

  test("the cuadro stops at the cuota that closes the loan, with no cuota after it", () => {
    // A total repayment on boundary 13 cancels the loan there. The old replay
    // checked the NEXT boundary's balance instead of the row's own closing, so it
    // emitted a 14th row dated 2021-03-01: a full 665,52 € cuota charged on a loan
    // already at zero, and an end date one month late for anything reading the
    // last row (the early-repayment simulation does). Reading the curve fixes it:
    // the table ends on the row whose closing is zero.
    const earlyRepayments: EarlyRepayment[] = [
      { amountMinor: 200_000_00, mode: "reduce-term", repaymentDate: BOUNDARY_13 },
    ];
    const trace = traceOf({ earlyRepayments });
    const last = trace.periods.at(-1)!;

    expect(last.date).toBe(BOUNDARY_13);
    expect(last.index).toBe(13);
    expect(last.closingBalanceMinor).toBe(0);
    // The last row is a real cuota on a live balance, not a phantom one.
    expect(last.openingBalanceMinor).toBeGreaterThan(0);
    expect(last.paymentMinor).toBeGreaterThan(0);
    expect(last.events).toEqual([
      {
        amountMinor: 200_000_00,
        date: BOUNDARY_13,
        kind: "early_repayment",
        mode: "reduce-term",
      },
    ]);
    // And the curve agrees the loan is gone from that date on.
    expect(
      amortizableBalanceAtDate({ earlyRepayments, plan: PLAN, targetDate: BOUNDARY_13 }),
    ).toBe(0);
    expectRowsToCloseOnTheCurve(trace.periods, { earlyRepayments });
  });

  test("the whole shape at once: stub, revision and lump on one loan, one engine", () => {
    const revisions: InterestRateRevision[] = [
      { newAnnualInterestRate: "0.05", revisionDate: "2021-04-01" },
    ];
    const earlyRepayments: EarlyRepayment[] = [
      { amountMinor: 15_000_00, mode: "reduce-payment", repaymentDate: "2022-06-20" },
      { amountMinor: 5_000_00, mode: "reduce-term", repaymentDate: "2023-01-01" },
    ];
    const input = { earlyRepayments, plan: STUB_PLAN, revisions };
    const trace = traceOf(input);

    // Every row is addable ON ITS OWN — opening − principal − whatever lump is
    // dated on the row's own cuota date = closing — and closes where the curve
    // says. Components are each rounded at the edge from full big.js precision, so
    // a row can be a cent off itself: the documented rounding rule, not drift.
    // The payoff row is the one exception and it is not this refactor's: a
    // `reduce-term` loan reaches zero mid-cuota, so the last row shows the full
    // cuota while only the remaining principal is actually retired.
    const payoff = trace.periods.at(-1)!;
    expect(payoff.closingBalanceMinor).toBe(0);
    expect(payoff.principalMinor).toBeGreaterThan(payoff.openingBalanceMinor);

    for (const period of trace.periods.slice(0, -1)) {
      const lumpOnThisDate = period.events
        .filter((e) => e.kind === "early_repayment" && e.date === period.date)
        .reduce((sum, e) => sum + (e.amountMinor ?? 0), 0);
      expect(
        Math.abs(period.interestMinor + period.principalMinor - period.paymentMinor),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          period.closingBalanceMinor -
            (period.openingBalanceMinor - period.principalMinor - lumpOnThisDate),
        ),
      ).toBeLessThanOrEqual(1);
    }
    expectRowsToCloseOnTheCurve(trace.periods, input);

    // Reading the schedule and reading the curve populate the SAME memo (#158), so
    // the order of the two queries cannot change either answer.
    const closings = trace.periods.map((p) => p.closingBalanceMinor);
    const curveFirst = trace.periods.map((p) =>
      amortizableBalanceAtDate({ ...input, targetDate: p.date }),
    );
    expect(
      amortizationScheduleTrace({ ...input, targetDate: "2020-04-01" }).periods.map(
        (p) => p.closingBalanceMinor,
      ),
    ).toEqual(closings);
    expect(curveFirst).toEqual(closings);
  });
});
