import Big from "big.js";

import {
  type AmortizableBalanceAtDateInput,
  amortizableBalanceAtDate,
  amortizationScheduleTrace,
} from "./amortization";
import { daysBetween } from "./dates";
import { type DecimalString, toMinorInt } from "./decimal";

/**
 * Interest accrued since the last cuota, so the app can name WHICH figure the
 * user is looking at (#1292).
 *
 * Worthline models **outstanding principal**; a bank quotes the **settlement
 * amount** — principal plus the interest run up since the last payment. Both are
 * right, and the gap between them (a fraction of one cuota) reads as a bug every
 * time someone compares the two. This module derives the second from the first
 * so the surfaces can show them side by side.
 *
 * The principal stays the app's figure everywhere (net worth, snapshots, the
 * schedule): folding accrual into it would break the invariant that a period's
 * closing balance equals {@link amortizableBalanceAtDate} on its date, and would
 * re-price every historical snapshot of every loan.
 *
 * ## The convention, and why this one
 *
 * The accrual is the running period's OWN interest — the `interestMinor` the
 * schedule already computes for that cuota — prorated by calendar days elapsed
 * in the cycle. No second day-count basis (365 vs 30/360) is introduced: a
 * separate arithmetic would drift from the schedule the user can read on screen,
 * and would disagree with it by more than the precision either one can honestly
 * claim. Two consequences worth stating plainly:
 *
 *  - The figure is an ESTIMATE and must be presented as one. A bank applies its
 *    own basis and value-dating, so the last cents will not match.
 *  - A lump paid mid-cycle is accrued on the post-lump opening balance for the
 *    whole cycle, inherited from the engine (#1291, ~0,6 € per lump, in the
 *    user's favour). Correcting it here would mean tranche-by-tranche accrual —
 *    a model change with its own ripple, deliberately out of scope.
 */
export interface AccruedInterestAtDate {
  /** Outstanding principal on the date — the app's figure, unchanged. */
  principalMinor: number;
  /** Interest run up since the last cuota, integer minor units. An estimate. */
  accruedInterestMinor: number;
  /** `principal + accrued` — the magnitude a bank's "pending" figure compares to. */
  settlementEstimateMinor: number;
  /** Start of the running cycle: the last cuota, or the disbursement in the stub. */
  cycleStartDate: string;
  /** End of the running cycle — the next cuota date. */
  cycleEndDate: string;
  /** Calendar days elapsed from `cycleStartDate` to the target date. */
  elapsedDays: number;
  /** Calendar days the whole cycle spans. */
  cycleDays: number;
  /** Annual rate governing the running cycle, decimal string. */
  annualInterestRate: DecimalString;
}

/**
 * Interest accrued on an amortizable debt between its last cuota and
 * `targetDate`, or `null` when no cycle is running there — before the money is
 * disbursed, and on or after the cuota that repays the loan (the schedule stops
 * at the first period closing at zero, so a `reduce-term` payoff ends accrual
 * too).
 *
 * Takes the same input as {@link amortizableBalanceAtDate} and reports its
 * principal verbatim, so the two readings cannot drift apart.
 */
export function accruedInterestAtDate(
  input: AmortizableBalanceAtDateInput,
): AccruedInterestAtDate | null {
  const { plan, targetDate } = input;
  if (targetDate < plan.disbursementDate) {
    return null;
  }

  const trace = amortizationScheduleTrace(input);
  // The running cycle is the period that closes AFTER the target: on a cuota
  // date the interest has just been settled, so that day belongs to the cycle
  // starting there, with zero elapsed.
  const runningIndex = trace.periods.findIndex((period) => period.date > targetDate);
  if (runningIndex === -1) {
    return null;
  }

  const running = trace.periods[runningIndex]!;
  const previous = trace.periods[runningIndex - 1];
  const cycleStartDate = previous ? previous.date : plan.disbursementDate;
  const cycleDays = daysBetween(cycleStartDate, running.date);
  const elapsedDays = daysBetween(cycleStartDate, targetDate);

  const accruedInterestMinor =
    cycleDays > 0
      ? toMinorInt(new Big(running.interestMinor).times(elapsedDays).div(cycleDays))
      : 0;
  const principalMinor = amortizableBalanceAtDate(input);

  return {
    accruedInterestMinor,
    annualInterestRate: running.annualInterestRate,
    cycleDays,
    cycleEndDate: running.date,
    cycleStartDate,
    elapsedDays,
    principalMinor,
    settlementEstimateMinor: principalMinor + accruedInterestMinor,
  };
}
