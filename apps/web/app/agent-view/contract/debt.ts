import type { AgentViewHoldingDirection } from "./holdings";
import type { AgentViewMoney } from "./shared";

/**
 * One housing valuation anchor for an appreciating holding (PRD #328, #338).
 * `kind` distinguishes a `market_appraisal` (a total-value truth that anchors
 * the curve) from an `improvement` (an incremental reform layered on top). The
 * public `id` is derived from the stable internal anchor id (`wl_van_…`).
 */
export interface AgentViewValuationAnchor {
  id: string;
  object: "valuation_anchor";
  kind: "market_appraisal" | "improvement";
  /** Date the anchor applies on, as `YYYY-MM-DD`. */
  date: string;
  /** Total value for an appraisal, increment for an improvement. */
  value: AgentViewMoney;
  /**
   * Present, and always `true`, on the ONE appraisal that is the acquisition
   * (#1563). Absent on every other anchor — a flag beside `kind` and not a third
   * `kind`, because the acquisition IS a market appraisal: its value is the total
   * truth on its date and the curve reads it as such.
   *
   * It is here because #1437's disease was an anonymous row: the acquisition
   * looked like any other tasación, so nobody could tell which one it was. A read
   * that repeats that anonymity leaves the assistant unable to name the fact
   * `propose_property_acquisition` moves — or to answer «¿desde cuándo consta que
   * lo compré?» without guessing that the oldest one is it.
   */
  acquisition?: true;
}

/**
 * One interest-rate revision against an amortization plan (PRD #328, #338). The
 * public `id` is derived from the stable internal revision id (`wl_irr_…`).
 */
export interface AgentViewInterestRateRevision {
  id: string;
  object: "interest_rate_revision";
  /** Date the new rate takes effect from, as `YYYY-MM-DD`. */
  date: string;
  /** New annual rate, as a decimal string (e.g. `"0.03"`). */
  annualInterestRate: string;
}

/**
 * One lump-sum early repayment against an amortization plan (PRD #328, #338).
 * The public `id` is derived from the stable internal repayment id (`wl_erp_…`).
 */
export interface AgentViewEarlyRepayment {
  id: string;
  object: "early_repayment";
  /** Date the repayment is made, as `YYYY-MM-DD`. */
  date: string;
  /** Principal repaid. */
  amount: AgentViewMoney;
  /** `reduce-payment` keeps the term; `reduce-term` keeps the cuota. */
  mode: "reduce-payment" | "reduce-term";
}

/**
 * The amortization plan facts of an amortized liability (PRD #328, #338),
 * including its rate revisions and early repayments. The public `id` is derived
 * from the stable internal plan id (`wl_amp_…`).
 */
export interface AgentViewAmortizationPlan {
  id: string;
  object: "amortization_plan";
  /** Initial borrowed capital. */
  initialCapital: AgentViewMoney;
  /** Annual interest rate at disbursement, as a decimal string. */
  annualInterestRate: string;
  /** Loan term in whole months. */
  termMonths: number;
  /** Disbursement (firma / devengo) date, as `YYYY-MM-DD`. */
  disbursementDate: string;
  /** First-payment date, as `YYYY-MM-DD`. */
  firstPaymentDate: string;
}

/** The amortization calculation facts of an amortized liability (PRD #328, #338). */
export interface AgentViewAmortizationFacts {
  plan: AgentViewAmortizationPlan;
  interestRateRevisions: AgentViewInterestRateRevision[];
  earlyRepayments: AgentViewEarlyRepayment[];
}

/**
 * How an anchored liability's balance is read between its anchors (PRD #328,
 * #338). `linear` (revolving) interpolates by calendar days, flat outside the
 * anchor range; `step` (informal) holds the last anchor on or before a date.
 * Documented so a client knows how intermediate balances are read — the agent
 * view never computes a guessed intermediate value here.
 */
export type AgentViewBalanceInterpolation = "linear" | "step";

/** One declared balance anchor of an anchored liability (PRD #328, #338). */
export interface AgentViewBalanceAnchor {
  id: string;
  object: "balance_anchor";
  /** Date the balance applies on, as `YYYY-MM-DD`. */
  date: string;
  /** Total owed on that date (interest already included). */
  balance: AgentViewMoney;
}

/** The balance-anchor calculation facts of an anchored liability (PRD #328, #338). */
export interface AgentViewBalanceAnchorFacts {
  /** How intermediate balances are read between anchors. */
  interpolation: AgentViewBalanceInterpolation;
  anchors: AgentViewBalanceAnchor[];
}

/** The debt family a calculation trace was computed for (PRD #1048, #1049). */
export type AgentViewCalculationTraceModel = "amortizable" | "revolving" | "informal";

/**
 * One dated event on the amortization schedule, attached to the frontier whose
 * window CONTAINS its date (PRD #1049, #1291): frontier `k` closes the window that
 * runs from the previous cuota up to and including its own, so an event dated
 * exactly on a cuota rides that cuota's frontier and one paid mid-window rides the
 * frontier that closes it. That is the frontier whose figures the event moves. A
 * `rate_revision` carries the new `annualInterestRate`; an `early_repayment`
 * carries the `amount` repaid and its `mode`.
 */
export interface AgentViewAmortizationScheduleEvent {
  kind: "rate_revision" | "early_repayment";
  /** Date the event is dated, as `YYYY-MM-DD`. */
  date: string;
  /** New annual rate as a decimal string — `rate_revision` only. */
  annualInterestRate?: string;
  /** Principal repaid — `early_repayment` only. */
  amount?: AgentViewMoney;
  /** `reduce-payment` keeps the term; `reduce-term` keeps the cuota — `early_repayment` only. */
  mode?: "reduce-payment" | "reduce-term";
}

/**
 * One cuota of the amortization schedule (PRD #1049): the frontier date with its
 * opening/closing balances and the interest/principal split of the payment.
 * `closingBalance` is what the engine reports on `date` (it matches the balance
 * the dashboard curve reads). `events` are the dated events whose date falls in this
 * frontier's window. An early repayment paid mid-window shows as `openingBalance`
 * sitting below the previous frontier's `closingBalance`, by the lump: the curve
 * only drops on the day it was paid (#1291). All money on the loan's OWN (unscoped)
 * terms.
 */
export interface AgentViewAmortizationScheduleFrontier {
  index: number;
  /** The cuota date, as `YYYY-MM-DD`. */
  date: string;
  openingBalance: AgentViewMoney;
  payment: AgentViewMoney;
  interest: AgentViewMoney;
  principal: AgentViewMoney;
  closingBalance: AgentViewMoney;
  /** Annual rate in effect this period, decimal string. */
  annualInterestRate: string;
  events: AgentViewAmortizationScheduleEvent[];
}

/**
 * The full computed amortization cuadro for an amortizable liability (PRD #1049):
 * the plan governing today (resolved through balance re-baselines, ADR 0056) and
 * its frontiers with the per-cuota interest/principal split and attached events.
 * Money is on the loan's own (unscoped) terms; for a wholly-owned holding this
 * coincides with the scope-weighted reconciliation figures below.
 */
export interface AgentViewAmortizationSchedule {
  disbursementDate: string;
  firstPaymentDate: string;
  termMonths: number;
  initialCapital: AgentViewMoney;
  /** The date the effective plan takes over (a re-baseline's baseline, or the plan's disbursement). */
  effectiveFrom: string;
  frontiers: AgentViewAmortizationScheduleFrontier[];
  /** Principal vs the figure the user's bank shows (#1292); null with no running cycle. */
  settlement: AgentViewDebtSettlement | null;
}

/**
 * The two magnitudes of an amortizable debt on the trace's as-of date (#1292):
 * the `principal` worthline models and paints everywhere, and the
 * `settlementEstimate` a bank quotes — principal plus the interest accrued since
 * the last cuota. Both are correct; comparing across them is what makes a
 * healthy loan look like a bug.
 *
 * Served so a reading agent never rebuilds this arithmetic in tokens (the lesson
 * of #1034): NORMALIZE the magnitude against a user-cited figure before
 * diagnosing drift. `accruedInterest` is an estimate — the day-count basis and
 * value-dating are the bank's, so the last cents will differ.
 */
export interface AgentViewDebtSettlement {
  /** The date these figures are read on, `YYYY-MM-DD`. */
  asOf: string;
  /** Outstanding principal — the app's figure, on the loan's own terms. */
  principal: AgentViewMoney;
  /** Interest run up since `lastPaymentDate`. An estimate. */
  accruedInterest: AgentViewMoney;
  /** `principal + accruedInterest` — what a bank's "pending" figure compares to. */
  settlementEstimate: AgentViewMoney;
  /** Start of the running cycle: the last cuota, or the disbursement in the stub. */
  lastPaymentDate: string;
  /** The cuota that closes the running cycle. */
  nextPaymentDate: string;
}

/**
 * One reconciliation point of the calculation trace (PRD #1049): the engine's
 * fresh recomputation (`live`) for a date against the value frozen in the
 * persisted snapshot (`persisted`). Both are scope-weighted for the household,
 * matching the dashboard figure. `diverges` flags a real divergence — a persisted
 * value that the current config no longer reproduces beyond a cent (the #1042
 * class of bug) — never a rounding artifact.
 */
export interface AgentViewCalculationTracePoint {
  /** The date, as `YYYY-MM-DD`. */
  date: string;
  /** Fresh engine recomputation for the current config (household-weighted). */
  live: AgentViewMoney;
  /** The value frozen in the persisted snapshot for this date; null when none exists. */
  persisted: AgentViewMoney | null;
  /** `live − persisted`; null when there is no persisted value to compare. */
  difference: AgentViewMoney | null;
  /** True when a persisted value exists and diverges from `live` beyond a cent. */
  diverges: boolean;
  /** True when this row is a persisted snapshot (vs the always-present current-date row). */
  isSnapshot: boolean;
}

/**
 * The infidelity check (PRD #1049): does the painted/persisted figure match the
 * engine's recomputation for the same config? `faithful` is true when no
 * persisted snapshot diverges beyond a cent; `divergences` lists the offending
 * points (the #1042 class of bug made visible, never hidden).
 */
export interface AgentViewCalculationTraceFidelity {
  faithful: boolean;
  divergences: AgentViewCalculationTracePoint[];
  /** Persisted snapshot points that were compared. */
  checkedPoints: number;
}

/**
 * The modeling-tolerance verdict (PRD #1049): the tolerance band `max(1 €,
 * 0.05 % of |balance|)` and, when a declared figure was supplied, the residual of
 * that figure against the engine's live balance and whether it falls within the
 * band. The band constant is documented so a "difference" below it reads as
 * modeling friction, not a real error.
 */
export interface AgentViewCalculationTraceTolerance {
  /** `max(1 €, 0.05 % of |referenceBalance|)`. */
  band: AgentViewMoney;
  /** The live balance the top-level band was computed against (at `referenceDate`). */
  referenceBalance: AgentViewMoney;
  referenceDate: string;
  /** Present only when a declared figure was supplied. */
  declared?: {
    balance: AgentViewMoney;
    /** The date the declared figure describes. */
    date: string;
    /** `declared − live` at the declared date (signed). */
    residual: AgentViewMoney;
    /** Whether `|residual|` is within the band computed against the declared date's live balance. */
    withinTolerance: boolean;
  };
}

/**
 * The calculation trace for a modelled debt holding (PRD #1048 S1, #1049): the
 * engine's full cuadro (amortization schedule frontiers, or the declared balance
 * anchors of a revolving/informal debt), the live-vs-persisted reconciliation per
 * date, and the two pre-computed verdicts — the infidelity check and the modeling
 * tolerance. It exists so an agent diagnoses a "this figure is wrong" complaint
 * from the engine's own arithmetic instead of rebuilding amortization in tokens
 * (lesson of #1034), and so live-vs-persisted divergences (#1042) are visible.
 * Side-effect-free. Scoped to liabilities with a configured debt model in v1.
 */
export interface AgentViewCalculationTrace {
  object: "calculation_trace";
  /** The holding this trace describes (echoed public `wl_hld_…`). */
  holding: string;
  direction: AgentViewHoldingDirection;
  model: AgentViewCalculationTraceModel;
  /** The valuation date the trace was computed for, as `YYYY-MM-DD`. */
  asOf: string;
  /** The painted current balance (the dashboard figure), household-weighted. */
  currentValue: AgentViewMoney;
  /** Present only for an amortizable liability with a plan. */
  schedule?: AgentViewAmortizationSchedule;
  /** Present only for a revolving/informal liability: its declared balance anchors. */
  balanceAnchors?: AgentViewBalanceAnchorFacts;
  reconciliation: AgentViewCalculationTracePoint[];
  fidelity: AgentViewCalculationTraceFidelity;
  tolerance: AgentViewCalculationTraceTolerance;
  /** Persisted snapshot points beyond the cap that were not reconciled (never silently dropped). */
  omittedReconciliationPoints: number;
}
