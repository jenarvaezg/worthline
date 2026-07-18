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

import type { DebtModel, Instrument, OwnershipShare } from "@worthline/domain";

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
 * Appreciating asset (property / real_estate): persists through the housing
 * seam with an acquisition anchor dated today at the declared current value.
 */
export interface AppreciatingHoldingCreationPlan extends HoldingCreationPlanBase {
  family: "appreciating";
  /** The current value in minor units — acquisition value + anchor, dated today. */
  currentValueMinor: number;
  isPrimaryResidence: boolean;
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
  /** The opening BUY dated today (units × price = value), when the user declared it. */
  opening?: { units: string; pricePerUnit: string; valueMinor: number };
}

/** The declarative alta plan the `holding_creation` fact carries, by family. */
export type HoldingCreationPlan =
  | StoredHoldingCreationPlan
  | AppreciatingHoldingCreationPlan
  | DebtHoldingCreationPlan
  | InvestmentHoldingCreationPlan;

/** The four families the plan (and the confirm dispatch) discriminates on. */
export type HoldingCreationFamily = HoldingCreationPlan["family"];
