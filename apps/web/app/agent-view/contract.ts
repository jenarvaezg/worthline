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
