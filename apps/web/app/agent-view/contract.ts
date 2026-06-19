export interface AgentViewEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
  links?: Record<string, string>;
}

export interface AgentViewErrorEnvelope {
  error: {
    code: AgentViewErrorCode;
    message: string;
    details?: unknown;
  };
}

export type AgentViewErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "unprocessable_entity"
  | "internal_error";

export type AgentViewScopeType = "household" | "member" | "group";

export interface AgentViewObjectReference {
  id: string;
  object: "member" | "member_group" | "scope" | "holding";
  label: string;
}

export interface AgentViewScope {
  id: string;
  object: "scope";
  type: AgentViewScopeType;
  label: string;
  members: AgentViewObjectReference[];
  isDefault: boolean;
}

/** Money is always minor units plus currency so calculations stay exact. */
export interface AgentViewMoney {
  amountMinor: number;
  currency: string;
}

/** Current headline figures for the selected scope. */
export interface AgentViewFinancialSummary {
  netWorth: AgentViewMoney;
  liquidNetWorth: AgentViewMoney;
  grossAssets: AgentViewMoney;
  debts: AgentViewMoney;
  housingEquity: AgentViewMoney;
}

export type AgentViewLiquidityTier =
  | "cash"
  | "market"
  | "term-locked"
  | "illiquid"
  | "housing";

/** One liquidity rung's aggregate for the selected scope. */
export interface AgentViewLiquidityRung {
  tier: AgentViewLiquidityTier;
  netValue: AgentViewMoney;
  grossAssets: AgentViewMoney;
  debts: AgentViewMoney;
  /** This rung's share of the scope's gross assets, as a `0..1` decimal string. */
  shareOfGross: string;
}

export type AgentViewHoldingDirection = "asset" | "liability";

/** One owner's stake in a holding, as a `0..1` decimal-string share. */
export interface AgentViewOwnershipShare {
  member: AgentViewObjectReference;
  share: string;
}

/**
 * Folded investment-operation facts for a holding. Units are decimal strings;
 * amounts are raw ledger totals (not scope-weighted). Full rows live in
 * `get_operations` (#337).
 */
export interface AgentViewOperationSummary {
  operationCount: number;
  firstOperationDate: string;
  latestOperationDate: string;
  unitsBought: string;
  unitsSold: string;
  grossBuyAmount: AgentViewMoney;
  grossSellAmount: AgentViewMoney;
  feesTotal: AgentViewMoney;
}

/** A scope-weighted holding summary in the compact context. */
export interface AgentViewHoldingSummary {
  id: string;
  object: "holding";
  direction: AgentViewHoldingDirection;
  label: string;
  instrument: string;
  valuationMethod: string;
  liquidityTier: AgentViewLiquidityTier;
  currentValue: AgentViewMoney;
  ownership: AgentViewOwnershipShare[];
  /** Present only for investment holdings with recorded operations. */
  operationSummary?: AgentViewOperationSummary;
}

/**
 * A connected source backing some of the scope's holdings. Never includes
 * credentials or tokens. Positions live in the #339 drilldown.
 */
export interface AgentViewConnectedSourceSummary {
  label: string;
  adapter: string;
  lastSyncAt: string | null;
  projectedHoldings: AgentViewObjectReference[];
}

/** Summarized holdings plus the cap facts (PRD #328 main-context caps). */
export interface AgentViewHoldingsBlock {
  items: AgentViewHoldingSummary[];
  /** The effective holding cap applied (default 25, max 100). */
  limit: number;
  /** Holdings dropped by the cap. */
  omittedCount: number;
  /** Summed current value of the dropped holdings. */
  omittedTotalValue: AgentViewMoney;
}

/** A holding/instrument/rung allocation slice with its weight of gross assets. */
export interface AgentViewAllocationSlice {
  key: string;
  value: AgentViewMoney;
  /** Slice value over gross assets, as a `0..1` decimal string. */
  weight: string;
}

/** A top holding in the exposure summary. */
export interface AgentViewExposureHolding {
  id: string;
  object: "holding";
  label: string;
  value: AgentViewMoney;
  weight: string;
}

/** Where the scope's money sits and how concentrated it is. */
export interface AgentViewExposure {
  topHoldings: AgentViewExposureHolding[];
  byLiquidityTier: AgentViewAllocationSlice[];
  byInstrument: AgentViewAllocationSlice[];
  concentration: {
    /** Largest single holding's weight of gross assets. */
    topHoldingWeight: string;
    /** Combined weight of the top five holdings. */
    topFiveWeight: string;
  };
}

/** Compact current-state package for a selected scope (PRD #328, #335). */
export interface AgentViewFinancialContext {
  scope: AgentViewScope;
  asOf: string;
  baseCurrency: string;
  summary: AgentViewFinancialSummary;
  liquidityBreakdown: AgentViewLiquidityRung[];
  exposure: AgentViewExposure;
  holdings: AgentViewHoldingsBlock;
  connectedSources: AgentViewConnectedSourceSummary[];
  /** Drilldown endpoints for deeper facts (snapshots, FIRE, data quality, trash). */
  links: Record<string, string>;
}

/**
 * The state of a holding's deeper calculation facts (PRD #328, #338). Surfaced
 * only when a holding's configuration cannot produce the facts its valuation
 * method needs — never as a fabricated value:
 *  - `missing_configuration`: the holding's valuation method expects calculation
 *    facts (an appreciating asset's anchors, an amortized liability's plan, an
 *    anchored liability's balance anchors) but none are configured.
 *  - `unsupported`: the holding's valuation method exposes no dated calculation
 *    facts at all (stored/derived), so a deeper drilldown would have nothing to
 *    show — distinct from a configured method that is simply missing its data.
 */
export type AgentViewHoldingFactsState = "missing_configuration" | "unsupported";

/**
 * Minimal data-quality summary for a single holding (PRD #328, #337). The
 * boolean `hasWarnings` is the #341 placeholder; `facts` documents the
 * calculation-fact state when the holding cannot honestly produce them (#338).
 */
export interface AgentViewHoldingQualitySummary {
  hasWarnings: boolean;
  /** Present only when calculation facts are missing or unsupported (#338). */
  facts?: AgentViewHoldingFactsState;
}

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

/**
 * The connected source backing a single holding, when one materialized it
 * (PRD #328, #337). Never includes credentials or tokens.
 */
export interface AgentViewHoldingSourceSummary {
  label: string;
  adapter: string;
  lastSyncAt: string | null;
}

/**
 * One holding's full detail (PRD #328, #337). Reuses the compact summary's
 * fields and adds the quality summary, plus the operation summary and source
 * summary when applicable. Deep valuation/debt facts (amortization, anchors,
 * appreciation) are issue #338.
 */
export interface AgentViewHoldingDetail {
  id: string;
  object: "holding";
  direction: AgentViewHoldingDirection;
  label: string;
  instrument: string;
  valuationMethod: string;
  liquidityTier: AgentViewLiquidityTier;
  currentValue: AgentViewMoney;
  ownership: AgentViewOwnershipShare[];
  qualitySummary: AgentViewHoldingQualitySummary;
  /** Present only for investment holdings with recorded operations. */
  operationSummary?: AgentViewOperationSummary;
  /** Present only when a connected source materialized this holding. */
  sourceSummary?: AgentViewHoldingSourceSummary;
  /** Present only for an appreciating asset that has valuation anchors (#338). */
  valuationAnchors?: AgentViewValuationAnchor[];
  /** Present only for an amortized liability that has an amortization plan (#338). */
  amortization?: AgentViewAmortizationFacts;
  /** Present only for an anchored liability that has balance anchors (#338). */
  balanceAnchors?: AgentViewBalanceAnchorFacts;
}

export type AgentViewOperationSort = "date" | "-date";

/**
 * One investment operation row (PRD #328, #337). Units and price are decimal
 * strings; `grossAmount` is units × price as money (raw ledger amount, not
 * scope-weighted). `id` is derived from the stable internal operation id.
 */
export interface AgentViewOperation {
  id: string;
  object: "operation";
  /** Execution date, as `YYYY-MM-DD`. */
  date: string;
  kind: "buy" | "sell";
  units: string;
  pricePerUnit: string;
  grossAmount: AgentViewMoney;
  fees: AgentViewMoney;
}

/** Cursor-paginated operations for an investment holding (PRD #328, #337). */
export interface AgentViewOperationPage {
  operations: AgentViewOperation[];
  meta: AgentViewPaginationMeta;
}

export type AgentViewSnapshotGranularity = "monthly-close" | "raw";

export type AgentViewIncludeHoldingRows = "none" | "summary" | "full";

export type AgentViewSnapshotSort = "date" | "-date";

/** A frozen holding row behind a snapshot, exposed under `includeHoldingRows=full`. */
export interface AgentViewSnapshotHoldingRow {
  /**
   * The holding this row valued, when its public ID is still known. Absent only
   * when the underlying holding was hard-deleted; the frozen `label` still
   * identifies it.
   */
  holding?: AgentViewObjectReference;
  /** The holding's name frozen at capture time (survives later renames/deletes). */
  label: string;
  kind: AgentViewHoldingDirection;
  /** Frozen liquidity rung; `null` for an unsecured liability. */
  liquidityTier: AgentViewLiquidityTier | null;
  /** Scope-weighted value frozen that day. */
  value: AgentViewMoney;
  /** Units held — investments only. */
  units?: string;
  /** Price per unit that day — investments only, when a price was known. */
  unitPrice?: string;
}

/** One rung of a snapshot's holding-row decomposition (`includeHoldingRows=summary`). */
export interface AgentViewSnapshotTierSummary {
  tier: AgentViewLiquidityTier;
  grossAssets: AgentViewMoney;
  debts: AgentViewMoney;
  netValue: AgentViewMoney;
}

/** Compact per-rung decomposition of a snapshot's frozen holding rows. */
export interface AgentViewSnapshotHoldingsSummary {
  /** Total frozen holding rows behind this snapshot (0 for old captures with none). */
  rowCount: number;
  byLiquidityTier: AgentViewSnapshotTierSummary[];
}

/** One snapshot in the history: its frozen headline figures plus optional holding rows. */
export interface AgentViewSnapshotEntry {
  id: string;
  object: "snapshot";
  /** Calendar date of the snapshot, as `YYYY-MM-DD`. */
  date: string;
  /** Whether this snapshot is the last of its calendar month (the monthly close). */
  isMonthlyClose: boolean;
  summary: AgentViewFinancialSummary;
  /** Present only under `includeHoldingRows=summary`. */
  holdingRowsSummary?: AgentViewSnapshotHoldingsSummary;
  /** Present only under `includeHoldingRows=full`. */
  holdingRows?: AgentViewSnapshotHoldingRow[];
}

/** Cursor-paginated snapshot history for a scope (PRD #328, #336). */
export interface AgentViewSnapshotHistory {
  entries: AgentViewSnapshotEntry[];
  meta: AgentViewPaginationMeta;
}

/** Cursor-pagination metadata shared by every paginated agent-view collection. */
export interface AgentViewPaginationMeta {
  limit: number;
  hasNext: boolean;
  /** Opaque cursor for the next page; present only when `hasNext` is true. */
  nextCursor?: string;
}

export class AgentViewHttpError extends Error {
  readonly code: AgentViewErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(params: {
    code: AgentViewErrorCode;
    message: string;
    status: number;
    details?: unknown;
  }) {
    super(params.message);
    this.name = "AgentViewHttpError";
    this.code = params.code;
    this.status = params.status;
    this.details = params.details;
  }
}

export function successEnvelope<T>(data: T): AgentViewEnvelope<T> {
  return { data };
}

export function errorEnvelope(error: AgentViewHttpError): AgentViewErrorEnvelope {
  return {
    error: {
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
      message: error.message,
    },
  };
}
