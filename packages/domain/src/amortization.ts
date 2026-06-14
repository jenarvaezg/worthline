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

/** How an early repayment reshapes the remaining schedule (PRD #146, slice S4). */
export type EarlyRepaymentMode = "reduce-payment" | "reduce-term";

/**
 * A lump-sum early repayment (amortización anticipada) against the principal.
 * Applied at its month boundary — the largest month start ≤ the repayment date,
 * the same boundary the balance locator resolves that date to (#182), the same
 * granularity as a rate revision: the live balance drops by `amountMinor`
 * (clamped at 0, so a lump ≥ the balance is a total repayment that closes the
 * loan), then either the cuota is recomputed over the remaining term
 * (`reduce-payment`, the end date is kept) or the cuota is held and the loan
 * reaches 0 earlier (`reduce-term`).
 */
export interface EarlyRepayment {
  /** YYYY-MM-DD the repayment is made. */
  repaymentDate: string;
  /** Principal repaid, integer minor units. */
  amountMinor: number;
  /** Keep the term and lower the cuota, or keep the cuota and shorten the term. */
  mode: EarlyRepaymentMode;
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
  /** Early repayments in any order; applied from each repayment's month boundary. */
  earlyRepayments?: readonly EarlyRepayment[];
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
 * Memo of computed boundary curves, keyed by the plan + revisions + early
 * repayments (everything `buildBoundaries` reads — `targetDate` is NOT a key,
 * since the curve is identical for every date queried against the same loan).
 *
 * Why this exists (#158): the historical ripple values an amortizable liability
 * at one date per past payment boundary, per scope — dozens to hundreds of
 * `amortizableBalanceAtDate` calls with the SAME loan terms but different dates.
 * Rebuilding the full O(termMonths) big.js schedule on every call made saving a
 * long-running plan take ~30s, long enough that the dev server's server-action
 * request timed out / reset (no native POST, no binding bug — a perf cliff).
 * Memoising the date-independent curve turns the ripple from
 * O(dates × termMonths) into O(termMonths + dates). Output is byte-identical.
 *
 * Bounded so it can never grow without limit across a long-lived server process.
 */
const MAX_BOUNDARY_CACHE_ENTRIES = 64;
const boundaryCache = new Map<string, MonthlyBoundary[]>();

/** Stable value-key for the inputs `buildBoundaries` depends on (not the date). */
function boundaryCacheKey(input: AmortizableBalanceAtDateInput): string {
  const { plan } = input;
  const revisions = (input.revisions ?? [])
    .map((r) => `${r.revisionDate}:${r.newAnnualInterestRate}`)
    .join(",");
  const repayments = (input.earlyRepayments ?? [])
    .map((r) => `${r.repaymentDate}:${r.amountMinor}:${r.mode}`)
    .join(",");
  return [
    plan.initialCapitalMinor,
    plan.annualInterestRate,
    plan.termMonths,
    plan.startDate,
    `R[${revisions}]`,
    `E[${repayments}]`,
  ].join("|");
}

/**
 * Build the balance at the start of each month [0..termMonths]. `boundaries[0]`
 * is the initial capital and `boundaries[termMonths]` is zero (the loan is
 * fully repaid). The payment is recomputed at every revision boundary over the
 * remaining term on the live balance, so revisions ripple forward correctly.
 *
 * Memoised by the date-independent loan key (#158): repeated calls for the same
 * loan reuse the curve instead of rebuilding the O(termMonths) big.js schedule.
 */
function buildBoundaries(input: AmortizableBalanceAtDateInput): MonthlyBoundary[] {
  const cacheKey = boundaryCacheKey(input);
  const cached = boundaryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const boundaries = computeBoundaries(input);

  // Simple bounded LRU-ish eviction: drop the oldest entry once full.
  if (boundaryCache.size >= MAX_BOUNDARY_CACHE_ENTRIES) {
    const oldest = boundaryCache.keys().next().value;
    if (oldest !== undefined) {
      boundaryCache.delete(oldest);
    }
  }
  boundaryCache.set(cacheKey, boundaries);
  return boundaries;
}

function computeBoundaries(input: AmortizableBalanceAtDateInput): MonthlyBoundary[] {
  const { plan } = input;
  const { initialCapitalMinor, annualInterestRate, termMonths, startDate } = plan;

  const sortedRevisions = (input.revisions ?? [])
    .map((revision) => ({
      monthIndex: monthIndexForDate(startDate, revision.revisionDate),
      rate: revision.newAnnualInterestRate,
    }))
    .sort((a, b) => a.monthIndex - b.monthIndex);

  // Early repayments grouped by the month boundary they land on — the same
  // boundary the balance locator resolves their date to (#182). Input order
  // within a month is preserved for determinism.
  const repaymentsByMonth = new Map<number, EarlyRepayment[]>();
  for (const repayment of input.earlyRepayments ?? []) {
    const monthIndex = monthIndexForDate(startDate, repayment.repaymentDate);
    const list = repaymentsByMonth.get(monthIndex) ?? [];
    list.push(repayment);
    repaymentsByMonth.set(monthIndex, list);
  }

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

    // Apply any early repayments landing on this boundary, before the month's
    // amortization. The lump drops the principal (clamped at 0 → total
    // repayment); reduce-payment recomputes the cuota over the remaining term on
    // the new balance, reduce-term keeps the cuota so the loan ends earlier.
    const repayments = repaymentsByMonth.get(monthIndex);
    if (repayments) {
      for (const repayment of repayments) {
        balance = balance.minus(repayment.amountMinor);
        if (balance.lt(0)) balance = new Big(0);
        if (repayment.mode === "reduce-payment") {
          const remainingTerm = termMonths - monthIndex;
          payment = monthlyPayment(balance, new Big(activeRate).div(12), remainingTerm);
        }
      }
      // The lump lands at the start of this month, so the balance ON the
      // boundary date itself reflects it — overwrite the pre-lump start-of-month
      // value the previous iteration pushed. (Guarded: the no-repayment path is
      // left byte-identical to the revisions-only curve.)
      boundaries[monthIndex] = { balance };
    }

    const monthlyRate = new Big(activeRate).div(12);
    const interest = balance.times(monthlyRate);
    const principal = payment.minus(interest);
    balance = balance.minus(principal);
    if (balance.lt(0)) balance = new Big(0); // reduce-term / total repayment payoff
    boundaries.push({ balance });
  }

  return boundaries;
}

/**
 * The month boundary index a dated event (early repayment or rate revision)
 * lands on: the largest `m` with `addMonths(startDate, m) ≤ eventDate`, i.e. the
 * payment cycle the event actually falls in. This is the SAME locator
 * `amortizableBalanceAtDate` uses to find the balance for a query date, so an
 * event pinned here resolves to the boundary that the same date resolves to when
 * queried (#182). Floored at 0 for events on or before the start date.
 *
 * Whole years/months give a fast lower bound (calendar months elapsed, which is
 * always ≤ the answer); we then advance while the next boundary is still ≤ the
 * event, so the day-of-month clamping in `addMonths` is honoured exactly.
 */
function monthIndexForDate(startDate: string, eventDate: string): number {
  const fromYear = Number(startDate.slice(0, 4));
  const fromMonth = Number(startDate.slice(5, 7));
  const toYear = Number(eventDate.slice(0, 4));
  const toMonth = Number(eventDate.slice(5, 7));
  const lowerBound = Math.max(0, (toYear - fromYear) * 12 + (toMonth - fromMonth) - 1);
  let monthIndex = lowerBound;
  while (addMonths(startDate, monthIndex + 1) <= eventDate) {
    monthIndex += 1;
  }
  return monthIndex;
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
