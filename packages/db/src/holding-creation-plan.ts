/**
 * Holding-creation plan (#1105, PRD #1103 S2) — the payload of a
 * `holding_creation` assistant proposal. A chat-declared, previewable "alta por
 * estado actual" (ADR 0056): the user says "añade este fondo / esta cuenta /
 * esta deuda" and the assistant arms a confirmable proposal that creates ONE
 * manual holding by its current state — a valuation dated today, never an empty
 * holding, never invented history (ADR 0048). Modelled as the degenerate
 * reconcile of the S1 matcher: 0 matches, 1 new.
 *
 * The plan is fully resolved at build time (money parsed to minor, instrument +
 * debt model derived from the catalog, ownership resolved to member shares) so
 * the confirm action reconstructs the write purely from this fact — no re-parse
 * of the model's raw arguments. It is discriminated by `family`, mirroring the
 * four persistence seams the confirm dispatches to.
 */

import type {
  CostBasisGrade,
  DebtModel,
  Instrument,
  OwnershipShare,
} from "@worthline/domain";

/** Fields every family shares: the resolved identity + ownership split. */
interface HoldingCreationPlanBase {
  /** Display name of the holding to create. */
  name: string;
  /** What the holding is (ADR 0014) — drives the catalog defaults on apply. */
  instrument: Instrument;
  /** Ownership resolved to member shares at build time (sums ≤ 10000 bps). */
  ownership: OwnershipShare[];
}

/**
 * Stored asset (hand-valued): current_account / term_deposit / precious_metal /
 * vehicle / other. Persists through the manual-asset seam at its current value.
 */
export interface StoredHoldingCreationPlan extends HoldingCreationPlanBase {
  family: "stored";
  /** The current value in minor units — the valuation dated today. */
  currentValueMinor: number;
}

/**
 * Appreciating asset (property / real_estate): persists through the housing seam.
 * Without {@link AppreciatingHoldingCreationPlan.acquisition} the acquisition
 * anchor is dated TODAY at the declared current value (ADR 0056: the unmodelled
 * past stays unmodelled) — and the flat then exists, for every historical
 * reconstruction, only from today.
 */
export interface AppreciatingHoldingCreationPlan extends HoldingCreationPlanBase {
  family: "appreciating";
  /** The current value in minor units — the valuation dated today. */
  currentValueMinor: number;
  isPrimaryResidence: boolean;
  /**
   * When the user states WHEN and FOR HOW MUCH they bought it (#1436): the
   * acquisition anchor is dated there instead of today, and the declared current
   * value becomes a market appraisal dated today. That is what lets a mortgage
   * signed in 2004 be reconstructed against a home that also exists in 2004 —
   * dating the purchase "today" is how a 22-year history came out with a negative
   * housing equity. Both halves travel together: a date without a price cannot
   * anchor a curve.
   */
  acquisition?: {
    /** YYYY-MM-DD, never in the future. */
    date: string;
    /** The purchase price in minor units (positive). */
    valueMinor: number;
  };
}

/**
 * Debt (mortgage / loan / credit_card): persists through the liability seam at
 * its current balance. The current-state amortization schedule is OUT for v1 —
 * a plain balance-today creation is the honest alta.
 */
export interface DebtHoldingCreationPlan extends HoldingCreationPlanBase {
  family: "debt";
  /** The outstanding balance in minor units — the current state, dated today. */
  balanceMinor: number;
  debtModel: DebtModel;
}

/**
 * Derived investment (fund / etf / stock / index / pension_plan / crypto):
 * persists through the investment seam. When `opening` is present the alta
 * records the opening BUY dated today so the holding lands valued (never a 0 €
 * container); when absent the holding is an empty container awaiting operations.
 */
export interface InvestmentHoldingCreationPlan extends HoldingCreationPlanBase {
  family: "investment";
  providerSymbol?: string;
  isin?: string;
  /**
   * The opening BUY dated today, when the user declared it. `units` and
   * `pricePerUnit` are persisted on the operation verbatim; `valueMinor` is the
   * position's MARKET value — the figure the impact header moves: `units × price`
   * when the units were declared, the declared amount net of the commission when
   * they were derived from it (the same figure, without re-rounding what the user
   * typed).
   * `feesMinor` is the broker commission (#1315): cost basis, never market value,
   * so it is never folded into `valueMinor` (the domain adds it: units × price +
   * fees). Absent when the document declared no commission.
   */
  opening?: {
    units: string;
    pricePerUnit: string;
    valueMinor: number;
    feesMinor?: number;
    /**
     * How honest this opening's price is as a COST (#1505). Set to `value_only`
     * when the declaration was a BALANCE — «tengo 574,48 € en este fondo» (#1325)
     * — because then the price is what the position is worth today and nobody has
     * said what it cost. Absent when the model read an order's terms off a
     * document: those ARE what was paid.
     */
    costBasisGrade?: CostBasisGrade;
  };
}

/** The declarative alta plan the `holding_creation` fact carries, by family. */
export type HoldingCreationPlan =
  | StoredHoldingCreationPlan
  | AppreciatingHoldingCreationPlan
  | DebtHoldingCreationPlan
  | InvestmentHoldingCreationPlan;

/** The four families the plan (and the confirm dispatch) discriminates on. */
export type HoldingCreationFamily = HoldingCreationPlan["family"];
