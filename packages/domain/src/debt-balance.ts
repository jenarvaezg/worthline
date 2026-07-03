import Big from "big.js";

import {
  amortizationPlanFromBalanceRebaseline,
  amortizableBalanceAtDate,
  type AmortizationPlanInput,
  type BalanceRebaselineInput,
  type EarlyRepayment,
  type InterestRateRevision,
} from "./amortization";
import { daysBetween } from "./dates";
import {
  cadenceOrDefault,
  interpolateOrStep,
  type ValuationCadence,
} from "./valuation-cadence";
import type { DebtModel } from "./workspace-types";

/**
 * Pure "balance of a debt on date X" dispatcher (PRD #109, slice 8). No I/O —
 * given a liability's debt model and its model-specific data, it returns the
 * outstanding balance on a target date in integer minor units. This is the
 * single entry point for all three debt models (it will back the historical
 * snapshot reconstruction in slice 9 / #118).
 *
 * Models:
 *  - "revolving": stepped between balance anchors by the valuation cadence (ADR
 *    0031). `step` (the default) holds the most recent anchor with date ≤ target,
 *    flat until the next anchor — the SAME curve shape as "informal"; `interpolated`
 *    (per-holding opt-in) draws a linear line between anchors by calendar days, the
 *    pre-#392 behaviour. Outside the anchor range the curve is FLAT under either
 *    cadence — the first anchor before it, the last anchor after it — never extrapolated.
 *  - "informal": a step function on the anchors. The balance on X is the last
 *    anchor with date ≤ X. Before the first such anchor it is the initial
 *    capital if declared, else the current balance. The declared figure is used
 *    AS IS — interest is NEVER computed for informal debt.
 *  - "amortizable": delegates to the French-amortization curve
 *    (amortizableBalanceAtDate), so this module is the one place that knows how
 *    to value any of the three models on a date.
 *
 * Balance anchors carry the TOTAL owed on their date (PRD #109): if the debt
 * accrues interest, the user declares the figure with interest already baked in.
 * There is intentionally no "includes interest" flag.
 *
 * Fallbacks: a null debt model, or a model with no usable data (revolving with
 * no anchors, amortizable with no plan), returns `currentBalanceMinor` flat.
 *
 * Rounding: arithmetic is carried at full big.js precision; only the final
 * balance is rounded to a whole minor unit (cent), half up — the
 * single-rounding-at-the-edge rule shared with amortization.ts (#116).
 *
 * Dates are parameters (YYYY-MM-DD); the function never reads the clock.
 */

/** One declared balance for a revolving/informal liability on a given date. */
export interface DebtBalanceAnchor {
  /** YYYY-MM-DD the balance applies on. */
  anchorDate: string;
  /** Total owed on that date, integer minor units (interest already included). */
  balanceMinor: number;
}

export interface DebtBalanceAtDateInput {
  /** How the liability is modelled. Null means no model → current balance flat. */
  debtModel: DebtModel | null;
  /** Balance anchors (any order) for a revolving/informal liability. */
  anchors?: readonly DebtBalanceAnchor[];
  /** The amortization plan for an amortizable liability. */
  plan?: AmortizationPlanInput;
  /** Current-state re-baselines for an amortizable liability, ordered or unordered. */
  balanceRebaselines?: readonly BalanceRebaselineInput[];
  /** Rate revisions for an amortizable liability (any order). */
  revisions?: readonly InterestRateRevision[];
  /** Early repayments for an amortizable liability (any order). */
  earlyRepayments?: readonly EarlyRepayment[];
  /**
   * Initial capital for an informal liability, integer minor units. Used as the
   * balance before the first anchor when present.
   */
  initialCapitalMinor?: number;
  /** The liability's current stored balance, integer minor units (the fallback). */
  currentBalanceMinor: number;
  /** The date to value the balance on, YYYY-MM-DD. */
  targetDate: string;
  /**
   * How a MODELED balance moves between events (ADR 0031). `step` (the default,
   * and `null`/absent) holds the most recent event flat; `interpolated` draws a
   * linear line between events. Threaded into the `revolving` and `amortizable`
   * branches; `informal` is always a step (the toggle is a no-op there) and
   * market-priced fallbacks ignore it.
   */
  cadence?: ValuationCadence | null;
}

/** Round a Big minor-unit value to a whole integer minor unit, half up. */
function toMinorInt(value: Big): number {
  return Number(value.round(0, Big.roundHalfUp).toString());
}

/** Anchors sorted ascending by date (tie-broken by balance for determinism). */
function sortAnchors(anchors: readonly DebtBalanceAnchor[]): DebtBalanceAnchor[] {
  return [...anchors].sort((a, b) =>
    a.anchorDate < b.anchorDate ? -1 : a.anchorDate > b.anchorDate ? 1 : 0,
  );
}

/**
 * Revolving: between anchors by the valuation cadence (ADR 0031) — `step` holds
 * the most recent anchor flat (identical to "informal"), `interpolated` draws a
 * linear line by days. Flat outside the anchor range under either cadence.
 */
function revolvingBalance(
  anchors: readonly DebtBalanceAnchor[],
  currentBalanceMinor: number,
  targetDate: string,
  cadence: ValuationCadence,
): number {
  if (anchors.length === 0) {
    return currentBalanceMinor;
  }

  const sorted = sortAnchors(anchors);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  if (targetDate <= first.anchorDate) {
    return first.balanceMinor;
  }
  if (targetDate >= last.anchorDate) {
    return last.balanceMinor;
  }

  let lower = first;
  let upper = last;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (targetDate >= a.anchorDate && targetDate <= b.anchorDate) {
      lower = a;
      upper = b;
      break;
    }
  }

  const span = daysBetween(lower.anchorDate, upper.anchorDate);
  const offset = daysBetween(lower.anchorDate, targetDate);
  const value = interpolateOrStep({
    lower: new Big(lower.balanceMinor),
    upper: new Big(upper.balanceMinor),
    span,
    offset,
    cadence,
  });
  return toMinorInt(value);
}

/** Informal: step function on the anchors, no interest, ever. */
function informalBalance(
  anchors: readonly DebtBalanceAnchor[],
  initialCapitalMinor: number | undefined,
  currentBalanceMinor: number,
  targetDate: string,
): number {
  const sorted = sortAnchors(anchors);

  let balance: number | null = null;
  for (const anchor of sorted) {
    if (anchor.anchorDate <= targetDate) {
      balance = anchor.balanceMinor;
    } else {
      break;
    }
  }

  if (balance !== null) {
    return balance;
  }

  return initialCapitalMinor ?? currentBalanceMinor;
}

function sortRebaselines(
  rebaselines: readonly BalanceRebaselineInput[],
): BalanceRebaselineInput[] {
  return [...rebaselines].sort((a, b) =>
    a.baselineDate < b.baselineDate ? -1 : a.baselineDate > b.baselineDate ? 1 : 0,
  );
}

/**
 * Which base amortization schedule governs a target date: the plan itself, or
 * the most recent balance re-baseline active by then (ADR 0056). Exported so a
 * recalibration action can resolve "what's the currently active rate / end
 * date" for an existing debt without re-deriving the plan-vs-rebaseline
 * precedence rule itself (PRD #670 S3, #678).
 */
export interface EffectiveAmortizationPlan {
  plan: AmortizationPlanInput;
  effectiveFrom: string;
}

export function effectiveAmortizationPlan(
  input: Pick<DebtBalanceAtDateInput, "plan" | "balanceRebaselines" | "targetDate">,
): EffectiveAmortizationPlan | { startsAfterTarget: true } | null {
  const sortedRebaselines = sortRebaselines(input.balanceRebaselines ?? []);
  const startingBaseline = sortedRebaselines.find((fact) => fact.startsAtBaseline);
  if (startingBaseline && input.targetDate < startingBaseline.baselineDate) {
    return { startsAfterTarget: true };
  }

  let activeRebaseline: BalanceRebaselineInput | undefined;
  for (const fact of sortedRebaselines) {
    if (fact.baselineDate <= input.targetDate) {
      activeRebaseline = fact;
    } else {
      break;
    }
  }

  if (activeRebaseline) {
    return {
      effectiveFrom: activeRebaseline.baselineDate,
      plan: amortizationPlanFromBalanceRebaseline(activeRebaseline),
    };
  }

  if (input.plan) {
    return { effectiveFrom: input.plan.disbursementDate, plan: input.plan };
  }

  return null;
}

function onOrAfter<T extends { revisionDate: string } | { repaymentDate: string }>(
  events: readonly T[],
  dateKey: string,
): T[] {
  return events.filter((event) =>
    "revisionDate" in event
      ? event.revisionDate >= dateKey
      : event.repaymentDate >= dateKey,
  );
}

/**
 * Outstanding balance of the liability on `targetDate`, in integer minor units.
 * Dispatches on `debtModel`; falls back to `currentBalanceMinor` when the model
 * is null or lacks the data it needs.
 */
export function debtBalanceAtDate(input: DebtBalanceAtDateInput): number {
  const { currentBalanceMinor, debtModel, targetDate } = input;
  const cadence = cadenceOrDefault(input.cadence);

  if (debtModel === "revolving") {
    return revolvingBalance(
      input.anchors ?? [],
      currentBalanceMinor,
      targetDate,
      cadence,
    );
  }

  if (debtModel === "informal") {
    return informalBalance(
      input.anchors ?? [],
      input.initialCapitalMinor,
      currentBalanceMinor,
      targetDate,
    );
  }

  if (debtModel === "amortizable") {
    const effective = effectiveAmortizationPlan(input);
    if (effective === null) {
      return currentBalanceMinor;
    }
    if ("startsAfterTarget" in effective) return 0;

    const revisions =
      input.revisions !== undefined
        ? onOrAfter(input.revisions, effective.effectiveFrom)
        : undefined;
    const earlyRepayments =
      input.earlyRepayments !== undefined
        ? onOrAfter(input.earlyRepayments, effective.effectiveFrom)
        : undefined;

    return amortizableBalanceAtDate({
      plan: effective.plan,
      targetDate,
      cadence,
      ...(revisions !== undefined ? { revisions } : {}),
      ...(earlyRepayments !== undefined ? { earlyRepayments } : {}),
    });
  }

  return currentBalanceMinor;
}
