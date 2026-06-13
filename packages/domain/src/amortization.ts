import Big from "big.js";

import type { DecimalString } from "./decimal";

/**
 * Pure French-amortization (cuota fija) balance curve (PRD #109, slice 7). No
 * I/O — given a loan's terms, its interest-rate revisions, and a target date, it
 * computes the outstanding principal on that date in integer minor units.
 *
 * Model:
 *  1. Fixed monthly payment (cuota francesa):
 *       cuota = capital × (i × (1+i)^n) / ((1+i)^n − 1)
 *     with `i` the monthly rate (annual / 12) and `n` the term in months. When
 *     `i = 0` (0% loan) the payment is capital / n (avoids dividing by zero).
 *  2. The amortization schedule runs month by month from `startDate`. Each month
 *     the interest is balance × i and the principal repaid is payment − interest.
 *  3. A rate revision dated on month boundary `r` recomputes the payment from `r`
 *     onward, over the REMAINING term (n − monthsElapsed) on the live balance at
 *     `r`, using the new rate. Multiple revisions each recompute from their date.
 *  4. The balance on a target date is the balance at the start of the month the
 *     date falls in, minus the principal amortized in that month prorated by the
 *     days elapsed (linear intra-month interpolation, by calendar days).
 *
 * Rounding: all arithmetic is carried at full big.js precision; only the final
 * balance is rounded to a whole minor unit (cent), half up. This mirrors the
 * single-rounding-at-the-edge rule of housing-valuation.ts (#113) and keeps the
 * curve from accumulating per-month rounding drift.
 *
 * Dates are parameters (YYYY-MM-DD); the function never reads the clock.
 */

export interface InterestRateRevision {
  /** YYYY-MM-DD the new rate takes effect from. */
  revisionDate: string;
  /** Decimal-string annual rate, e.g. "0.03". */
  newAnnualInterestRate: DecimalString;
}

export interface AmortizationPlanInput {
  /** Initial borrowed capital, integer minor units. */
  initialCapitalMinor: number;
  /** Decimal-string annual interest rate, e.g. "0.025". */
  annualInterestRate: DecimalString;
  /** Loan term in whole months. */
  termMonths: number;
  /** Loan start date, YYYY-MM-DD. */
  startDate: string;
}

export interface AmortizableBalanceAtDateInput {
  plan: AmortizationPlanInput;
  /** Rate revisions in any order; applied from each revision's month boundary. */
  revisions?: readonly InterestRateRevision[];
  /** The date to value the outstanding balance on, YYYY-MM-DD. */
  targetDate: string;
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `from` to `to` (UTC midnights), signed. */
function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toMs - fromMs) / MS_PER_DAY);
}

/** Last calendar day of the given year/month (1-based month). */
function lastDayOfMonth(year: number, month: number): number {
  // Date.UTC(year, month, 0) is the last millisecond of the previous month, i.e.
  // the last day of (year, month) when month is 1-based.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The YYYY-MM-DD that is `count` whole months after `dateKey` (same
 * day-of-month, clamped to the last valid day of the destination month). For
 * example, 2020-01-31 + 1 month → 2020-02-29 (leap year), not "2020-02-31"
 * which JS would silently roll to 2020-03-02.
 */
function addMonths(dateKey: string, count: number): string {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const day = Number(dateKey.slice(8, 10));
  const zeroBased = month - 1 + count;
  const newYear = year + Math.floor(zeroBased / 12);
  const newMonth = (zeroBased % 12) + 1;
  const clampedDay = Math.min(day, lastDayOfMonth(newYear, newMonth));
  const mm = String(newMonth).padStart(2, "0");
  const dd = String(clampedDay).padStart(2, "0");
  return `${newYear}-${mm}-${dd}`;
}

/** Fixed monthly payment for the given capital, monthly rate, and term. */
function monthlyPayment(capital: Big, monthlyRate: Big, termMonths: number): Big {
  if (monthlyRate.eq(0)) {
    return capital.div(termMonths);
  }
  const onePlus = monthlyRate.plus(1);
  let factor = new Big(1);
  for (let k = 0; k < termMonths; k += 1) {
    factor = factor.times(onePlus);
  }
  return capital.times(monthlyRate.times(factor)).div(factor.minus(1));
}

/** The annual rate in effect on month `index` (0-based), honouring revisions. */
function annualRateForMonth(
  baseAnnualRate: DecimalString,
  sortedRevisions: readonly { monthIndex: number; rate: DecimalString }[],
  monthIndex: number,
): DecimalString {
  let rate = baseAnnualRate;
  for (const revision of sortedRevisions) {
    if (revision.monthIndex <= monthIndex) {
      rate = revision.rate;
    }
  }
  return rate;
}

interface MonthlyBoundary {
  /** Balance at the start of the month (before that month's payment). */
  balance: Big;
}

/** Round a Big minor-unit value to a whole integer minor unit, half up. */
function toMinorInt(value: Big): number {
  const rounded = value.lt(0) ? new Big(0) : value.round(0, Big.roundHalfUp);
  return Number(rounded.toString());
}

/**
 * Build the balance at the start of each month [0..termMonths]. `boundaries[0]`
 * is the initial capital and `boundaries[termMonths]` is zero (the loan is
 * fully repaid). The payment is recomputed at every revision boundary over the
 * remaining term on the live balance, so revisions ripple forward correctly.
 */
function buildBoundaries(input: AmortizableBalanceAtDateInput): MonthlyBoundary[] {
  const { plan } = input;
  const { initialCapitalMinor, annualInterestRate, termMonths, startDate } = plan;

  const sortedRevisions = (input.revisions ?? [])
    .map((revision) => ({
      monthIndex: Math.max(0, monthsBetween(startDate, revision.revisionDate)),
      rate: revision.newAnnualInterestRate,
    }))
    .sort((a, b) => a.monthIndex - b.monthIndex);

  const boundaries: MonthlyBoundary[] = [{ balance: new Big(initialCapitalMinor) }];
  let balance = new Big(initialCapitalMinor);
  let payment = monthlyPayment(balance, new Big(annualInterestRate).div(12), termMonths);
  let activeRate = annualInterestRate;

  for (let monthIndex = 0; monthIndex < termMonths; monthIndex += 1) {
    const rateForMonth = annualRateForMonth(
      annualInterestRate,
      sortedRevisions,
      monthIndex,
    );
    // On a month where the active rate changes, recompute the payment over the
    // remaining term on the current balance with the new monthly rate.
    if (rateForMonth !== activeRate) {
      activeRate = rateForMonth;
      const remainingTerm = termMonths - monthIndex;
      payment = monthlyPayment(balance, new Big(activeRate).div(12), remainingTerm);
    }
    const monthlyRate = new Big(activeRate).div(12);
    const interest = balance.times(monthlyRate);
    const principal = payment.minus(interest);
    balance = balance.minus(principal);
    boundaries.push({ balance });
  }

  return boundaries;
}

/** Whole calendar months elapsed from `from` to `to` (floor: partial month not counted). */
function monthsBetween(from: string, to: string): number {
  const fromYear = Number(from.slice(0, 4));
  const fromMonth = Number(from.slice(5, 7));
  const toYear = Number(to.slice(0, 4));
  const toMonth = Number(to.slice(5, 7));
  const toDay = Number(to.slice(8, 10));
  const fromDay = Number(from.slice(8, 10));
  let months = (toYear - fromYear) * 12 + (toMonth - fromMonth);
  if (toDay < fromDay) months -= 1;
  return months;
}

/**
 * Outstanding principal on `targetDate`, in integer minor units (cents, half up).
 * Before the loan starts → the full initial capital. On/after the final payment
 * → 0. Otherwise the start-of-month balance, less the month's principal prorated
 * by the days elapsed in that month (linear intra-month interpolation).
 */
export function amortizableBalanceAtDate(input: AmortizableBalanceAtDateInput): number {
  const { plan, targetDate } = input;
  const { initialCapitalMinor, termMonths, startDate } = plan;

  if (targetDate <= startDate) {
    return initialCapitalMinor;
  }

  const boundaries = buildBoundaries(input);
  const endDate = addMonths(startDate, termMonths);
  if (targetDate >= endDate) {
    return 0;
  }

  // Locate the month the target falls in: the largest m with monthStart ≤ target.
  let monthIndex = 0;
  for (let m = 0; m < termMonths; m += 1) {
    if (addMonths(startDate, m) <= targetDate) {
      monthIndex = m;
    } else {
      break;
    }
  }

  const monthStart = addMonths(startDate, monthIndex);
  const monthEnd = addMonths(startDate, monthIndex + 1);
  const startBalance = boundaries[monthIndex]!.balance;
  const endBalance = boundaries[monthIndex + 1]!.balance;

  const span = daysBetween(monthStart, monthEnd);
  const offset = daysBetween(monthStart, targetDate);
  const fraction = span === 0 ? new Big(0) : new Big(offset).div(span);
  const amortizedThisMonth = startBalance.minus(endBalance).times(fraction);
  return toMinorInt(startBalance.minus(amortizedThisMonth));
}
