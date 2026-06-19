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
  /** Present only when a connected source materialized this holding. */
  sourceSummary?: AgentViewHoldingSourceSummary;
  /** Present only for an appreciating asset that has valuation anchors (#338). */
  valuationAnchors?: AgentViewValuationAnchor[];
  /** Present only for an amortized liability that has an amortization plan (#338). */
  amortization?: AgentViewAmortizationFacts;
  /** Present only for an anchored liability that has balance anchors (#338). */
  balanceAnchors?: AgentViewBalanceAnchorFacts;
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
 * A full explanation of one current figure for a selected scope (PRD #328, #343):
 * its value, the human-readable formula and operand figures, the holdings that
 * contributed (with scope-weighted values), the holdings held out (with a reason),
 * the assumptions a FIRE figure rests on, freshness facts where they apply, the
 * relevant data-quality notes, and drilldown links. Reads mutate nothing. FIRE
 * figures use CURRENT assumptions only — never an implied historical FIRE.
 */
export interface AgentViewFigureExplanation {
  scope: AgentViewScope;
  /** The date the explained value describes, as `YYYY-MM-DD` (always current). */
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
