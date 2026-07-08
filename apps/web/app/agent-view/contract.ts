import type {
  IrrReason,
  GoalPriority,
  PayoutCadence,
  PriceFreshnessState,
  RiskTolerance,
  TwrReason,
  WorkspaceMode,
} from "@worthline/domain";

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
  object: "member" | "member_group" | "scope" | "holding" | "connected_source";
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
 * The freshness of a connected source's last valuation (PRD #328, #339), derived
 * from the staleness signal `revaluePositions` stamps. `fresh` is a clean
 * valuation; `stale` is a degraded one still serving its last-known value;
 * `failed` is a fetch error; `manual` is a hand-set value. Secret-free — it never
 * carries a provider payload or token.
 */
export type AgentViewSourceFreshnessStatus = "fresh" | "stale" | "failed" | "manual";

/**
 * The freshness facts of a connected source (PRD #328, #339): its status, the
 * last successful sync (when one is recorded), and the last failed/degraded
 * signal (when one is recorded). All optional — a never-valued source reports
 * only an `unknown` status.
 */
export interface AgentViewSourceFreshnessSummary {
  /** `unknown` until the source has been valued at least once. */
  status: AgentViewSourceFreshnessStatus | "unknown";
  /** When the source last synced successfully, as ISO; absent until first sync. */
  lastSuccessfulSyncAt?: string;
  /** When the last fetch failed/degraded, with its reason; absent when clean. */
  lastFailedSync?: {
    at: string;
    reason?: string;
  };
}

/**
 * A connected source backing some of the scope's holdings (PRD #328, #339).
 * Never includes credentials or tokens. The full position lens lives in the
 * #339 drilldown. The public `id` is derived from the stable internal source id.
 */
export interface AgentViewConnectedSourceSummary {
  id: string;
  object: "connected_source";
  label: string;
  adapter: string;
  lastSyncAt: string | null;
  /** Freshness facts: status, last successful sync, last failed sync (#339). */
  freshness: AgentViewSourceFreshnessSummary;
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

/**
 * How completely a look-through dimension covers the scope's gross assets, as a
 * three-way split of money (PRD #539, ADR 0039): `classified` has profile data,
 * `notApplicable` means the dimension is meaningless for the instrument
 * (geography/currency of cash or crypto), and `unknown` means the dimension
 * applies but no profile is entered. Keeping `notApplicable` distinct stops
 * crypto/cash from reading as missing data — only `unknown` is a gap to fill.
 * The slices never pretend to cover 100%; the coverage is how the agent reports
 * "X% classified, Y% still unknown".
 */
export interface AgentViewExposureCoverage {
  classified: AgentViewMoney;
  notApplicable: AgentViewMoney;
  unknown: AgentViewMoney;
}

/**
 * One look-through dimension (geography / currency / asset class): the allocation
 * slices (same `AgentViewAllocationSlice` shape as `byInstrument`) plus the
 * three-way coverage they were computed against (PRD #539, ADR 0039).
 */
export interface AgentViewExposureDimension {
  slices: AgentViewAllocationSlice[];
  coverage: AgentViewExposureCoverage;
}

/** Where the scope's money sits and how concentrated it is. */
export interface AgentViewExposure {
  topHoldings: AgentViewExposureHolding[];
  byLiquidityTier: AgentViewAllocationSlice[];
  byInstrument: AgentViewAllocationSlice[];
  /**
   * Present-time look-through by underlying geography (PRD #539, ADR 0039): the
   * portfolio's real region exposure, aggregated from exposure profiles by the
   * S0 domain function — never a figure and never frozen into a snapshot.
   */
  byGeography: AgentViewExposureDimension;
  /** Present-time look-through by underlying currency (PRD #539, ADR 0039). */
  byCurrency: AgentViewExposureDimension;
  /** Present-time look-through by asset class (PRD #539, ADR 0039). */
  byAssetClass: AgentViewExposureDimension;
  /**
   * The currency-risk lens (PRD #539, ADR 0039): the unhedged, non-base-currency
   * share of the portfolio, by currency. Informational exposure only — worthline
   * assumes the base currency for every figure, so this changes no valuation.
   */
  currencyRisk: AgentViewAllocationSlice[];
  concentration: {
    /** Largest single holding's weight of gross assets. */
    topHoldingWeight: string;
    /** Combined weight of the top five holdings. */
    topFiveWeight: string;
  };
}

/**
 * A security's resolved exposure profile as the holding detail exposes it (PRD
 * #539, ADR 0039): the tracked index, TER, hedged flag, and the per-dimension
 * breakdown vectors (`bucket → weight` decimal strings). Reference metadata, not
 * a figure — it never touches net worth, snapshots, or ripple. A holding with no
 * profile (or an instrument that takes none) reports `exposureProfile: null`; the
 * absence is signalled honestly and a profile is never fabricated.
 */
export interface AgentViewExposureProfile {
  trackedIndex: string | null;
  ter: string | null;
  hedged: boolean;
  breakdowns: {
    geography?: Record<string, string>;
    currency?: Record<string, string>;
    assetClass?: Record<string, string>;
  };
}

export interface AgentViewReturnQualitySignal {
  code: "DISTRIBUTIONS_NOT_CAPTURED" | "TWR_STARTS_AFTER_FIRST_OPERATION";
  severity: AgentViewDataQualitySeverity;
  label: string;
  firstOperationDate?: string;
  twrStartDate?: string;
}

export interface AgentViewSimpleReturn {
  totalGain: AgentViewMoney;
  totalInvested: AgentViewMoney;
  totalReturnRatio: string | null;
  annualized: boolean;
  cagr: string | null;
  realizedGain?: AgentViewMoney;
  unrealizedGain?: AgentViewMoney;
}

export interface AgentViewMoneyWeightedReturn {
  rate: string | null;
  reason: IrrReason | null;
}

export interface AgentViewTimeWeightedReturn {
  rate: string | null;
  annualizedRate: string | null;
  annualized: boolean;
  startDate: string | null;
  endDate: string | null;
  reason: TwrReason | null;
}

/**
 * One asset class's blended returns (PRD #552, ADR 0040 fast-follow): the three
 * measures over the fractional, present-time slice every operation-bearing market
 * holding contributes to the class. `key` is an asset-class bucket (`equity`,
 * `bond`, …), `other` (a breakdown's declared-under-100% remainder), or
 * `unclassified` (a holding with no resolvable class). Reference lens, never a
 * figure — a present-time decomposition of the portfolio returns.
 */
export interface AgentViewAssetClassReturns {
  key: string;
  value: AgentViewMoney;
  simple: AgentViewSimpleReturn;
  moneyWeighted: AgentViewMoneyWeightedReturn;
  timeWeighted: AgentViewTimeWeightedReturn;
}

/**
 * Per-asset-class returns for the portfolio (PRD #552): one entry per class the
 * operation-bearing market holdings resolve to, plus the three-way coverage of
 * attributed value (asset class has no `notApplicable`, so it splits classified
 * vs unknown). Present only on the portfolio returns block — a single holding has
 * one class, not a breakdown.
 */
export interface AgentViewAssetClassReturnsBlock {
  classes: AgentViewAssetClassReturns[];
  coverage: AgentViewExposureCoverage;
}

export interface AgentViewReturns {
  simple: AgentViewSimpleReturn;
  moneyWeighted: AgentViewMoneyWeightedReturn;
  timeWeighted: AgentViewTimeWeightedReturn;
  qualitySignals: AgentViewReturnQualitySignal[];
  /** Present-time per-asset-class decomposition (portfolio block only, PRD #552). */
  byAssetClass?: AgentViewAssetClassReturnsBlock;
}

/**
 * One recorded payout — a dividend, interest, or rent a holding paid its owner
 * (PRD #652, ADR 0054). A pure attribution record, never a figure: reading it
 * touches no net worth, holding value, snapshot, or ripple. `id` is an opaque,
 * export/import-stable drilldown id (`wl_pay_…`) derived from the payout's stable
 * internal id — no registry write, exactly like an operation's id (ADR 0023).
 */
export interface AgentViewPayout {
  id: string;
  object: "payout";
  date: string;
  amount: AgentViewMoney;
  note?: string;
}

/**
 * A declared payout schedule — a fixed recurrence like rent (PRD #652, ADR 0054).
 * Only the DECLARATION is exposed (amount, cadence, start, optional inclusive end,
 * per-occurrence exclusions); occurrences are derived on read by the domain and are
 * never materialized, so none are surfaced here. `id` is an opaque, stable
 * drilldown id (`wl_psc_…`) derived from the schedule's internal id.
 */
export interface AgentViewPayoutSchedule {
  id: string;
  object: "payout_schedule";
  label: string;
  cadence: PayoutCadence;
  amount: AgentViewMoney;
  startDate: string;
  /** Inclusive end date, or null for an open-ended schedule. */
  endDate: string | null;
  /** ISO dates removed one by one (an unpaid month). */
  exclusions: string[];
}

/**
 * A trailing-window passive-income aggregate (PRD #652). Honest by construction:
 * the sum of every payout dated inside the window — one-offs plus each schedule's
 * derived occurrences — with the window bounds and the occurrence count stated, and
 * nothing annualized. The lower bound is exclusive and the upper (today) inclusive.
 */
export interface AgentViewPassiveIncomeWindow {
  total: AgentViewMoney;
  count: number;
  windowStart: string;
  windowEnd: string;
  months: number;
}

/**
 * A holding's payouts as the agent view sees them (PRD #652, #659): its recorded
 * one-off payouts, its declared schedules, and a trailing-12-month aggregate. Full
 * (household) amounts — NOT scope-weighted — matching the holding detail's
 * `currentValue`, which is the full household value. Present only when the holding
 * has at least one payout or schedule; otherwise the block is null.
 */
export interface AgentViewHoldingPayouts {
  recorded: AgentViewPayout[];
  schedules: AgentViewPayoutSchedule[];
  trailing12m: AgentViewPassiveIncomeWindow;
}

/**
 * A scope's passive-income lens (PRD #652, #658/#659): the selected scope's
 * trailing-12-month payouts weighted by its ownership share, and coverage against
 * declared spending. Mirrors the /objetivos "renta pasiva" lens (`scopePassiveIncome`).
 * `annualSpending`/`coverageRatio` are null when spending is unknown — coverage is
 * never fabricated, and a partial-window payout is summed as-is, never annualized.
 */
export interface AgentViewScopePassiveIncome {
  total: AgentViewMoney;
  count: number;
  windowStart: string;
  windowEnd: string;
  months: number;
  /** Declared annual spending (monthly × 12) as money, or null when unknown. */
  annualSpending: AgentViewMoney | null;
  /** `total / annualSpending` as a decimal string, or null when spending is unknown. */
  coverageRatio: string | null;
  /** Whether the scope has any recorded payout at all (drives an empty state). */
  hasPayouts: boolean;
}

/** Whether a scope has a FIRE configuration (PRD #328, #340). */
export type AgentViewFireStatus = "configured" | "unconfigured";

/**
 * The FIRE assumptions a scope's figures rest on (PRD #328, #340). Rates are
 * `0..1` decimal strings (e.g. `"0.04"`); `monthlySpending` is the configured
 * monthly drawdown as money.
 */
export interface AgentViewFireAssumptions {
  safeWithdrawalRate: string;
  expectedRealReturn: string;
  monthlySpending: AgentViewMoney;
}

/**
 * The compact FIRE summary folded into the main financial context (PRD #328,
 * #340). When `status` is `unconfigured` only the status is present — no figures
 * are fabricated. When `configured`, `progressRatio` is `eligibleAssets /
 * fireNumber` as a non-negative decimal string (exceeds `1` once over-funded)
 * and `gap` is `fireNumber − eligibleAssets` (signed: negative once over-funded).
 */
export interface AgentViewFireSummary {
  status: AgentViewFireStatus;
  /** Present only when configured: `eligibleAssets / fireNumber` as a non-negative decimal string (`>1` once over-funded). */
  progressRatio?: string;
  /** Present only when configured. */
  fireNumber?: AgentViewMoney;
  /** Present only when configured: the scope-weighted FIRE-eligible total. */
  eligibleAssets?: AgentViewMoney;
  /** Present only when configured: `fireNumber − eligibleAssets`, signed. */
  gap?: AgentViewMoney;
  /** Present only when configured. */
  assumptions?: AgentViewFireAssumptions;
}

/**
 * The data-quality taxonomy a signal falls under (PRD #328, #341):
 *  - `warning`: a domain warning (`collectWarnings`), blocking or overrideable.
 *  - `price_freshness`: a priced asset's stale/failed/missing price quote.
 *  - `source_freshness`: a connected source's stale/failed last sync.
 *  - `missing_configuration`: a scope/holding missing the config it needs (FIRE
 *    config, an amortized liability's debt model, …).
 *  - `history_coverage`: sparse snapshots or a snapshot with no frozen holding rows.
 *  - `projection_gap`: a connected-source position that could not be valued.
 */
export type AgentViewDataQualityCategory =
  | "warning"
  | "price_freshness"
  | "source_freshness"
  | "missing_configuration"
  | "history_coverage"
  | "projection_gap";

/**
 * The agent-view severity scale a data-quality signal normalizes to (PRD #328,
 * #341): `high` is a blocking/failed condition, `medium` a degraded/overrideable
 * one, `low` an informational note. Mapped consistently across categories — see
 * `data-quality.ts` for the exact mapping per source.
 */
export type AgentViewDataQualitySeverity = "high" | "medium" | "low";

/**
 * One normalized data-quality signal (PRD #328, #341). The shape is uniform
 * across every category so an agent reasons about data quality the same way
 * regardless of source. The public `id` is derived from a stable natural key
 * (`category:code:affectedEntityId`), so it survives export/import and never
 * churns on row order. Side-effect-free — surfacing a `warning` signal never
 * writes an override.
 */
export interface AgentViewDataQualitySignal {
  id: string;
  object: "data_quality_signal";
  category: AgentViewDataQualityCategory;
  severity: AgentViewDataQualitySeverity;
  /** Human-readable description of the issue. */
  label: string;
  /** Stable machine-readable code (e.g. `STALE_PRICE`, `MISSING_FIRE_CONFIG`). */
  code: string;
  /** Whether the user can fix this in worthline (vs. a provider-side condition). */
  fixable: boolean;
  /** The object the signal concerns; omitted for purely scope-global signals. */
  affected?: AgentViewObjectReference;
  /** Date the condition was observed, as `YYYY-MM-DD` (e.g. a stale-price date). */
  observedDate?: string;
  /** The original domain warning `code`, present only for `warning` signals. */
  originalWarningType?: string;
}

/**
 * The data-quality summary folded into the main financial context (PRD #328,
 * #341): counts of the scope's signals by severity and by category, plus the top
 * `N` highest-severity signals in the canonical stable order. The full,
 * filterable, paginated list lives at the `data-quality` drilldown.
 */
export interface AgentViewDataQualitySummary {
  countsBySeverity: Record<AgentViewDataQualitySeverity, number>;
  countsByCategory: Record<AgentViewDataQualityCategory, number>;
  /** The top highest-severity signals (PRD #328: top 10), in stable order. */
  topSignals: AgentViewDataQualitySignal[];
}

export interface AgentViewVsInflation {
  comparison: {
    netWorthGrowth: number;
    cpiGrowth: number;
    realGrowth: number;
    sinceDate: string;
    untilDate: string;
  } | null;
  unavailableReason: "benchmark_unavailable" | "zero_start_value" | null;
  coverage: {
    source: "IPC-ES";
    cadence: "monthly";
  };
}

/** Cursor-paginated data-quality signals for a scope (PRD #328, #341). */
export interface AgentViewDataQualityPage {
  signals: AgentViewDataQualitySignal[];
  meta: AgentViewPaginationMeta;
}

/** Compact current-state package for a selected scope (PRD #328, #335). */
export interface AgentViewFinancialContext {
  scope: AgentViewScope;
  asOf: string;
  baseCurrency: string;
  summary: AgentViewFinancialSummary;
  liquidityBreakdown: AgentViewLiquidityRung[];
  exposure: AgentViewExposure;
  /** Present-time investment returns for operation-bearing market holdings. */
  returns: AgentViewReturns | null;
  vsInflation: AgentViewVsInflation;
  /** The scope's trailing-12m passive income (renta pasiva), scope-weighted (#659). */
  passiveIncome: AgentViewScopePassiveIncome;
  holdings: AgentViewHoldingsBlock;
  connectedSources: AgentViewConnectedSourceSummary[];
  /** The scope's FIRE progress summary; status-only when unconfigured (#340). */
  fire: AgentViewFireSummary;
  /** The scope's data-quality summary: counts + the top signals (#341). */
  dataQuality: AgentViewDataQualitySummary;
  /** Drilldown endpoints for deeper facts (snapshots, FIRE, data quality, trash). */
  links: Record<string, string>;
}

/**
 * One asset held out of a scope's FIRE-eligible total (PRD #328, #340). The
 * `holding` reference carries the registry `wl_hld_` id; `reason` is the asset's
 * own primary-residence flag or a manual exclusion in the FIRE config.
 */
export interface AgentViewFireExcludedAsset {
  holding: AgentViewObjectReference;
  reason: "primary_residence" | "manual";
}

/** A scope's stored FIRE configuration (PRD #328, #340). */
export interface AgentViewFireConfig {
  monthlySpending: AgentViewMoney;
  safeWithdrawalRate: string;
  expectedRealReturn: string;
  currentAge?: number;
  targetRetirementAge?: number;
  /**
   * Editable monthly savings capacity (PRD #421, #425): the contribution the
   * FIRE projection assumes. Present only when the user has set it; absent means
   * the projection treats it as zero (the UI offers a history-based suggestion).
   */
  monthlySavingsCapacity?: AgentViewMoney;
}

/**
 * The computed FIRE result for a scope (PRD #328, #340). `progressRatio` is
 * `eligibleAssets / fireNumber` as a non-negative decimal string (`>1` once
 * over-funded); `gap` is `fireNumber − eligibleAssets` (signed). Coast-FIRE facts appear only when the config
 * carries an age (so they can be computed honestly).
 */
export interface AgentViewFireResult {
  fireNumber: AgentViewMoney;
  eligibleAssets: AgentViewMoney;
  gap: AgentViewMoney;
  progressRatio: string;
  /**
   * Capital reserved for goals due before FIRE (PRD #421, #426), already
   * subtracted from `eligibleAssets`. Present only when it is non-zero — it
   * affects FIRE only, never gross assets / net worth / liquid net worth.
   */
  reservedForGoals?: AgentViewMoney;
  /** Present only when the config carries an age. */
  coastFireRequired?: AgentViewMoney;
  /** Present only when a coast-FIRE age could be derived. */
  coastFireAge?: number;
  /** Present only when the config carries an age. */
  isAlreadyAtCoastFire?: boolean;
}

/**
 * A data-quality-style signal on a FIRE-context read (PRD #328, #340). The full
 * taxonomy is issue #341; here it surfaces the one honest signal this endpoint
 * can raise — a scope with no FIRE configuration.
 */
export interface AgentViewFireQualitySignal {
  category: "missing_configuration";
  message: string;
}

/**
 * The full FIRE context for a scope (PRD #328, #340). When `status` is
 * `unconfigured`, `config`/`result` are absent and a `missing_configuration`
 * quality signal is raised; nothing is invented. Historical FIRE is unsupported
 * — any dated request is a documented `422`.
 */
export interface AgentViewFireContext {
  scope: AgentViewScope;
  status: AgentViewFireStatus;
  /** Present only when configured. */
  config?: AgentViewFireConfig;
  /** Present only when configured. */
  result?: AgentViewFireResult;
  /** The scope-weighted FIRE-eligible total (0 when unconfigured). */
  eligibleAssetsTotal: AgentViewMoney;
  /** Assets excluded from the eligible total, with their reason. */
  excludedAssets: AgentViewFireExcludedAsset[];
  /** Present only when configured. */
  assumptions?: AgentViewFireAssumptions;
  /** Honest signals about the read (e.g. a scope with no FIRE config). */
  qualitySignals: AgentViewFireQualitySignal[];
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
  /** Present for operation-bearing market holdings; null when returns do not apply. */
  returns?: AgentViewReturns | null;
  /** Recorded payouts + declared schedules + trailing-12m; null when none (#659). */
  payouts?: AgentViewHoldingPayouts | null;
  /** Present only when a connected source materialized this holding. */
  sourceSummary?: AgentViewHoldingSourceSummary;
  /** Present only for an appreciating asset that has valuation anchors (#338). */
  valuationAnchors?: AgentViewValuationAnchor[];
  /** Present only for an amortized liability that has an amortization plan (#338). */
  amortization?: AgentViewAmortizationFacts;
  /** Present only for an anchored liability that has balance anchors (#338). */
  balanceAnchors?: AgentViewBalanceAnchorFacts;
  /**
   * The security's resolved exposure profile (PRD #539, ADR 0039). `null`/absent
   * honestly signals "no profile here" — a holding whose instrument takes no
   * profile, or one with no hand-entered profile. Never a fabricated profile.
   */
  exposureProfile?: AgentViewExposureProfile | null;
}

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

/**
 * Which figure produced a connected-source position's value (PRD #328, #339):
 *  - `metal`/`numismatic`: a coin's frozen `max(metal, numismatic)` candidate.
 *  - `purchase`: the coin's recorded purchase price (the fallback when neither
 *    candidate is known).
 *  - `market`: a token's live `balance × unitPrice`.
 *  - `unvalued`: no value could be derived (an unpriced token or a coin with no
 *    candidate and no purchase price) — the position is reported at value 0 with
 *    a quality signal, never silently dropped.
 */
export type AgentViewPositionValuationBasis =
  | "metal"
  | "numismatic"
  | "purchase"
  | "market"
  | "unvalued";

/**
 * One connected-source position projected into a holding/rung (PRD #328, #339).
 * Polymorphic over the adapter via `kind`, but the agent-view shape is uniform:
 * a `quantity` (coin count or token balance, as a decimal string), an optional
 * `unitPrice` (known only for live-valued tokens), the derived `value`, and the
 * `valuationBasis` that produced it. The public `id` is derived from the source's
 * STABLE per-line id, so it survives a re-sync (PRD #328). Never carries a
 * credential, token, or raw provider payload.
 */
export interface AgentViewConnectedSourcePosition {
  id: string;
  object: "connected_source_position";
  kind: "coin" | "token";
  /** The provider tag (`numista` / `binance`). */
  adapter: string;
  /** The connected source's display label. */
  sourceLabel: string;
  /** The holding/rung this position projects into. */
  projectedHolding: AgentViewObjectReference;
  liquidityTier: AgentViewLiquidityTier;
  /** Display name for the line (coin name / token symbol). */
  label: string;
  /** Grouping metadata for the source-scoped lens: a coin's metal, a token's symbol. */
  groupKey: string | null;
  /** Coin count or token balance, as a decimal string. */
  quantity: string;
  /** Live unit price (decimal string), present only when a token price is known. */
  unitPrice?: string;
  value: AgentViewMoney;
  valuationBasis: AgentViewPositionValuationBasis;
  /** The valuing source's freshness, when the source has been valued. */
  freshness?: AgentViewSourceFreshnessSummary;
  /** Honest signals about the line (e.g. an unpriced token valued at 0). */
  qualitySignals: string[];
}

/**
 * One group of a source-scoped positions response (PRD #328, #339): the projected
 * holding/rung and the positions that landed in it, with the group's summed value.
 */
export interface AgentViewConnectedSourcePositionGroup {
  projectedHolding: AgentViewObjectReference;
  liquidityTier: AgentViewLiquidityTier;
  /** Summed value of the group's positions. */
  groupValue: AgentViewMoney;
  positions: AgentViewConnectedSourcePosition[];
}

/** Cursor-paginated connected-source positions for one holding/rung (PRD #328, #339). */
export interface AgentViewConnectedSourcePositionPage {
  positions: AgentViewConnectedSourcePosition[];
  meta: AgentViewPaginationMeta;
}

/**
 * Cursor-paginated connected-source positions for one source, grouped by their
 * projected holding/rung (PRD #328, #339). Pagination walks a stable
 * (holding, rung, position) order; a group can span page boundaries.
 */
export interface AgentViewConnectedSourcePositionGroupPage {
  groups: AgentViewConnectedSourcePositionGroup[];
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

/**
 * The read-only restore / hard-delete facts of a trashed holding (PRD #328, #342).
 * Both flags are static truths about a trashed holding — it CAN be restored or
 * hard-deleted — surfaced so an agent knows what is recoverable. The agent view
 * itself never restores or hard-deletes; these are facts, not actions.
 */
export interface AgentViewTrashStatus {
  restorable: true;
  hardDeletable: true;
}

/**
 * One trashed (soft-deleted) holding outside the main financial context (PRD
 * #328, #342): a recoverable asset/liability with its public id, label, direction,
 * instrument, stored value/balance (when safely available), deleted date (when
 * recorded), and read-only restore/hard-delete status.
 */
export interface AgentViewTrashedHolding {
  id: string;
  object: "holding";
  label: string;
  direction: AgentViewHoldingDirection;
  instrument: string;
  /** Stored value (asset) / balance (liability); omitted when not safely available. */
  value?: AgentViewMoney;
  /** `YYYY-MM-DD` the holding was trashed; omitted when no stamp is recorded. */
  deletedDate?: string;
  status: AgentViewTrashStatus;
}

/** Cursor-paginated trash summary for a scope (PRD #328, #342). */
export interface AgentViewTrashSummary {
  holdings: AgentViewTrashedHolding[];
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

/**
 * A holding's cached-price freshness (#466, PRD #417 S2): the staleness state of
 * its price-cache row, when it was last fetched, the providing source, and the
 * degraded/failed reason when one is recorded. Secret-free by construction — it
 * carries no price figure, no provider payload, and no token. `freshness` is null
 * when the holding has no cached provider quote (a manual or derived holding): a
 * documented "no provider quote here" shape, never a guessed freshness.
 */
export interface AgentViewPriceFreshnessResult {
  object: "price_freshness";
  /** The holding this freshness describes (echoed public `wl_hld_…`). */
  holding: string;
  freshness: {
    freshnessState: PriceFreshnessState;
    /** When the price was last fetched, as ISO. */
    fetchedAt: string;
    /** The provider that supplied the cached price. */
    source: string;
    /** Why the last fetch is degraded, when recorded. */
    staleReason?: string;
  } | null;
}

/**
 * A connected source as `list_connected_sources` exposes it (#465, PRD #417 S1):
 * its opaque public id (`wl_src_…`), adapter, label, last sync time, and the
 * public holding IDs (`wl_hld_…`) it materializes — one per occupied rung.
 * Secret-free by construction — never a credential, token, or raw provider
 * payload. Freshness lives in the dedicated `get_source_freshness` tool.
 */
export interface AgentViewConnectedSourceListEntry {
  id: string;
  object: "connected_source";
  adapter: string;
  label: string;
  lastSyncAt: string | null;
  /** The public holding IDs (`wl_hld_…`) this source materializes, one per occupied rung. */
  holdings: string[];
}

/**
 * A connected source's valuation freshness (#465, PRD #417 S1): the staleness
 * state of its primary price-cache row, when it was last fetched, and the
 * degraded/failed reason when one is recorded. Secret-free — no credential,
 * token, or provider payload. `freshness` is null when the source has never been
 * valued: a documented "never valued" shape, never a guess.
 */
export interface AgentViewSourceFreshnessResult {
  object: "source_freshness";
  /** The source this freshness describes (echoed public `wl_src_…`). */
  source: string;
  freshness: {
    freshnessState: PriceFreshnessState;
    /** When the value was last fetched, as ISO. */
    fetchedAt: string;
    /** Why the last fetch is degraded, when recorded. */
    staleReason?: string;
  } | null;
}

/**
 * The workspace's settings as `get_workspace` exposes them (#467, PRD #417 S3):
 * its mode (individual vs household) and base currency, so the assistant matches
 * the workspace instead of assuming household/EUR. Both are null until the
 * workspace is provisioned — a documented uninitialized shape, never a guess.
 */
export interface AgentViewWorkspaceInfo {
  object: "workspace";
  mode: WorkspaceMode | null;
  baseCurrency: string | null;
}

/**
 * A member's profile as `get_member_profile` exposes it (PRD #421, #423): the
 * public member ID, name, and the optional profile fields used to personalize
 * advice. Each field is `null` until set. This is the only surface these PII
 * fields reach — they are never in a public endpoint.
 */
export interface AgentViewMemberProfile {
  object: "member_profile";
  id: string;
  name: string;
  /** Reference year of birth; the projection derives age from it. */
  birthYear: number | null;
  /** ISO 3166-1 alpha-2 fiscal country (e.g. "ES"), for tax-aware suggestions. */
  fiscalCountry: string | null;
  riskTolerance: RiskTolerance | null;
}

/**
 * An intermediate goal as `list_goals` exposes it (PRD #421, #424): its target,
 * deadline, priority, the public ids of the assigned holdings, the capital
 * currently reserved (scope-weighted `min(target, assigned value)`), and the
 * funded ratio (`reserved / target`, 0..1, capped). FIRE tools subtract only
 * future in-horizon reservations backed by FIRE-eligible assigned holdings.
 */
export interface AgentViewGoal {
  object: "goal";
  id: string;
  name: string;
  targetAmount: AgentViewMoney;
  /** ISO date (YYYY-MM-DD). */
  deadline: string;
  priority: GoalPriority;
  /** Public holding ids (wl_hld_…) assigned to the goal. */
  assignedHoldings: string[];
  /** Scope-weighted reserved capital: `min(target, value of assigned holdings)`. */
  reservedAmount: AgentViewMoney;
  /** `reserved / target` as a non-negative decimal string, capped at `"1"`. */
  fundedRatio: string;
}

/** One point of a FIRE projection's year-by-year capital trajectory (PRD #421, #427). */
export interface AgentViewFireTrajectoryPoint {
  /** Years from today (0 = today). */
  year: number;
  eligible: AgentViewMoney;
}

/**
 * One FIRE projection scenario as `get_fire_projection` exposes it (PRD #421,
 * #427). `annualReturn` is a decimal string (e.g. `"0.065"`). `yearsToFire` /
 * `ageAtFire` are `null` when FIRE is not reached within the horizon (or no age
 * is configured).
 */
export interface AgentViewFireScenario {
  label: "optimistic" | "base" | "pessimistic";
  annualReturn: string;
  yearsToFire: number | null;
  ageAtFire: number | null;
  finalEligible: AgentViewMoney;
  totalContributed: AgentViewMoney;
  trajectory: AgentViewFireTrajectoryPoint[];
}

/**
 * A scope's FIRE projection as `get_fire_projection` exposes it (PRD #421,
 * #427): optimistic/base/pessimistic scenarios over the FIRE number, using the
 * configured monthly savings capacity and the goal-reservation-adjusted eligible
 * assets. Goal reservations only subtract FIRE-eligible assigned holdings.
 * `unconfigured` when the scope has no FIRE config — no figures invented.
 */
export interface AgentViewFireProjection {
  object: "fire_projection";
  scope: AgentViewScope;
  status: AgentViewFireStatus;
  /** Present only when configured. */
  fireNumber?: AgentViewMoney;
  /** The monthly contribution assumed; present only when set on the config. */
  monthlySavingsCapacity?: AgentViewMoney;
  /** `[optimistic, base, pessimistic]` when configured; empty when not. */
  scenarios: AgentViewFireScenario[];
}

/**
 * An acknowledged overrideable warning as `get_warning_overrides` exposes it
 * (#467, PRD #417 S3): the warning code and the public holding ID (`wl_hld_…`)
 * whose warning was silenced, so the assistant can explain which warning was
 * overridden and where. Surfacing an override never writes one (pure read).
 */
export interface AgentViewWarningOverride {
  object: "warning_override";
  code: string;
  /** The holding (`wl_hld_…`) whose warning was acknowledged. */
  holding: string;
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
