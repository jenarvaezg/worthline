import Big from "big.js";

import {
  amortizableBalanceAtDate,
  type AmortizationPlanInput,
  type InterestRateRevision,
} from "./amortization";
import type { DebtModel } from "./workspace-types";

/**
 * Pure "balance of a debt on date X" dispatcher (PRD #109, slice 8). No I/O —
 * given a liability's debt model and its model-specific data, it returns the
 * outstanding balance on a target date in integer minor units. This is the
 * single entry point for all three debt models (it will back the historical
 * snapshot reconstruction in slice 9 / #118).
 *
 * Models:
 *  - "revolving": linear interpolation between balance anchors, by calendar days
 *    (the same day-based interpolation as housing-valuation.ts and
 *    amortization.ts). Outside the anchor range the curve is FLAT — the first
 *    anchor before it, the last anchor after it — never extrapolated.
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
  /** Rate revisions for an amortizable liability (any order). */
  revisions?: readonly InterestRateRevision[];
  /**
   * Initial capital for an informal liability, integer minor units. Used as the
   * balance before the first anchor when present.
   */
  initialCapitalMinor?: number;
  /** The liability's current stored balance, integer minor units (the fallback). */
  currentBalanceMinor: number;
  /** The date to value the balance on, YYYY-MM-DD. */
  targetDate: string;
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `from` to `to` (UTC midnights), signed. */
function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toMs - fromMs) / MS_PER_DAY);
}

/** Round a Big minor-unit value to a whole integer minor unit, half up. */
function toMinorInt(value: Big): number {
  return Number(value.round(0, Big.roundHalfUp).toString());
}

/** Anchors sorted ascending by date (tie-broken by balance for determinism). */
function sortAnchors(
  anchors: readonly DebtBalanceAnchor[],
): DebtBalanceAnchor[] {
  return [...anchors].sort((a, b) =>
    a.anchorDate < b.anchorDate ? -1 : a.anchorDate > b.anchorDate ? 1 : 0,
  );
}

/** Revolving: linear interpolation between anchors by days, flat outside. */
function revolvingBalance(
  anchors: readonly DebtBalanceAnchor[],
  currentBalanceMinor: number,
  targetDate: string,
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
  const fraction = span === 0 ? new Big(0) : new Big(offset).div(span);
  const lowerBalance = new Big(lower.balanceMinor);
  const value = lowerBalance.plus(
    new Big(upper.balanceMinor).minus(lowerBalance).times(fraction),
  );
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

/**
 * Outstanding balance of the liability on `targetDate`, in integer minor units.
 * Dispatches on `debtModel`; falls back to `currentBalanceMinor` when the model
 * is null or lacks the data it needs.
 */
export function debtBalanceAtDate(input: DebtBalanceAtDateInput): number {
  const { currentBalanceMinor, debtModel, targetDate } = input;

  if (debtModel === "revolving") {
    return revolvingBalance(input.anchors ?? [], currentBalanceMinor, targetDate);
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
    if (!input.plan) {
      return currentBalanceMinor;
    }
    return amortizableBalanceAtDate(
      input.revisions === undefined
        ? { plan: input.plan, targetDate }
        : { plan: input.plan, revisions: input.revisions, targetDate },
    );
  }

  return currentBalanceMinor;
}
