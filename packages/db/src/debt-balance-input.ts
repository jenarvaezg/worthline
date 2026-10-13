/**
 * One debt's curve input, assembled from its rows (#1848) — the ONE place the rows
 * of a liability become what `debtBalanceAtDate` walks.
 *
 * Two readers need it and used to assemble it each in its own way: the board's
 * batch read (`readDebtBalanceInputs`, every live debt in one pass) and the ficha,
 * which already holds the rows of ONE debt because it renders them. A third copy of
 * «which rows count for which model» is how the ficha's header and the board's row
 * end up quoting different balances for the same debt, so both come through here.
 *
 * Pure: it takes rows already read and maps only the fields the curve reads, so a
 * record's plumbing (its id, its plan id) never travels into the engine's input.
 */

import type {
  DebtBalanceCurveInputs,
  DebtModel,
  DecimalString,
  EarlyRepaymentMode,
  ValuationCadence,
} from "@worthline/domain";

/** The rows of one liability that shape its curve, as the stores hand them out. */
export interface DebtCurveRows {
  debtModel: DebtModel | null;
  /** The stored `current_balance_minor`: the fallback the engine reads without a curve. */
  currentBalanceMinor: number;
  /** Stored valuation cadence (ADR 0031); null reads as the default `step`. */
  cadence: ValuationCadence | null;
  plan: {
    annualInterestRate: DecimalString;
    disbursementDate: string;
    firstPaymentDate: string;
    initialCapitalMinor: number;
    termMonths: number;
  } | null;
  /** The plan's rate revisions; read only with a plan. */
  revisions: readonly { newAnnualInterestRate: DecimalString; revisionDate: string }[];
  /** The plan's early repayments; read only with a plan. */
  earlyRepayments: readonly {
    amountMinor: number;
    mode: EarlyRepaymentMode;
    repaymentDate: string;
  }[];
  balanceRebaselines: readonly {
    annualInterestRate: DecimalString;
    baselineDate: string;
    endDate: string;
    nextPaymentDate: string;
    outstandingBalanceMinor: number;
    startsAtBaseline: boolean;
  }[];
  /** Declared balances of a revolving or informal debt. */
  anchors: readonly { anchorDate: string; balanceMinor: number }[];
}

/**
 * The curve input of one debt, or null when it has no model — then its stored
 * balance is its figure, and there is no curve to walk.
 */
export function debtBalanceCurveInput(
  rows: DebtCurveRows,
): DebtBalanceCurveInputs | null {
  const { cadence, currentBalanceMinor, debtModel, plan } = rows;
  if (debtModel === null) return null;

  if (debtModel === "amortizable") {
    return {
      balanceRebaselines: rows.balanceRebaselines.map((row) => ({
        annualInterestRate: row.annualInterestRate,
        baselineDate: row.baselineDate,
        endDate: row.endDate,
        nextPaymentDate: row.nextPaymentDate,
        outstandingBalanceMinor: row.outstandingBalanceMinor,
        startsAtBaseline: row.startsAtBaseline,
      })),
      currentBalanceMinor,
      debtModel,
      ...(cadence != null ? { cadence } : {}),
      // Revisions and early repayments hang off the plan (#446): without one they
      // are not events of this curve.
      ...(plan
        ? {
            earlyRepayments: rows.earlyRepayments.map((row) => ({
              amountMinor: row.amountMinor,
              mode: row.mode,
              repaymentDate: row.repaymentDate,
            })),
            plan: {
              annualInterestRate: plan.annualInterestRate,
              disbursementDate: plan.disbursementDate,
              firstPaymentDate: plan.firstPaymentDate,
              initialCapitalMinor: plan.initialCapitalMinor,
              termMonths: plan.termMonths,
            },
            revisions: rows.revisions.map((row) => ({
              newAnnualInterestRate: row.newAnnualInterestRate,
              revisionDate: row.revisionDate,
            })),
          }
        : {}),
    };
  }

  return {
    anchors: rows.anchors.map((row) => ({
      anchorDate: row.anchorDate,
      balanceMinor: row.balanceMinor,
    })),
    currentBalanceMinor,
    ...(cadence != null ? { cadence } : {}),
    debtModel,
  };
}
