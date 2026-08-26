import Big from "big.js";
import { daysBetween } from "./dates";
import type { DecimalString } from "./decimal";
import {
  cadenceOrDefault,
  interpolateOrStep,
  type ValuationCadence,
} from "./valuation-cadence";

/**
 * Pure French-amortization (cuota fija) balance curve (PRD #109, slice 7). No
 * I/O — given a loan's terms, its interest-rate revisions, and a target date, it
 * computes the outstanding principal on that date in integer minor units.
 *
 * Two dates (ADR 0019, #188): a plan carries a DISBURSEMENT date (firma /
 * devengo — when the debt appears at its initial capital and interest begins to
 * accrue) and a FIRST-PAYMENT date (the first cuota; the balance amortizes from
 * here, on this date's day-of-month, with the term counted from here). Between
 * the two the balance is FLAT at the initial capital — the stub interest only
 * enlarges the displayed first cuota and never moves the balance curve.
 *
 * Model:
 *  1. Fixed monthly payment (cuota francesa):
 *       cuota = capital × (i × (1+i)^n) / ((1+i)^n − 1)
 *     with `i` the monthly rate (annual / 12) and `n` the term in months. When
 *     `i = 0` (0% loan) the payment is capital / n (avoids dividing by zero).
 *  2. The amortization schedule has `termMonths` boundaries dated from the
 *     first payment: boundary 0 is the disbursement (initial capital), boundary
 *     `m ≥ 1` is `firstPaymentDate + (m − 1) months`. Boundary 1 is the first
 *     cuota; each step deducts that month's ordinary French principal
 *     (payment − balance × i). The disbursement→first-payment stub spans boundary
 *     0→1 and is flat (the principal it carries is the ordinary first principal,
 *     not a stub-adjusted one — the stub only changes the displayed cuota).
 *  3. A rate revision dated on month boundary `r` recomputes the payment from `r`
 *     onward, over the REMAINING term (n − monthsElapsed) on the live balance at
 *     `r`, using the new rate. Multiple revisions each recompute from their date.
 *  4. The balance on a target date before the first payment is the initial
 *     capital (flat). On/after it, the balance between the boundary the date
 *     falls in and the next is read by the valuation cadence (ADR 0031): `step`
 *     (the default) holds the boundary's balance flat until the next cuota, while
 *     `interpolated` prorates that month's amortization linearly by calendar
 *     days. The stub (boundary 0→1) is never interpolated — it is flat.
 *  5. An early repayment is a STEP on its own date (#1291), laid over the cycle's
 *     ordinary movement: the balance before it is what the previous cuota closed
 *     at, never the reduced figure. Its month boundary only decides which cuota's
 *     interest and recomputed payment the lump belongs to.
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
 * The balance drops by `amountMinor` (clamped at 0, so a lump ≥ the balance is a
 * total repayment that closes the loan) **on the repayment date itself** (#1291),
 * and the cuota is recomputed for the payment cycle the date falls in — the
 * largest month start ≤ the repayment date, the same boundary the balance locator
 * resolves that date to (#182): either over the remaining term on the reduced
 * balance (`reduce-payment`, the end date is kept) or held so the loan reaches 0
 * earlier (`reduce-term`).
 *
 * The two granularities are deliberate: the money leaves on its day (so the curve
 * steps down there, never at the previous cuota), while the schedule is a monthly
 * table whose period the lump belongs to.
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
  /** Loan term in whole months (payments counted from the first payment). */
  termMonths: number;
  /**
   * Disbursement date (firma / devengo), YYYY-MM-DD — when the debt appears at
   * its initial capital. The balance is flat at the initial capital from here
   * until the first payment.
   */
  disbursementDate: string;
  /**
   * First-payment date, YYYY-MM-DD — the first cuota. The balance amortizes from
   * here on this date's day-of-month; the term counts payments from here.
   */
  firstPaymentDate: string;
}

export interface BalanceRebaselineInput {
  /** YYYY-MM-DD the declared current-state balance becomes the schedule baseline. */
  baselineDate: string;
  /** Outstanding principal at the baseline, integer minor units. */
  outstandingBalanceMinor: number;
  /** Contractual end date, YYYY-MM-DD. */
  endDate: string;
  /** Confirmed next cuota date; its day-of-month defines the remaining cadence. */
  nextPaymentDate: string;
  /** Decimal-string annual rate used by the effective forward schedule. */
  annualInterestRate: DecimalString;
  /** True when dates before the baseline are intentionally unmodelled. */
  startsAtBaseline?: boolean;
}

export interface CurrentStateAmortizationInput {
  outstandingBalanceMinor: number;
  baselineDate: string;
  endDate: string;
  nextPaymentDate: string;
  annualInterestRate?: DecimalString;
  monthlyPaymentMinor?: number;
}

export interface CurrentStateAmortizationDerivation {
  plan: AmortizationPlanInput;
  annualInterestRate: DecimalString;
  monthlyPaymentMinor: number;
}

export interface AmortizableBalanceAtDateInput {
  plan: AmortizationPlanInput;
  /** Rate revisions in any order; applied from each revision's month boundary. */
  revisions?: readonly InterestRateRevision[];
  /** Early repayments in any order; each drops the balance on its own date (#1291). */
  earlyRepayments?: readonly EarlyRepayment[];
  /** The date to value the outstanding balance on, YYYY-MM-DD. */
  targetDate: string;
  /**
   * How the balance moves between cuotas (ADR 0031). `step` (the default, and
   * `null`/absent) holds the last cuota's balance flat until the next cuota;
   * `interpolated` prorates the month's amortization linearly by calendar day —
   * the pre-#390 behaviour. Only ever affects a query date strictly between two
   * payment boundaries; cuota-date and pre-first-payment/post-final values are
   * identical under both.
   */
  cadence?: ValuationCadence | null;
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
 * which JS would silently roll to 2020-03-02. Exported so the amortization form
 * can derive the first-payment date from a single input the same way the engine
 * does (ADR 0019, #188).
 */
export function addMonths(dateKey: string, count: number): string {
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

/**
 * The suggested first-payment date for a freshly-entered disbursement: the 1st
 * of the month roughly two months out — the "rest of the contracting month plus
 * a full month" stub ING uses (ADR 0019). A mid-month firma (2026-06-15) →
 * 2026-08-01. It is an editable default, never enforced: banks use other stubs
 * and payment days, so the form lets the user override it (#189). Day-of-month
 * never overflows, so the YYYY-MM prefix of `addMonths(d, 2)` is the target
 * month and pinning the day to "01" is safe.
 */
export function suggestFirstPaymentDate(disbursementDate: string): string {
  return `${addMonths(disbursementDate, 2).slice(0, 7)}-01`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ZERO_RATE_PAYMENT_EPSILON_MINOR = 1;

function assertIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) {
    throw new Error(`${label} must be in YYYY-MM-DD format, got "${value}".`);
  }
}

function assertPositiveMinor(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer minor-unit amount.`);
  }
}

function assertNonNegativeAnnualRate(value: DecimalString): void {
  let rate: Big;
  try {
    rate = new Big(value);
  } catch {
    throw new Error(`Annual interest rate must be a decimal string, got "${value}".`);
  }
  if (rate.lt(0)) {
    throw new Error(`Annual interest rate must be non-negative, got "${value}".`);
  }
}

function normalizeDecimalString(value: number): DecimalString {
  const fixed = value.toFixed(12);
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return (trimmed === "-0" ? "0" : trimmed) as DecimalString;
}

/**
 * Count remaining monthly cuotas from the confirmed next payment through the
 * end date, inclusive. The next payment date, not the baseline date, defines the
 * recurring day-of-month; addMonths handles 31st/short-month clamping.
 */
export function remainingMonthlyPayments(input: {
  nextPaymentDate: string;
  endDate: string;
}): number {
  assertIsoDate(input.nextPaymentDate, "Next payment date");
  assertIsoDate(input.endDate, "End date");
  if (input.endDate < input.nextPaymentDate) {
    throw new Error(
      `End date ${input.endDate} is before the next payment ${input.nextPaymentDate}.`,
    );
  }

  let count = 0;
  while (addMonths(input.nextPaymentDate, count) <= input.endDate) {
    count += 1;
    if (count > 1_200) {
      throw new Error("Remaining term is too long to derive safely.");
    }
  }
  return count;
}

export function monthlyPaymentMinorFromRate(input: {
  outstandingBalanceMinor: number;
  annualInterestRate: DecimalString;
  termMonths: number;
}): number {
  assertPositiveMinor(input.outstandingBalanceMinor, "Outstanding balance");
  if (!Number.isInteger(input.termMonths) || input.termMonths <= 0) {
    throw new Error("Term must be a positive whole number of months.");
  }
  assertNonNegativeAnnualRate(input.annualInterestRate);

  return toMinorInt(
    monthlyPayment(
      new Big(input.outstandingBalanceMinor),
      new Big(input.annualInterestRate).div(12),
      input.termMonths,
    ),
  );
}

function rawPaymentMinorForMonthlyRate(
  outstandingBalanceMinor: number,
  monthlyRate: number,
  termMonths: number,
): number {
  if (monthlyRate === 0) {
    return outstandingBalanceMinor / termMonths;
  }
  const factor = (1 + monthlyRate) ** termMonths;
  return (outstandingBalanceMinor * monthlyRate * factor) / (factor - 1);
}

export function solveAnnualInterestRateFromPayment(input: {
  outstandingBalanceMinor: number;
  monthlyPaymentMinor: number;
  termMonths: number;
}): DecimalString {
  assertPositiveMinor(input.outstandingBalanceMinor, "Outstanding balance");
  assertPositiveMinor(input.monthlyPaymentMinor, "Monthly payment");
  if (!Number.isInteger(input.termMonths) || input.termMonths <= 0) {
    throw new Error("Term must be a positive whole number of months.");
  }

  const zeroPayment = input.outstandingBalanceMinor / input.termMonths;
  const delta = input.monthlyPaymentMinor - zeroPayment;
  if (Math.abs(delta) <= ZERO_RATE_PAYMENT_EPSILON_MINOR) {
    return "0" as DecimalString;
  }
  if (delta < 0) {
    throw new Error(
      "Monthly payment is too low to amortize the balance by the end date.",
    );
  }

  let low = 0;
  let high = 0.01;
  while (
    rawPaymentMinorForMonthlyRate(input.outstandingBalanceMinor, high, input.termMonths) <
    input.monthlyPaymentMinor
  ) {
    high *= 2;
    if (high > 1) {
      throw new Error("Monthly payment implies an unsupported interest rate.");
    }
  }

  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    const payment = rawPaymentMinorForMonthlyRate(
      input.outstandingBalanceMinor,
      mid,
      input.termMonths,
    );
    if (payment < input.monthlyPaymentMinor) low = mid;
    else high = mid;
  }

  return normalizeDecimalString(((low + high) / 2) * 12);
}

export function amortizationPlanFromBalanceRebaseline(
  input: BalanceRebaselineInput,
): AmortizationPlanInput {
  return {
    annualInterestRate: input.annualInterestRate,
    disbursementDate: input.baselineDate,
    firstPaymentDate: input.nextPaymentDate,
    initialCapitalMinor: input.outstandingBalanceMinor,
    termMonths: remainingMonthlyPayments({
      endDate: input.endDate,
      nextPaymentDate: input.nextPaymentDate,
    }),
  };
}

export function deriveCurrentStateAmortizationPlan(
  input: CurrentStateAmortizationInput,
): CurrentStateAmortizationDerivation {
  assertPositiveMinor(input.outstandingBalanceMinor, "Outstanding balance");
  assertIsoDate(input.baselineDate, "Baseline date");
  assertIsoDate(input.nextPaymentDate, "Next payment date");
  assertIsoDate(input.endDate, "End date");
  if (input.baselineDate > input.nextPaymentDate) {
    throw new Error(
      `Baseline date must be on or before the next payment date, got ${input.baselineDate} > ${input.nextPaymentDate}.`,
    );
  }

  const hasRate = input.annualInterestRate !== undefined;
  const hasPayment = input.monthlyPaymentMinor !== undefined;
  if (hasRate === hasPayment) {
    throw new Error("Provide exactly one of annualInterestRate or monthlyPaymentMinor.");
  }

  const termMonths = remainingMonthlyPayments({
    endDate: input.endDate,
    nextPaymentDate: input.nextPaymentDate,
  });

  const annualInterestRate = hasRate
    ? input.annualInterestRate!
    : solveAnnualInterestRateFromPayment({
        monthlyPaymentMinor: input.monthlyPaymentMinor!,
        outstandingBalanceMinor: input.outstandingBalanceMinor,
        termMonths,
      });
  assertNonNegativeAnnualRate(annualInterestRate);

  const monthlyPaymentMinor = hasPayment
    ? input.monthlyPaymentMinor!
    : monthlyPaymentMinorFromRate({
        annualInterestRate,
        outstandingBalanceMinor: input.outstandingBalanceMinor,
        termMonths,
      });

  return {
    annualInterestRate,
    monthlyPaymentMinor,
    plan: {
      annualInterestRate,
      disbursementDate: input.baselineDate,
      firstPaymentDate: input.nextPaymentDate,
      initialCapitalMinor: input.outstandingBalanceMinor,
      termMonths,
    },
  };
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

/**
 * A lump that falls STRICTLY INSIDE a payment cycle — dated after the cycle's own
 * boundary date and before the next cuota (#1291). The curve steps down by
 * `reduction` from this date on; the cycle's boundary balance stays at the
 * pre-lump figure, which is what the previous cuota actually closed at.
 *
 * `reduction` is the EFFECTIVE reduction (the nominal amount clamped to the
 * live balance), so adding the cycle's reductions back to a post-lump balance
 * recovers the pre-lump one exactly, with no second clamp to reason about. Carried
 * at full big.js precision like every other balance here; the caller rounds at the
 * edge.
 */
interface IntraCycleLump {
  /** YYYY-MM-DD the lump is paid; strictly after the cycle's boundary date. */
  date: string;
  /** Principal actually removed on that date, minor units. */
  reduction: Big;
}

/**
 * The mid-cycle lumps of one payment cycle, summed for a target date: `applied`
 * is what has already been paid by then (`date ≤ targetDate`), `total` the whole
 * cycle's. Both are zero when the cycle has no mid-cycle lump.
 */
function cycleLumpTotals(
  lumps: readonly IntraCycleLump[] | undefined,
  targetDate: string,
): { applied: Big; total: Big } {
  let applied = new Big(0);
  let total = new Big(0);
  for (const lump of lumps ?? []) {
    total = total.plus(lump.reduction);
    if (lump.date <= targetDate) {
      applied = applied.plus(lump.reduction);
    }
  }
  return { applied, total };
}

/**
 * The interest/principal split of one payment cycle, recorded WHILE the curve is
 * built (#1596). The schedule the owner reads ({@link amortizationScheduleTrace})
 * is a projection of these rows — there is no second French simulator that could
 * disagree with the boundaries about what a cuota did.
 *
 * These ARE the row's fields, by type: `openingBalanceMinor` is the balance this
 * cycle's interest accrues on — the start of the month with every lump of the
 * cycle already applied, including one paid mid-cycle (#1291), which is why it can
 * sit below the previous cycle's closing. The cycle's closing is not here because
 * it is not the cycle's to state: it is `boundaries[monthIndex + 1]`, the very
 * value the balance locator reads on that date.
 *
 * Rounded to the cent HERE rather than kept at full precision, because this rides
 * the memoised curve (#158) and precision is not free: the balance gains ~20
 * decimals per month, so a 40-year loan's tail Bigs run to ~9.600 digits. Keeping
 * four of them per month would multiply what a cached curve retains by five for
 * figures the schedule rounds at the edge anyway. The rounding is the same
 * {@link toMinorInt} the reader applied, so the rows are byte-identical.
 */
type CycleSplit = Pick<
  AmortizationSchedulePeriod,
  | "annualInterestRate"
  | "interestMinor"
  | "openingBalanceMinor"
  | "paymentMinor"
  | "principalMinor"
>;

/** The date-independent curve of a loan: month boundaries + intra-cycle lumps. */
interface BoundaryCurve {
  /** Balance at each month boundary `[0..termMonths]`, pre intra-cycle lumps. */
  boundaries: MonthlyBoundary[];
  /** By month index, the lumps dated strictly inside that cycle, in date order. */
  intraCycleLumps: Map<number, IntraCycleLump[]>;
  /** By month index `[0..termMonths)`, that cycle's interest/principal split. */
  cycles: CycleSplit[];
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
const boundaryCache = new Map<string, BoundaryCurve>();

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
    plan.disbursementDate,
    plan.firstPaymentDate,
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
function buildBoundaries(input: AmortizableBalanceAtDateInput): BoundaryCurve {
  const cacheKey = boundaryCacheKey(input);
  const cached = boundaryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const curve = computeBoundaries(input);

  // Simple bounded LRU-ish eviction: drop the oldest entry once full.
  if (boundaryCache.size >= MAX_BOUNDARY_CACHE_ENTRIES) {
    const oldest = boundaryCache.keys().next().value;
    if (oldest !== undefined) {
      boundaryCache.delete(oldest);
    }
  }
  boundaryCache.set(cacheKey, curve);
  return curve;
}

/**
 * The lumps landing on each month boundary, in payment order: by date first (a
 * lump paid earlier is applied earlier, which is what the clamp at 0 depends on),
 * then by input order for same-day lumps, so the curve stays deterministic.
 */
function repaymentsByMonthFor(
  plan: AmortizationPlanInput,
  earlyRepayments: readonly EarlyRepayment[] | undefined,
): Map<number, EarlyRepayment[]> {
  const byMonth = new Map<number, EarlyRepayment[]>();
  for (const repayment of earlyRepayments ?? []) {
    const monthIndex = monthIndexForDate(plan, repayment.repaymentDate);
    const list = byMonth.get(monthIndex) ?? [];
    list.push(repayment);
    byMonth.set(monthIndex, list);
  }
  for (const list of byMonth.values()) {
    list.sort((a, b) =>
      a.repaymentDate < b.repaymentDate ? -1 : a.repaymentDate > b.repaymentDate ? 1 : 0,
    );
  }
  return byMonth;
}

/** The outcome of applying one payment cycle's lumps to the live balance. */
interface AppliedCycleLumps {
  /** Live balance after every lump of the cycle — the period's opening balance. */
  balance: Big;
  /**
   * Balance ON the cycle's boundary date: only the lumps dated that very day are
   * applied, so a mid-cycle lump does not backdate itself to the previous cuota
   * (#1291).
   */
  boundaryBalance: Big;
  /** Lumps dated strictly inside the cycle, in date order. */
  intra: IntraCycleLump[];
  /**
   * Balance the cuota must be recomputed on — the balance right after the LAST
   * `reduce-payment` lump of the cycle. Null when no such lump landed here (the
   * cuota is then held: `reduce-term`, or no lump at all).
   */
  paymentBasis: Big | null;
}

/**
 * Apply a cycle's lumps to the live balance, in payment order. Each lump drops
 * the principal (clamped at 0 → total repayment) and, when `reduce-payment`,
 * re-bases the cuota over the remaining term; `reduce-term` holds the cuota so
 * the loan ends earlier.
 *
 * The cycle keeps TWO readings of the same arithmetic (#1291): the period's
 * opening balance (all lumps applied — the figure that period's interest is
 * accrued on) and the balance on the boundary date itself (only that day's
 * lumps), with the mid-cycle ones handed back as dated steps so the curve drops
 * on the day the money left.
 */
function applyCycleLumps(input: {
  balance: Big;
  cycleStart: string;
  repayments: readonly EarlyRepayment[];
}): AppliedCycleLumps {
  let balance = input.balance;
  let boundaryBalance = input.balance;
  let paymentBasis: Big | null = null;
  const intra: IntraCycleLump[] = [];

  for (const repayment of input.repayments) {
    const before = balance;
    balance = balance.minus(repayment.amountMinor);
    if (balance.lt(0)) balance = new Big(0);
    if (repayment.repaymentDate > input.cycleStart) {
      intra.push({
        date: repayment.repaymentDate,
        reduction: before.minus(balance),
      });
    } else {
      boundaryBalance = balance;
    }
    if (repayment.mode === "reduce-payment") {
      paymentBasis = balance;
    }
  }

  return { balance, boundaryBalance, intra, paymentBasis };
}

function computeBoundaries(input: AmortizableBalanceAtDateInput): BoundaryCurve {
  const { plan } = input;
  const { initialCapitalMinor, annualInterestRate, termMonths } = plan;

  const sortedRevisions = (input.revisions ?? [])
    .map((revision) => ({
      monthIndex: monthIndexForDate(plan, revision.revisionDate),
      rate: revision.newAnnualInterestRate,
    }))
    .sort((a, b) => a.monthIndex - b.monthIndex);

  // Early repayments grouped by the month boundary they land on — the same
  // boundary the balance locator resolves their date to (#182).
  const repaymentsByMonth = repaymentsByMonthFor(plan, input.earlyRepayments);
  const intraCycleLumps = new Map<number, IntraCycleLump[]>();

  const boundaries: MonthlyBoundary[] = [{ balance: new Big(initialCapitalMinor) }];
  const cycles: CycleSplit[] = [];
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

    // Apply this cycle's early repayments before the month's amortization: the
    // period opens on the reduced balance (so the cuota and the interest are the
    // ones the bank charges for the period the lump falls in), while the boundary
    // date keeps the balance the previous cuota closed at and the mid-cycle drops
    // are recorded on their own dates (#1291).
    const repayments = repaymentsByMonth.get(monthIndex);
    if (repayments) {
      const applied = applyCycleLumps({
        balance,
        cycleStart: boundaryDate(plan, monthIndex),
        repayments,
      });
      balance = applied.balance;
      if (applied.paymentBasis !== null) {
        const remainingTerm = termMonths - monthIndex;
        payment = monthlyPayment(
          applied.paymentBasis,
          new Big(activeRate).div(12),
          remainingTerm,
        );
      }
      // Overwrite the pre-lump start-of-month value the previous iteration
      // pushed. (Guarded: the no-repayment path is left byte-identical to the
      // revisions-only curve.)
      boundaries[monthIndex] = { balance: applied.boundaryBalance };
      if (applied.intra.length > 0) {
        intraCycleLumps.set(monthIndex, applied.intra);
      }
    }

    const monthlyRate = new Big(activeRate).div(12);
    const opening = balance;
    const interest = opening.times(monthlyRate);
    const principal = payment.minus(interest);
    balance = opening.minus(principal);
    if (balance.lt(0)) balance = new Big(0); // reduce-term / total repayment payoff
    boundaries.push({ balance });
    // The same arithmetic, kept instead of thrown away: this is the row the
    // cuadro shows for this cuota (#1596).
    cycles.push({
      annualInterestRate: activeRate,
      interestMinor: toMinorInt(interest),
      openingBalanceMinor: toMinorInt(opening),
      paymentMinor: toMinorInt(payment),
      principalMinor: toMinorInt(principal),
    });
  }

  return { boundaries, cycles, intraCycleLumps };
}

/**
 * The date of schedule boundary `m` (ADR 0019, #188). Boundary 0 is the
 * disbursement (initial capital); boundary `m ≥ 1` is `firstPaymentDate + (m − 1)
 * months`, so boundary 1 is the first payment and the term's last boundary
 * (`termMonths`) is `firstPaymentDate + (termMonths − 1) months`. The
 * disbursement→first-payment stub is boundary 0→1; every later step is one month.
 */
function boundaryDate(plan: AmortizationPlanInput, m: number): string {
  return m === 0 ? plan.disbursementDate : addMonths(plan.firstPaymentDate, m - 1);
}

/**
 * The schedule boundary index a dated event (early repayment or rate revision)
 * lands on: the largest `m` with `boundaryDate(plan, m) ≤ eventDate`, i.e. the
 * payment cycle the event actually falls in. This is the SAME locator
 * `amortizableBalanceAtDate` uses to find the balance for a query date, so an
 * event pinned here resolves to the boundary that the same date resolves to when
 * queried (#182, preserved over the two-date model). Floored at 0 for events on
 * or before the disbursement date.
 *
 * Whole years/months from the first payment give a fast lower bound for the
 * payment cadence; we then advance while the next boundary is still ≤ the event,
 * so the day-of-month clamping in `addMonths` is honoured exactly. The boundary
 * 0→1 stub may be longer than a month, so the search starts at 0.
 */
function monthIndexForDate(plan: AmortizationPlanInput, eventDate: string): number {
  // Before the first payment the only boundary ≤ the event is the disbursement.
  if (eventDate < plan.firstPaymentDate) return 0;
  const fromYear = Number(plan.firstPaymentDate.slice(0, 4));
  const fromMonth = Number(plan.firstPaymentDate.slice(5, 7));
  const toYear = Number(eventDate.slice(0, 4));
  const toMonth = Number(eventDate.slice(5, 7));
  // Boundary 1 is the first payment; the payment cadence runs from there. Whole
  // calendar months from the first payment give a fast lower bound for the
  // boundary index. boundaryDate(g) = firstPayment + (g − 1) months lands one
  // calendar month before the event's month, so it is always ≤ the event — a safe
  // lower bound (never over by clamping). We then advance while the NEXT boundary
  // is still ≤ the event, honouring addMonths day-clamping exactly.
  const calendarMonths = (toYear - fromYear) * 12 + (toMonth - fromMonth);
  let monthIndex = Math.max(1, calendarMonths);
  while (boundaryDate(plan, monthIndex + 1) <= eventDate) {
    monthIndex += 1;
  }
  return monthIndex;
}

/**
 * The date of the schedule boundary a dated event (early repayment or rate
 * revision) anchors to (#1042): `boundaryDate(plan, monthIndexForDate(plan,
 * eventDate))`. This is the SINGLE source of truth the live curve's bucketing
 * (#182) and the historical ripple's from-date must both use, so they can never
 * drift.
 *
 * Both event types are bucketed to this boundary by the locator, and both reshape
 * the cycle they land in: the lump changes the interest and the recomputed cuota of
 * that period, a revision changes its payment. So under `interpolated` the whole
 * cycle is redrawn — its upper anchor is the new closing — and the boundary is the
 * earliest date any cadence can shift. Rippling from here is therefore a superset
 * of what moved: under `step` the dates in `[boundary, eventDate)` re-derive the
 * value they already hold (since #1291 the curve no longer backdates the lump to
 * the boundary), while rippling from the raw event date would leave the
 * interpolated window stale — the bug (#1042) this from-date fixes. Floored at
 * boundary 0 (the disbursement) for events on or before the first payment.
 */
export function eventBoundaryDate(
  plan: AmortizationPlanInput,
  eventDate: string,
): string {
  return boundaryDate(plan, monthIndexForDate(plan, eventDate));
}

/**
 * Reject a dated event (early repayment or rate revision) that falls AFTER the
 * loan's final payment boundary (#210). `monthIndexForDate` pins an event to the
 * largest boundary `m ≤ eventDate` with no upper clamp, but the schedule only has
 * boundaries `0..termMonths` and the build loop applies events for `monthIndex <
 * termMonths`. An event resolving to `monthIndex ≥ termMonths` — a far-future or
 * mistyped date past the last payment — is never read and would be SILENTLY
 * DROPPED. Surfacing it as a validation error at intake is consistent with the
 * rest of amortization intake validation, which fails fast with a clear message.
 *
 * Pure (reads no clock, no I/O) so the store and any UI can guard with the same
 * rule. The final payment boundary is `boundaryDate(plan, termMonths)`.
 */
export function assertEventWithinTerm(
  plan: AmortizationPlanInput,
  eventDate: string,
  label: string,
): void {
  if (monthIndexForDate(plan, eventDate) >= plan.termMonths) {
    const finalBoundary = boundaryDate(plan, plan.termMonths);
    throw new Error(
      `${label} ${eventDate} is after the loan's final payment boundary (${finalBoundary}); it would fall outside the ${plan.termMonths}-month term and be silently dropped.`,
    );
  }
}

/**
 * The exact first cuota of an amortization plan (ADR 0019, #190), broken down for
 * display. The opening period runs from the disbursement to the first payment and
 * is longer than one calendar month, so the first cuota carries the **stub
 * interest** for that longer period plus that period's ordinary French principal:
 *
 *   stubInterest = capital × annualRate × days(disbursement → first payment) / 360
 *   firstCuota   = stubInterest + first ordinary French principal
 *
 * Components are carried at full big.js precision and each rounded to the cent
 * half up; the cuota itself is the full-precision sum rounded once at the edge
 * (so it never accumulates the two parts' separate rounding). Mirrors the
 * single-rounding-at-the-edge rule used across the engine.
 *
 * DISPLAY ONLY: this never feeds the balance curve, snapshots, or net worth. The
 * principal the first payment amortizes is the ordinary French principal (the
 * stub only enlarges the displayed cuota), so the curve is untouched — calling
 * this changes no figure `amortizableBalanceAtDate` reports.
 */
export interface FirstCuota {
  /** The exact first cuota, integer minor units (stub interest + first principal). */
  amountMinor: number;
  /** Stub interest of the disbursement→first-payment period, integer minor units. */
  stubInterestMinor: number;
  /** First-period ordinary French principal, integer minor units. */
  firstPrincipalMinor: number;
  /** The regular (subsequent) cuota for comparison, integer minor units. */
  regularCuotaMinor: number;
}

export function firstCuota(plan: AmortizationPlanInput): FirstCuota {
  const { initialCapitalMinor, annualInterestRate, termMonths } = plan;
  const capital = new Big(initialCapitalMinor);
  const annualRate = new Big(annualInterestRate);
  const monthlyRate = annualRate.div(12);

  const cuota = monthlyPayment(capital, monthlyRate, termMonths);
  // First ordinary French principal = cuota − first ordinary month's interest.
  const firstPrincipal = cuota.minus(capital.times(monthlyRate));

  const stubDays = daysBetween(plan.disbursementDate, plan.firstPaymentDate);
  const stubInterest = capital.times(annualRate).times(stubDays).div(360);

  return {
    amountMinor: toMinorInt(stubInterest.plus(firstPrincipal)),
    firstPrincipalMinor: toMinorInt(firstPrincipal),
    regularCuotaMinor: toMinorInt(cuota),
    stubInterestMinor: toMinorInt(stubInterest),
  };
}

/** One dated event applied to the schedule, attached to a payment boundary (#1049). */
export interface AmortizationScheduleEvent {
  kind: "rate_revision" | "early_repayment";
  /** YYYY-MM-DD the event is dated. */
  date: string;
  /** New annual rate as a decimal string — `rate_revision` only. */
  annualInterestRate?: DecimalString;
  /** Principal repaid, integer minor units — `early_repayment` only. */
  amountMinor?: number;
  /** Repayment mode — `early_repayment` only. */
  mode?: EarlyRepaymentMode;
}

/**
 * One period of the amortization schedule (#1049): the `index`-th cuota, spanning
 * boundary `index − 1` → `index`. `openingBalanceMinor` is the principal this
 * period's interest is accrued on — the start of the month with EVERY lump of the
 * period already applied, including one paid mid-cycle, which is why it can sit
 * below the previous period's closing (#1291); `closingBalanceMinor` is the balance
 * at the period's payment date — the very boundary
 * {@link amortizableBalanceAtDate} reads there, so the row and the curve cannot
 * become two opinions (#1596). Interest and
 * principal are each rounded to the cent (half up) for display, mirroring
 * {@link firstCuota}; their rounded parts may differ from the rounded payment by a
 * cent, exactly as the components of the first cuota can.
 */
export interface AmortizationSchedulePeriod {
  /** 1-based payment number; period `p` spans boundary `p − 1` → `p`. */
  index: number;
  /** The cuota date (boundary `index`), YYYY-MM-DD. */
  date: string;
  openingBalanceMinor: number;
  paymentMinor: number;
  interestMinor: number;
  principalMinor: number;
  closingBalanceMinor: number;
  /** Annual rate in effect this period, decimal string. */
  annualInterestRate: DecimalString;
  /** Events applied on this period's opening boundary (`index − 1`). */
  events: AmortizationScheduleEvent[];
}

/**
 * The full computed amortization schedule (#1049): the plan's frontiers with the
 * interest/principal split per cuota and the dated events attached to the boundary
 * each one lands on. The calculation trace exposes this so an agent never rebuilds
 * amortization arithmetic in tokens (lesson of #1034). Trailing fully-repaid
 * periods are omitted: the schedule stops at the first period whose closing
 * balance is zero (a `reduce-term` lump or a total repayment closes it early).
 */
export interface AmortizationScheduleTrace {
  disbursementDate: string;
  firstPaymentDate: string;
  termMonths: number;
  initialCapitalMinor: number;
  periods: AmortizationSchedulePeriod[];
}

/**
 * Attach each dated event to the period whose figures it moves (#1049, #1291).
 *
 * An event belongs to the period whose interval CONTAINS its date — period `p`
 * spans boundary `p − 1` → `p` and is dated `boundaryDate(p)`, so the period that
 * contains a date is the one closing on or after it. That is what keeps the table
 * addable: no row balances only if you know about an event listed on another one.
 *
 * For an event dated ON a boundary that is period `monthIndex` (its closing date:
 * a lump there drops the closing, a revision there re-bases the next cuota). For
 * one dated strictly INSIDE the cycle it is period `monthIndex + 1` — the cuota
 * that opens on the reduced balance and closes below it. A boundary-0 event (on or
 * inside the disbursement→first-payment stub) has no period of its own either way,
 * so it rides period 1.
 *
 * Presentation only: which row an event is listed on moves no figure. The
 * arithmetic all happened in {@link computeBoundaries}.
 */
function eventsByPeriodFor(
  input: AmortizableBalanceAtDateInput,
): Map<number, AmortizationScheduleEvent[]> {
  const { plan } = input;
  const eventsByPeriod = new Map<number, AmortizationScheduleEvent[]>();

  const attach = (
    monthIndex: number,
    eventDate: string,
    event: AmortizationScheduleEvent,
  ): void => {
    const insideCycle = eventDate > boundaryDate(plan, monthIndex);
    const period = monthIndex === 0 ? 1 : insideCycle ? monthIndex + 1 : monthIndex;
    const list = eventsByPeriod.get(period) ?? [];
    list.push(event);
    eventsByPeriod.set(period, list);
  };

  const sortedRevisions = (input.revisions ?? [])
    .map((revision) => ({
      date: revision.revisionDate,
      monthIndex: monthIndexForDate(plan, revision.revisionDate),
      rate: revision.newAnnualInterestRate,
    }))
    .sort((a, b) => a.monthIndex - b.monthIndex);
  for (const revision of sortedRevisions) {
    attach(revision.monthIndex, revision.date, {
      annualInterestRate: revision.rate,
      date: revision.date,
      kind: "rate_revision",
    });
  }

  for (const [monthIndex, repayments] of repaymentsByMonthFor(
    plan,
    input.earlyRepayments,
  )) {
    for (const repayment of repayments) {
      attach(monthIndex, repayment.repaymentDate, {
        amountMinor: repayment.amountMinor,
        date: repayment.repaymentDate,
        kind: "early_repayment",
        mode: repayment.mode,
      });
    }
  }

  return eventsByPeriod;
}

/**
 * Read the amortization schedule off the balance curve (#1049, #1596): one row per
 * cuota with the interest/principal split the curve already computed, plus the
 * dated events attached to the period each one moves.
 *
 * There is no second French simulator here. The rows ARE
 * {@link computeBoundaries}' cycles and its boundaries, so a period's
 * `closingBalanceMinor` equals {@link amortizableBalanceAtDate} on that period's
 * date by construction — the next fix to a lump, a rate revision or a short stub
 * lands once and the cuadro and the ficha move together (the class of bug fought
 * in #1291 / #1049 when the two engines had to be kept in step by hand).
 *
 * Still a diagnostic READ, and a far cheaper one: it goes through the boundary
 * memo (#158) instead of replaying the schedule, so the ficha's settlement
 * estimate (#1292) no longer rebuilds an O(termMonths) big.js curve per call —
 * ~65× cheaper on a 480-cuota loan. What it costs the hot path is the four
 * roundings per month the curve now records: ~5 % of a cold curve build, paid once
 * per loan and then amortised over every date the ripple asks for. ADR 0090
 * carries the numbers.
 *
 * It POPULATES the memo as well as reading it. The key is the loan's, identical to
 * the curve's, so a diagnostic read of the loan the ripple is already walking adds
 * no entry — but a read of a cold loan can evict a curve the ripple was reusing.
 * With 64 entries and one cuadro read per surface, that is a cheap rebuild, not a
 * cliff.
 */
export function amortizationScheduleTrace(
  input: AmortizableBalanceAtDateInput,
): AmortizationScheduleTrace {
  const { plan } = input;
  const eventsByPeriod = eventsByPeriodFor(input);
  const { boundaries, cycles } = buildBoundaries(input);

  const periods: AmortizationSchedulePeriod[] = [];
  for (let i = 0; i < cycles.length; i += 1) {
    const cycle = cycles[i]!;
    const index = i + 1;
    // `boundaries[index]` is this period's closing: the post-lump start of the
    // NEXT month, which is exactly what the balance locator reads on this date.
    const closing = boundaries[index]!.balance;
    periods.push({
      ...cycle,
      closingBalanceMinor: toMinorInt(closing),
      date: boundaryDate(plan, index),
      events: eventsByPeriod.get(index) ?? [],
      index,
    });
    // The table ends on the cuota that closes the loan. The test is this row's own
    // closing, not the next boundary's: the replay checked the latter and emitted
    // one extra row — a full cuota on a balance already at zero — whenever a lump
    // cancelled the loan ON a boundary (#1596). The curve, for its part, keeps
    // walking zeroed months to the contractual last boundary; those are not rows.
    if (closing.eq(0)) break;
  }

  return {
    disbursementDate: plan.disbursementDate,
    firstPaymentDate: plan.firstPaymentDate,
    initialCapitalMinor: plan.initialCapitalMinor,
    periods,
    termMonths: plan.termMonths,
  };
}

/**
 * Outstanding principal on `targetDate`, in integer minor units (cents, half up).
 * Before the first payment → the initial capital, flat (covers both the
 * pre-disbursement window and the disbursement→first-payment stub, ADR 0019), less
 * any lump already paid inside the stub — see below. On
 * or after the final payment → 0. Otherwise the balance read between the boundary
 * the target falls in and the next, by the holding's valuation cadence (ADR 0031,
 * #390): `step` (default) holds the last cuota's balance flat until the next
 * cuota; `interpolated` prorates that month's amortization linearly by calendar
 * day. The stub (boundary 0→1) is never interpolated — `targetDate <
 * firstPaymentDate` short-circuits to flat.
 *
 * On top of that, an early repayment paid inside the cycle (or inside the stub)
 * steps the balance down on ITS OWN DATE and not before (#1291) — under either
 * cadence, and in the stub too.
 */
export function amortizableBalanceAtDate(input: AmortizableBalanceAtDateInput): number {
  const { plan, targetDate } = input;
  const { initialCapitalMinor, termMonths, firstPaymentDate } = plan;

  if (targetDate < firstPaymentDate) {
    // Flat stub (ADR 0019), minus any lump already paid inside it (#1291). Two
    // fast exits keep the common case free of curve building: a loan with no
    // lumps at all, and the pre-disbursement window — the debt does not exist
    // yet there, so no lump of it can have moved the figure.
    if (!input.earlyRepayments?.length || targetDate < plan.disbursementDate) {
      return initialCapitalMinor;
    }
    const stub = buildBoundaries(input);
    const paidInStub = cycleLumpTotals(stub.intraCycleLumps.get(0), targetDate).applied;
    return toMinorInt(stub.boundaries[0]!.balance.minus(paidInStub));
  }

  const { boundaries, intraCycleLumps } = buildBoundaries(input);
  const endDate = boundaryDate(plan, termMonths);
  if (targetDate >= endDate) {
    return 0;
  }

  // Locate the boundary the target falls in: the largest m with boundaryDate ≤
  // target. The target is on/after the first payment here, so m ≥ 1.
  // boundaryDate(plan, m) increases monotonically with m, so binary-search that
  // largest m in [1, termMonths) instead of scanning month-by-month (#447) —
  // identical result, O(log termMonths) boundary lookups instead of O(termMonths).
  let monthIndex = 1;
  let lo = 1;
  let hi = termMonths - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (boundaryDate(plan, mid) <= targetDate) {
      monthIndex = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const monthStart = boundaryDate(plan, monthIndex);
  const monthEnd = boundaryDate(plan, monthIndex + 1);
  const startBalance = boundaries[monthIndex]!.balance;
  const endBalance = boundaries[monthIndex + 1]!.balance;

  // A lump paid inside this cycle is a STEP on its own date (#1291), laid over the
  // cycle's ordinary amortization: the cadence draws the ordinary movement between
  // the boundary balance and where the cuota would have closed without the lumps
  // (`endBalance + total`), and the lumps already paid by the target are then
  // deducted. Both totals are zero on a cycle with no mid-cycle lump, so that path
  // stays byte-identical. At the cycle's end the deduction cancels the offset
  // exactly, so the next cuota still closes at `endBalance` — the lump is
  // reflected once, never twice.
  const lumps = cycleLumpTotals(intraCycleLumps.get(monthIndex), targetDate);

  const span = daysBetween(monthStart, monthEnd);
  const offset = daysBetween(monthStart, targetDate);
  const value = interpolateOrStep({
    lower: startBalance,
    upper: endBalance.plus(lumps.total),
    span,
    offset,
    cadence: cadenceOrDefault(input.cadence),
  });
  return toMinorInt(value.minus(lumps.applied));
}
