import type { AgentViewDataQualitySignal } from "./data-quality";
import type { AgentViewFireAssumptions } from "./fire";
import type { AgentViewSourceFreshnessStatus } from "./holdings";
import type {
  AgentViewLiquidityRung,
  AgentViewMoney,
  AgentViewObjectReference,
  AgentViewScope,
} from "./shared";

/**
 * The current figures an agent can ask the view to explain (PRD #328, #343). A
 * path-param value outside this set is a documented `400 invalid_figure`; a value
 * in the set that the resolved scope/facts cannot honour is a `422
 * unsupported_figure`. Current-date only — a historical (dated) explanation is
 * issue #344 and is NOT served here.
 */
export type AgentViewFigureName =
  | "net_worth"
  | "liquid_net_worth"
  | "gross_assets"
  | "debts"
  | "housing_equity"
  | "liquidity_breakdown"
  | "holding_value"
  | "fire_eligible_assets"
  | "fire_progress";

/** A ratio figure carried as an exact `0..1`-style decimal string (PRD #328). */
export interface AgentViewRatioValue {
  ratio: string;
}

/**
 * The value a figure resolves to (PRD #328, #343): money for the headline
 * figures and `holding_value`, a decimal-string ratio for `fire_progress`, and
 * the per-rung breakdown for `liquidity_breakdown`.
 */
export type AgentViewFigureValue =
  | AgentViewMoney
  | AgentViewRatioValue
  | AgentViewLiquidityRung[];

/** One named input to a figure's formula, with the money it contributes. */
export interface AgentViewFigureOperand {
  label: string;
  value: AgentViewMoney;
}

/**
 * A figure's human-readable formula (PRD #328, #343): a display `expression`
 * (e.g. `"grossAssets − debts"`) plus the named operand figures it combines.
 */
export interface AgentViewFigureFormula {
  expression: string;
  operands: AgentViewFigureOperand[];
}

/** A holding that contributes to a figure, with its scope-weighted value. */
export interface AgentViewFigureIncludedHolding {
  holding: AgentViewObjectReference;
  value: AgentViewMoney;
}

/** A holding held out of a figure, with the reason it was excluded. */
export interface AgentViewFigureExcludedHolding {
  holding: AgentViewObjectReference;
  reason: string;
}

/**
 * Freshness facts attached to a figure's explanation (PRD #328, #343): how the
 * value was last sourced. Present only for `holding_value`, whose single value
 * can carry a price/source freshness; the aggregate figures span many holdings
 * and surface staleness through their `qualityNotes` instead.
 */
export interface AgentViewFigureFreshness {
  /** The valuing source's freshness state, when one is recorded. */
  status: AgentViewSourceFreshnessStatus | "unknown";
  /** When the value was last refreshed, as ISO; absent when not provider-priced. */
  asOf?: string;
  /** The provider/source the value was last sourced from, when one is recorded. */
  source?: string;
}

/**
 * The snapshot a historical explanation was read from (PRD #328, #344): the
 * derived opaque public id (`wl_snp_…`), the object tag, and the snapshot date.
 * Present only on a historical explanation; current-mode explanations omit it.
 */
export interface AgentViewFigureSnapshotReference {
  id: string;
  object: "snapshot";
  /** The snapshot date, as `YYYY-MM-DD`. */
  date: string;
}

/**
 * How completely a historical figure could be decomposed from a snapshot's frozen
 * holding rows (PRD #328, #344): `full` when the snapshot has frozen rows backing
 * the figure (included/excluded holdings are real); `partial` when the snapshot
 * stores only the headline figure (an old/legacy capture with no rows) — the value
 * is still the honest stored figure, but the per-holding decomposition is absent
 * and a `history_coverage` quality note explains why.
 */
export type AgentViewFigureDecompositionStatus = "full" | "partial";

/**
 * A full explanation of one figure for a selected scope (PRD #328, #343, #344):
 * its value, the human-readable formula and operand figures, the holdings that
 * contributed (with scope-weighted values), the holdings held out (with a reason),
 * the assumptions a FIRE figure rests on, freshness facts where they apply, the
 * relevant data-quality notes, and drilldown links. Reads mutate nothing. FIRE
 * figures use CURRENT assumptions only — never an implied historical FIRE.
 *
 * Current-mode (no `date`) explanations omit the historical fields. A historical
 * (dated, #344) explanation reads a snapshot's FROZEN rows and additionally
 * carries `historical: true`, the `snapshot` reference it was read from, and a
 * `decompositionStatus` (`full` with frozen rows, `partial` for an old snapshot
 * that stores only the headline figure).
 */
export interface AgentViewFigureExplanation {
  scope: AgentViewScope;
  /** The date the explained value describes, as `YYYY-MM-DD`. */
  asOf: string;
  figure: AgentViewFigureName;
  value: AgentViewFigureValue;
  formula: AgentViewFigureFormula;
  includedHoldings: AgentViewFigureIncludedHolding[];
  excludedHoldings: AgentViewFigureExcludedHolding[];
  /** Present only for FIRE figures: the current FIRE assumptions the value rests on. */
  assumptions?: AgentViewFireAssumptions;
  /** Present only for `holding_value`: the value's price/source freshness. */
  freshness?: AgentViewFigureFreshness;
  /** The data-quality signals relevant to this figure (subset of the #341 set). */
  qualityNotes: AgentViewDataQualitySignal[];
  /** Drilldown endpoints for deeper facts (the compact context, FIRE, …). */
  links: Record<string, string>;
  /** Present only on a historical (dated) explanation (#344): always `true`. */
  historical?: true;
  /** Present only on a historical explanation (#344): the snapshot read from. */
  snapshot?: AgentViewFigureSnapshotReference;
  /** Present only on a historical explanation (#344): `full` or `partial`. */
  decompositionStatus?: AgentViewFigureDecompositionStatus;
  /**
   * `false` when the figure is PARTIAL because at least one holding's currency could
   * not be converted to the base currency (#1065): that holding is listed in
   * `excludedHoldings` and left out of `value`, so an agent states the figure does
   * not cover everything rather than treating a non-EUR amount as EUR. Absent (the
   * common all-EUR case) means the figure is fully converted — never inferred true.
   */
  convertible?: false;
}
