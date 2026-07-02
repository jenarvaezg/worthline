/**
 * Holding-valuation dispatcher (#148, ADR 0014).
 *
 * A holding's **valuation method** says how its value (or balance) evolves over
 * time — independent of *what* the holding is (its instrument) or *where* it sits
 * on the liquidity ladder. This module owns the method vocabulary and the pure
 * `valueAt` dispatcher that, given a holding's method-specific inputs and a date,
 * routes to the existing engines (investment valuation, housing valuation, debt
 * balance) — replacing the scattered `type === "investment"` / `"real_estate"` /
 * `debtModel` valuation branches.
 */

import type {
  AmortizationPlanInput,
  BalanceRebaselineInput,
  EarlyRepayment,
  InterestRateRevision,
} from "./amortization";
import { debtBalanceAtDate } from "./debt-balance";
import type { DebtBalanceAnchor } from "./debt-balance";
import { compareUnits } from "./decimal";
import type { DecimalString } from "./decimal";
import { valueHousingAtDate } from "./housing-valuation";
import type { HousingValuationAnchor } from "./housing-valuation";
import type { InvestmentOperation } from "./investment-types";
import type { CurrencyCode } from "./money";
import { derivePosition, latestOperationPrice, operationsUpTo } from "./positions";
import type { ValuationCadence } from "./valuation-cadence";
import { lastKnownValueAtDate } from "./value-history";
import type { ManualValuePoint } from "./value-history";
import type { AssetType, DebtModel } from "./workspace-types";

/** How a holding's value/balance is computed (ADR 0014). */
export type ValuationMethod =
  | "stored"
  | "derived"
  | "appreciating"
  | "amortized"
  | "anchored";

/**
 * The valuation method an asset defaults to, by its current `AssetType` — the
 * S2 backfill (#148): cash/manual are valued by hand (`stored`), an investment is
 * `derived` (units × price), real estate `appreciating` (revaluation curve).
 */
export function defaultValuationMethodForAssetType(type: AssetType): ValuationMethod {
  switch (type) {
    case "investment":
      return "derived";
    case "real_estate":
      return "appreciating";
    case "cash":
    case "manual":
      return "stored";
  }
}

/**
 * The valuation method a liability defaults to, by its current `DebtModel` — the
 * S2 backfill (#148): an amortizable plan is `amortized`, a revolving/informal
 * balance is `anchored`, and a liability with no model keeps its manual balance
 * (`stored`).
 */
export function defaultValuationMethodForDebtModel(
  model: DebtModel | null,
): ValuationMethod {
  switch (model) {
    case "amortizable":
      return "amortized";
    case "revolving":
    case "informal":
      return "anchored";
    case null:
      return "stored";
  }
}

/** The result of valuing a holding on a date. */
export interface HoldingValuation {
  /**
   * The holding's value/balance in integer minor units, or `null` when it is not
   * present on the date (a `derived` holding before its first operation, or fully
   * sold by then).
   */
  valueMinor: number | null;
  /** For a `derived` holding: the units held on the date (snapshot capture detail). */
  units?: DecimalString;
  /** For a `derived` holding: the unit price used to value it, when one was known. */
  unitPrice?: DecimalString;
}

/**
 * The method-specific inputs needed to value one holding on a date. Each member
 * carries exactly what its engine consumes; the manual fallback (`valueHistory`
 * + `currentValueMinor`) mirrors the historical reconstruction's last-known basis.
 */
export type HoldingValuationInput =
  | {
      method: "stored";
      /** The current stored value, the fallback when history doesn't reach back. */
      currentValueMinor: number;
      /** Declared-value audit history. */
      valueHistory?: readonly ManualValuePoint[];
    }
  | {
      method: "derived";
      assetId: string;
      currency: CurrencyCode;
      /** Every operation of the holding (any order); the dispatcher filters to the date. */
      operations: readonly InvestmentOperation[];
      /** A price captured in an existing snapshot for the date; beats the latest op price. */
      capturedUnitPrice?: DecimalString;
      /**
       * Value at COST BASIS, never at the latest operation price (ADR 0006, #183).
       * Set when no provider/manual price was available — the same fallback live
       * capture takes (units present, unitPrice absent). Without it the ripple
       * would silently re-value a cost-basis row at units × latestOperationPrice,
       * shifting a frozen figure whose portfolio state never changed. Ignored when
       * `capturedUnitPrice` is present (a real captured price always wins).
       */
      atCostBasis?: boolean;
    }
  | {
      method: "appreciating";
      /** Market appraisals and improvements (any order). */
      anchors: readonly HousingValuationAnchor[];
      /** Decimal annual rate, e.g. "0.03"; null/"" means no drift. */
      annualAppreciationRate?: DecimalString | null;
      /** The current stored value — the curve's "today" value and the manual fallback. */
      currentValueMinor: number;
      /** "Today" as YYYY-MM-DD, for the curve's forward extrapolation. */
      today: string;
      /** How the drift moves between events (ADR 0031); null/absent → `step`. */
      cadence?: ValuationCadence | null;
      /** Declared-value audit history — the fallback when there is no curve. */
      valueHistory?: readonly ManualValuePoint[];
    }
  | {
      method: "amortized";
      /** The French-amortization plan; omit to fall back to the current balance. */
      plan?: AmortizationPlanInput;
      /** Current-state re-baselines that can override the effective forward plan. */
      balanceRebaselines?: readonly BalanceRebaselineInput[];
      /** Interest-rate revisions (any order). */
      revisions?: readonly InterestRateRevision[];
      /** Early repayments (any order). */
      earlyRepayments?: readonly EarlyRepayment[];
      /** The current stored balance — the fallback when the plan is absent. */
      currentBalanceMinor: number;
      /** How the balance moves between cuotas (ADR 0031); null/absent → `step`. */
      cadence?: ValuationCadence | null;
    }
  | {
      method: "anchored";
      /**
       * Which anchored model. `revolving` steps between anchors by default (the
       * cadence opt-in draws an interpolated line); `informal` is always a step.
       */
      debtModel: "revolving" | "informal";
      /** Balance anchors (any order). */
      anchors?: readonly DebtBalanceAnchor[];
      /** Initial capital for an informal debt, before its first anchor. */
      initialCapitalMinor?: number;
      /** The current stored balance — the fallback outside the anchor range. */
      currentBalanceMinor: number;
      /** How the balance moves between anchors (ADR 0031); null/absent → `step`. */
      cadence?: ValuationCadence | null;
    };

/**
 * Value a holding on `targetDate`, dispatching on its valuation method to the
 * matching engine. Pure — every date-dependent input is passed in, never read
 * from the clock.
 */
export function valueAt(
  input: HoldingValuationInput,
  targetDate: string,
): HoldingValuation {
  switch (input.method) {
    case "stored": {
      const known = lastKnownValueAtDate(input.valueHistory, targetDate);
      return { valueMinor: known ?? input.currentValueMinor };
    }
    case "derived": {
      const ops = operationsUpTo(input.operations, targetDate);
      if (ops.length === 0) return { valueMinor: null }; // did not exist yet

      // A captured price always wins (ADR 0012). Absent one, a row flagged
      // `atCostBasis` keeps NO price so the position values at cost basis (ADR
      // 0006, #183) — only an unflagged row falls back to the latest op price.
      const price =
        input.capturedUnitPrice ??
        (input.atCostBasis ? undefined : latestOperationPrice(ops));
      const position = derivePosition(ops, {
        assetId: input.assetId,
        currency: input.currency,
        ...(price !== undefined ? { currentPricePerUnit: price } : {}),
      });

      // Fully sold (or never accumulated) by this date — not held.
      if (compareUnits(position.currentUnits, "0") === 0) return { valueMinor: null };

      const value = position.marketValue ?? position.costBasis;
      return {
        units: position.currentUnits,
        valueMinor: value.amountMinor,
        ...(price !== undefined ? { unitPrice: price } : {}),
      };
    }
    case "appreciating": {
      const hasCurve =
        input.anchors.length > 0 ||
        (input.annualAppreciationRate != null && input.annualAppreciationRate !== "");

      if (hasCurve) {
        return {
          valueMinor: valueHousingAtDate({
            anchors: input.anchors,
            annualAppreciationRate: input.annualAppreciationRate ?? null,
            currentValueMinor: input.currentValueMinor,
            targetDate,
            today: input.today,
            ...(input.cadence != null ? { cadence: input.cadence } : {}),
          }),
        };
      }

      const known = lastKnownValueAtDate(input.valueHistory, targetDate);
      return { valueMinor: known ?? input.currentValueMinor };
    }
    case "amortized": {
      return {
        valueMinor: debtBalanceAtDate({
          currentBalanceMinor: input.currentBalanceMinor,
          debtModel: "amortizable",
          targetDate,
          ...(input.plan !== undefined ? { plan: input.plan } : {}),
          ...(input.balanceRebaselines !== undefined
            ? { balanceRebaselines: input.balanceRebaselines }
            : {}),
          ...(input.revisions !== undefined ? { revisions: input.revisions } : {}),
          ...(input.earlyRepayments !== undefined
            ? { earlyRepayments: input.earlyRepayments }
            : {}),
          ...(input.cadence != null ? { cadence: input.cadence } : {}),
        }),
      };
    }
    case "anchored": {
      return {
        valueMinor: debtBalanceAtDate({
          currentBalanceMinor: input.currentBalanceMinor,
          debtModel: input.debtModel,
          targetDate,
          ...(input.anchors !== undefined ? { anchors: input.anchors } : {}),
          ...(input.initialCapitalMinor !== undefined
            ? { initialCapitalMinor: input.initialCapitalMinor }
            : {}),
          ...(input.cadence != null ? { cadence: input.cadence } : {}),
        }),
      };
    }
  }
}
