import type {
  GoalPriority,
  IrrReason,
  OperationKind,
  PayoutCadence,
  PriceFreshnessState,
  ReferenceDataUnavailableReason,
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
  | "empty_workspace"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "unprocessable_entity"
  | "internal_error";

export type AgentViewScopeType = "household" | "member" | "group";

export interface AgentViewObjectReference {
  id: string;
  object:
    | "member"
    | "member_group"
    | "scope"
    | "holding"
    | "connected_source"
    /** A cartera gestionada, addressed by its public `wl_prt_…` id (ADR 0085). */
    | "managed_portfolio";
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
  /**
   * The traspaso legs, counted apart from the buys and sells (#1393). Absent when
   * the holding has none, which is the common case — and the reason it is a nested
   * object: a traspaso is neither a purchase nor a sale, so folding it into
   * `unitsBought`/`unitsSold` would report capital that was moved as capital that
   * was invested or cashed in.
   */
  transfers?: AgentViewOperationTransferSummary;
}

/** Units and gross amounts moved in and out of a holding by traspaso (#1393). */
export interface AgentViewOperationTransferSummary {
  unitsIn: string;
  unitsOut: string;
  grossInAmount: AgentViewMoney;
  grossOutAmount: AgentViewMoney;
}

/**
 * The connected source that MATERIALIZES a holding — its procedencia. Present
 * only when the holding is the projection of a `connected_sources` row; absent
 * for a hand-maintained one. Its presence means the SYNC owns the value: no
 * correction, valuation anchor, or baja may be written against that holding, and
 * the repair path is /ajustes/conexiones (sync or re-map), never a declared
 * figure.
 */
export interface AgentViewHoldingProvenance {
  /** The provider adapter behind the sync (e.g. `binance`, `numista`). */
  adapter: string;
  /** The source's human label, as the user named the connection. */
  label: string;
}

/**
 * What a holding IS, as it travels on the row (#1346): its ISIN, its
 * provider symbol, and the net units still held. Shared by the compact
 * context row, a `find_holdings` match, and `get_holding_detail`, so the three
 * reads can never quote different identities for the same holding.
 *
 * Every field is OPTIONAL and ABSENT when there is no fact for it — a missing
 * `isin` means "none registered on this holding", never "this holding has none";
 * an absent `units` means "no operation recorded here" (cash, a property, or a
 * connected-source rung whose units live in `get_connected_source_positions`),
 * while a position that sold out honestly reports `"0"`.
 *
 * The glossary reserves "identity" for `isin ?? providerSymbol`, which names the
 * INSTRUMENT; `units` is a quantity of the holding and rides along because the
 * question this exists for asks for all three in one breath.
 */
export interface AgentViewHoldingIdentity {
  /** The security's ISIN, when one is registered on the investment asset. */
  isin?: string;
  /** The price-provider lookup key (ADR 0011), when the holding has one. */
  providerSymbol?: string;
  /**
   * Net units still held, as a decimal string: buys − sells over the WHOLE ledger,
   * like the row's `operationSummary` — not clipped to the read's `asOf`.
   */
  units?: string;
}

/**
 * A scope-weighted holding summary in the compact context. Investment rows also
 * carry their instrument identity — `isin`, `providerSymbol`, `units` (#1346) —
 * so an enumeration question ("every fund with its ISIN and participaciones")
 * is answerable from THIS block with the cap raised, never from a fan-out of
 * `get_holding_detail` calls that a model abandons halfway and then reports as
 * missing data.
 */
export interface AgentViewHoldingSummary extends AgentViewHoldingIdentity {
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
  /** Present only when a connected source materializes this holding. */
  connectedSource?: AgentViewHoldingProvenance;
}

/**
 * One holding matched by name/symbol lookup (`find_holdings`). Deliberately
 * narrow: the identity a write needs (public id), what it is (instrument plus the
 * `isin`/`providerSymbol`/`units` of #1346), what it is worth, where it came from,
 * and WHY it matched — never the whole context row. It is the
 * only read that reaches a holding the compact context drops: a holding at 0 €
 * sorts last there and falls outside the default cap, which is precisely the
 * holding someone asks to delete.
 */
export interface AgentViewHoldingMatch extends AgentViewHoldingIdentity {
  id: string;
  object: "holding";
  direction: AgentViewHoldingDirection;
  label: string;
  instrument: string;
  currentValue: AgentViewMoney;
  /** Which field the query hit, so the caller can judge the match. */
  matchedOn: "label" | "providerSymbol" | "isin";
  /** Present only when a connected source materializes this holding. */
  connectedSource?: AgentViewHoldingProvenance;
  /**
   * The managed portfolio this holding belongs to (ADR 0085), when one does —
   * membership is exclusive, so there is at most ONE. Present only for members.
   */
  managedPortfolio?: AgentViewHoldingPortfolioMembership;
}

/**
 * A holding's membership in a managed portfolio (ADR 0085): which grouping owns
 * it and under what public name. The portfolio is a grouping entity, never a
 * holding — this mark says «estos fondos son uno» without pretending otherwise.
 */
export interface AgentViewHoldingPortfolioMembership {
  id: string;
  label: string;
  object: "managed_portfolio";
}

/** What a holding lookup echoes back about its own bounds — no cursor: it is a top-N. */
export interface AgentViewHoldingSearchMeta {
  /** The query as searched (trimmed), echoed so the caller can cite it. */
  query: string;
  limit: number;
  /** How many holdings matched in total, before the cap. */
  totalMatches: number;
  /** True when the cap dropped matches — narrow the query or raise `limit`. */
  truncated: boolean;
}

/** A bounded holding lookup result (`find_holdings`). */
export interface AgentViewHoldingSearchPage {
  matches: AgentViewHoldingMatch[];
  meta: AgentViewHoldingSearchMeta;
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

/**
 * A managed portfolio of this scope (ADR 0085), named with its members — the
 * «estos fondos son uno» the owner reads in his manager's app. The value is
 * derived from those members (never a stored figure); a scope's summary only
 * lists portfolios whose members are visible in it.
 */
export interface AgentViewManagedPortfolioSummary {
  id: string;
  object: "managed_portfolio";
  label: string;
  /** The manager behind the portfolio, when declared. */
  provider: string | null;
  members: AgentViewObjectReference[];
  /** The declared balance and the careo against the derived value (#1550). */
  reconciliation: AgentViewManagedPortfolioReconciliation;
}

/**
 * A managed portfolio's declared balance faced against its derived value
 * (#1550, ADR 0085). The derived figure always rules — the witness never plugs
 * or adjusts anything — and the comparison deliberately EXCLUDES the container's
 * cash, because the balance the owner reads in the manager's app is the market
 * value of the funds and the cash box grows to `150 € + 0,5 %` of the portfolio
 * before being invested.
 */
export interface AgentViewManagedPortfolioReconciliation {
  /**
   * `no_witness` (nothing declared), `not_comparable` (another currency, or a
   * member with no honest value), `aligned` (within the threshold), `diverged`
   * (past it — the state that also raises a data-quality signal).
   */
  state: "no_witness" | "not_comparable" | "aligned" | "diverged";
  /** The investment members' value: the figure the witness is careed against. */
  investmentValue: AgentViewMoney;
  /** The container's cash, reported apart and never careed. */
  cashValue: AgentViewMoney;
  declaredValue: AgentViewMoney | null;
  /** The day the declared balance was read, as `YYYY-MM-DD`. */
  declaredDate: string | null;
  /** `(derived − declared) / declared` in basis points; null without a careo. */
  driftBps: number | null;
  /** The drift beyond which the careo is declared diverged (200 bps = 2 %). */
  thresholdBps: number;
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
 * three-way split of money (PRD #539, ADR 0039, ADR 0084): `classified` has
 * declared bucket data, `notApplicable` means the dimension is meaningless for
 * that money (cash, crypto, a declared `sin_region`/`sin_divisa` sleeve), and
 * `unknown` means the dimension applies but that fraction has no declared
 * bucket. Keeping `notApplicable` distinct stops crypto/cash — and gold inside a
 * mixed fund — from reading as missing data. Only `unknown` is a gap to fill.
 * The slices never pretend to cover 100%; the coverage is how the agent reports
 * "X% classified, Y% still unknown".
 */
export interface AgentViewExposureCoverage {
  classified: AgentViewMoney;
  notApplicable: AgentViewMoney;
  unknown: AgentViewMoney;
  /**
   * Set only when the global exposure catalog could not be read (PRD #711 S3,
   * ADR 0058): the look-through / per-class returns could not classify against
   * reference data, so this coverage reflects "catalog unavailable", NOT
   * "profiles missing". Absent in the normal case where the catalog was read.
   * MCP/chat inherit this signal without re-deriving it.
   */
  catalogUnavailable?: ReferenceDataUnavailableReason;
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
   * Present-time look-through by GICS-11 sector, equity-scaled (PRD #1018, ADR
   * 0065). Unlike the whole-fund geography/currency dimensions (whose
   * undeclared remainder is `unknown`, ADR 0084), each holding's sector vector
   * is scaled by its derived equity weight: the non-equity part reads
   * `notApplicable`, and an equity sleeve the vector does not cover reads
   * `unknown`. The vector is relative to the equity sleeve, so the coverage's
   * three parts still partition gross exactly.
   */
  bySector: AgentViewExposureDimension;
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
    /**
     * The GICS-11 sector vector, relative to the instrument's equity sleeve
     * (PRD #1018, ADR 0065): weights sum to ≤ 1 over the equity part, never the
     * whole fund. Absent when the profile carries no sector data.
     */
    sector?: Record<string, string>;
  };
}

export interface AgentViewReturnQualitySignal {
  code:
    | "DISTRIBUTIONS_NOT_CAPTURED"
    /** Recorded payouts ARE in the simple gain and the IRR; the TWR is price-only (#657). */
    | "DISTRIBUTIONS_NOT_IN_TWR"
    | "TWR_STARTS_AFTER_FIRST_OPERATION";
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
  /**
   * Recorded distributions over the holding's whole life, folded into `totalGain`
   * (#657, #1627). Present only when the holding received one — the split then
   * closes: `totalGain = realizedGain + unrealizedGain + payoutIncome`. Without
   * this the dividend would sit inside the total with no line to name it, and an
   * assistant asked where the gain comes from would find a hole (#1422).
   */
  payoutIncome?: AgentViewMoney;
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
  /**
   * Present (and always `true`) when the class still holds value but not one euro
   * of it in a product of its own (#1458): every euro is a sleeve of a mixed
   * product — «el efectivo rindió un 10,4%» was the pension plans' equity sleeve
   * talking. There are no per-sleeve return series inside a mixed fund, so
   * nothing here can measure this class: the three measures below come back
   * EMPTY (rates null), the way /patrimonio prints em dashes. The blank is
   * enforced where the block is built, not asked of the reader (ADR 0067):
   * `value` and the weight are all there is to quote.
   */
  attributedOnly?: true;
  simple: AgentViewSimpleReturn;
  moneyWeighted: AgentViewMoneyWeightedReturn;
  timeWeighted: AgentViewTimeWeightedReturn;
  /**
   * Present (and always `true`) when the class holds nothing today: it is in the
   * list because it once did (#1456). Its measures still describe a real, closed
   * episode — an eight-day trade annualizes to an alarming rate that says nothing
   * about today's portfolio — so read it as history, never as present weight.
   */
  closed?: true;
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
  /**
   * Declared expenses per occurrence — SAME cadence as `amount` (#1448, ADR 0076),
   * or null when none are declared. The null is the load-bearing part (#1524): the
   * trailing window's `expenses` sums undeclared as zero, so a rent with no expenses
   * and a rent with 0 € of expenses read identically there — and they are not the
   * same thing at all. Undeclared means the FIRE engine DISCARDS this rent's return
   * and falls back to its tramo's default, which is precisely the question a user
   * asking «¿dónde introduzco los gastos?» needs answered about their own property.
   */
  expenses: AgentViewMoney | null;
}

/**
 * A trailing-window passive-income aggregate (PRD #652). Honest by construction:
 * the sum of every payout dated inside the window — one-offs plus each schedule's
 * derived occurrences — with the window bounds and the occurrence count stated, and
 * nothing annualized. The lower bound is exclusive and the upper (today) inclusive.
 */
export interface AgentViewPassiveIncomeWindow {
  /** Gross sum of the window's payouts — what arrived. */
  total: AgentViewMoney;
  /** Declared expenses of the window's occurrences (#1463); zero where undeclared. */
  expenses: AgentViewMoney;
  /** total − expenses: what the owner lives on. The headline figure on screen. */
  net: AgentViewMoney;
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
  /** Gross sum — what arrived. The screens headline `net` instead (#1463). */
  total: AgentViewMoney;
  /** Declared expenses of the window's occurrences; zero where undeclared. */
  expenses: AgentViewMoney;
  /** total − expenses: what the scope lives on. */
  net: AgentViewMoney;
  count: number;
  windowStart: string;
  windowEnd: string;
  months: number;
  /** Declared annual spending (monthly × 12) as money, or null when unknown. */
  annualSpending: AgentViewMoney | null;
  /** `net / annualSpending` (#1463) as a decimal string, or null when spending is unknown. */
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
 *  - `trashed_balance`: a holding sitting in the Papelera whose position still
 *    holds units — its value left the patrimonio at the capture after the delete,
 *    with no sale, traspaso, or deposit recorded anywhere (#1365). Literal since
 *    the traspaso kinds exist (#1481): a ledger emptied by a `transfer_out` folds
 *    to zero units and never enters this category.
 *  - `manual_value_freshness`: a stored holding whose manual value is older than
 *    the fixed threshold (90 days in v1).
 *  - `price_freshness`: a priced asset's stale/failed/missing price quote.
 *  - `source_freshness`: a connected source's stale/failed last sync, or a sync
 *    that has failed on consecutive attempts rather than merely lapsed (#1226).
 *  - `missing_configuration`: a scope/holding missing the config it needs (FIRE
 *    config, an amortized liability's debt model, …).
 *  - `history_coverage`: sparse snapshots or a snapshot with no frozen holding rows.
 *  - `transfer_integrity`: traspasos already in the ledger that no longer read as
 *    a whole pair (#1519) — an outgoing half with no destination row, or an
 *    incoming leg whose inherited cost is not the one the origin's fold removes.
 *    A lone `transfer_in` is NOT one of them: that is the external entry, whose
 *    other half lives in another institution. ONE signal per scope carrying every
 *    broken pair, never one per pair.
 *  - `projection_gap`: a connected source's positions that could not be valued —
 *    ONE signal per source carrying the count and what is missing, never one per
 *    position (#1356); the per-position detail lives in the positions endpoint.
 */
export type AgentViewDataQualityCategory =
  | "warning"
  | "trashed_balance"
  | "manual_value_freshness"
  | "price_freshness"
  | "source_freshness"
  | "missing_configuration"
  | "savings_coherence"
  | "spending_coherence"
  | "portfolio_reconciliation"
  | "transfer_integrity"
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

/** Per-holding TWR vs tracked index (ADR 0060, #626). */
export interface AgentViewVsBenchmark {
  comparison: {
    holdingTwr: number;
    indexGrowth: number;
    excessGrowth: number;
    sinceDate: string;
    untilDate: string;
    seriesId: string;
    trackedIndex: string;
    variant: "total_return" | "price";
    coverageNote: string;
  } | null;
  unavailableReason:
    | "no_tracked_index"
    | "catalog_unavailable"
    | "benchmark_unmapped"
    | "twr_unavailable"
    | "benchmark_unavailable"
    | "zero_start_value"
    | null;
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
  /** The scope's managed portfolios with their members (ADR 0085, #1547). */
  managedPortfolios: AgentViewManagedPortfolioSummary[];
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
  /**
   * The reference age, DERIVED from the scope members' birth dates on read
   * (#1415) — not a stored scalar. Absent when no member of the scope has a
   * birth year and no pre-#1415 config left a typed age behind; the coast
   * figures are then absent too.
   */
  currentAge?: number;
  targetRetirementAge?: number;
  /**
   * Editable monthly savings capacity (PRD #421, #425): the contribution the
   * FIRE projection assumes. Present only when the user has set it; absent means
   * the projection treats it as zero (the UI offers a history-based suggestion).
   */
  monthlySavingsCapacity?: AgentViewMoney;
  /**
   * Whether the scope counts its IMMOBILIZED capital — non-primary property,
   * collections — as FIRE capital (#1460, ADR 0078). Always present, because when it
   * is `false` every figure in `result` is measured over the sellable side alone, and
   * the excluded brick appears in NO other field: it is not an `excludedAssets` entry
   * (nothing excluded it as an asset) and the eligible total simply does not contain
   * it. An assistant quoting the FIRE number has to be able to say which of the two
   * measures it is quoting.
   */
  immobilizedCountsAsFireCapital: boolean;
  /**
   * What the user DECLARED their plan to be (#1428, ADR 0081): `ordinary` = an
   * ordinary retirement, `early` = FIRE. Absent when they have not been asked or have
   * not answered. It changes no figure — but with `ordinary` the honest headline for
   * this scope is `result.sustainableSpending`, not the funded percentage: quoting
   * "you are 31,5 % short" at someone whose plan is an ordinary retirement answers a
   * question they did not ask.
   */
  retirementPlan?: "ordinary" | "early";
  /**
   * The age at or above which retiring is no longer *early* (#1428) — the threshold the
   * profile signal is measured against. A user datum with a neutral default of 65,
   * never legislation: the ordinary age depends on country and year.
   */
  ordinaryRetirementAge: number;
  /**
   * The **final age**: how long the capital must last, if the user said (#1428). Present
   * only when they did — no actuarial table is assumed on their behalf, and without it
   * the sustainable-spending answer has only its perpetual half. Deliberately not called
   * a life expectancy: it is a declaration, not an estimate.
   */
  capitalLastsUntilAge?: number;
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
  /**
   * The age today's capital would reach the FULL FIRE number at **if contributions
   * stopped right now** (#1425). It was called `coastFireAge`, which promised the age
   * Coast is reached at — a different question, answered by `coastArrival` below. This
   * one assumes ZERO contributions, so quoting it as a coast age contradicts the
   * premise of `coastFireRequired` beside it. Present only when it can be derived (a
   * compounding rate, some capital, and the FIRE number not yet reached).
   */
  fireAgeIfContributionsStop?: number;
  /**
   * When the scope reaches the coast requirement projecting WITH its declared savings
   * (#1425) — the figure the coast tick on screen implies and nothing computed before.
   * `reached` means the requirement is already met (so `isAlreadyAtCoastFire` is true
   * and no age applies); `unreachable` means the declared savings never cross it inside
   * the projection horizon. Present only when the config carries an age.
   */
  coastArrival?:
    | { kind: "reached" }
    | { kind: "eta"; years: number; age: number }
    | { kind: "unreachable" };
  /** Present only when the config carries an age. */
  isAlreadyAtCoastFire?: boolean;
  /**
   * Whether this scope's plan reads as FIRE or as an ordinary retirement (#1428, ADR
   * 0081), and why. `state` is `ordinary` ONLY when the user declared it; `offer` means
   * the app has signals but has not been answered, and `fire` is everything else. The
   * signals are named so an assistant can say what they rest on instead of concluding
   * "you will not reach FIRE" from a threshold the user can move.
   */
  retirementProfile: {
    state: "fire" | "offer" | "ordinary";
    signals: ("target_age_is_ordinary" | "regular_unreachable")[];
  };
  /**
   * "How much can I spend without depleting my capital?" — the inverse of the FIRE
   * formula (#1428, ADR 0081), and the honest headline for an ordinary-retirement plan.
   *
   * Two halves, never summed into one opaque figure: `rents` is the scope's declared NET
   * rent, and `capitalMonthly` is what the SELLABLE side supports at the withdrawal rate
   * (the immobilized side is not in it — a withdrawal rate assumes capital sold in
   * slices). `depletionMonthly` is the same capital annuitized to `capitalLastsUntilAge`,
   * present only when that age is declared. Absent when there is no withdrawal rate.
   */
  sustainableSpending?: {
    /** `rents` + what the sellable capital supports, perpetually. */
    totalMonthly: AgentViewMoney;
    capitalMonthly: AgentViewMoney;
    /** Declared net rent, monthly. Absent when the scope declares none. */
    rentsMonthly?: AgentViewMoney;
    /** Perpetual + depleting the principal by `untilAge`. Absent without that age. */
    depletionMonthly?: AgentViewMoney;
    untilAge?: number;
  };
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
export interface AgentViewHoldingDetail extends AgentViewHoldingIdentity {
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
  /** Present only when the holding is a member of a managed portfolio (ADR 0085). */
  managedPortfolio?: AgentViewHoldingPortfolioMembership;
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
  /**
   * Why {@link exposureProfile} is null for a security with a known identity
   * (PRD #711 S3, ADR 0058): `profile_missing` (the catalog has no row for this
   * identity) vs `catalog_unavailable` (the global catalog itself could not be
   * read). Absent when a profile IS present, or when the instrument takes no
   * profile / the holding has no identity — those stay a plain `null` with no
   * distinction to draw.
   */
  exposureProfileStatus?: "profile_missing" | "catalog_unavailable";
  /** TWR vs the holding's tracked index; null comparison with a reason when unavailable (#626). */
  vsBenchmark: AgentViewVsBenchmark;
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
  /**
   * Four kinds, not two (#1393): the halves of a traspaso are reported as what they
   * are. A reader that saw `sell` on the outgoing half would count a realized gain
   * the ledger deliberately does not have.
   */
  kind: OperationKind;
  units: string;
  pricePerUnit: string;
  grossAmount: AgentViewMoney;
  fees: AgentViewMoney;
  /**
   * The id of the traspaso this operation belongs to, present on the traspaso kinds
   * and on nothing else — what lets a reader pair an outgoing leg with the incoming
   * one.
   *
   * An id that appears on ONE `transfer_in` and nowhere else is not a broken pair: it
   * is an **entrada por traspaso externo** (#1541), a position brought in from another
   * institution whose outgoing half lives in that institution's ledger and can never
   * be written here. Read it as capital that arrived, never as a purchase — it made no
   * contribution and realized no gain, and its `transferCostMinor` is the cost the
   * participaciones carried over.
   */
  transferId?: string;
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
  meta: AgentViewSnapshotHistoryMeta;
}

/**
 * Snapshot-history pagination, plus the narrowing a per-position decomposition
 * forces (#1268): asking for holding rows caps the page at a short window of
 * closes, so a single read can never carry the whole series position by
 * position. Present only when the cap actually bit — the rest of the series is
 * reachable through `nextCursor`, unchanged.
 */
export interface AgentViewSnapshotHistoryMeta extends AgentViewPaginationMeta {
  holdingRowsWindow?: {
    /** The page size asked for; `meta.limit` is the window actually served. */
    requestedLimit: number;
  };
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
  /** Reference year of birth; the projection derives age from it (#1415). */
  birthYear: number | null;
  /** Reference month of birth (1-12), when known: sharpens the derived age. */
  birthMonth: number | null;
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

/** A recurring planned contribution as forecast metadata (ADR 0041, PRD #553 S5). */
export interface AgentViewPlannedContribution {
  object: "planned_contribution";
  /** Opaque stable id (`wl_cpc_…`). */
  id: string;
  /** Destination holding public id (`wl_hld_…`). */
  destinationHolding: string;
  amount:
    | { mode: "money"; value: AgentViewMoney }
    | { mode: "units"; value: string; estimatedValue?: AgentViewMoney };
  cadence:
    | { kind: "weekly"; weekday: number }
    | { kind: "monthly"; dayOfMonth: number }
    | { kind: "quarterly" }
    | { kind: "annual" };
  startDate: string;
  endDate?: string;
  /** True when the contribution is in force today (started and not ended). */
  active: boolean;
}

/**
 * One destination's share of a month's planned capital allocation (forecast),
 * contrasted with the money explicitly confirmed against that month's
 * occurrences (S2). `plannedAmount` is null when a units occurrence lacks a
 * price — reported via `plannedUnits`, never guessed.
 */
export interface AgentViewMonthlyAllocationSlice {
  destinationHolding: string;
  plannedAmount: AgentViewMoney | null;
  /** Units-mode planned total for the month, for honest display when unpriced. */
  plannedUnits?: string;
  /** Money confirmed against this month's occurrences via explicit links. */
  executed: AgentViewMoney;
  occurrenceCount: number;
  /** Occurrences already closed (fulfilled or skipped). */
  closedCount: number;
  /** Share of the month's priceable planned total, as a `0..1` decimal string. */
  shareOfMonth: string;
}

/**
 * Where planned capital goes in one calendar month (ADR 0041, PRD #553 S3/S5).
 * Derived from the same seam the /objetivos view reads
 * (`computeMonthlyContributionAllocation`) — forecast only, never confirmed
 * truth. `totalPlanned` sums only priceable slices; unpriced destinations are
 * listed in `missingUnitPriceHoldings` rather than silently dropped.
 */
export interface AgentViewMonthlyAllocation {
  object: "monthly_allocation";
  /** `YYYY-MM` month key. */
  month: string;
  totalPlanned: AgentViewMoney;
  totalExecuted: AgentViewMoney;
  /** Destinations (`wl_hld_…`) whose units contributions lack a unit price. */
  missingUnitPriceHoldings: string[];
  slices: AgentViewMonthlyAllocationSlice[];
}

/** One forecast occurrence with its reconciliation status (ADR 0041, PRD #553 S2/S5). */
export interface AgentViewContributionOccurrence {
  object: "contribution_occurrence";
  id: string;
  plannedContributionId: string;
  destinationHolding: string;
  plannedDate: string;
  amount:
    | { mode: "money"; value: AgentViewMoney }
    | { mode: "units"; value: string; estimatedValue?: AgentViewMoney };
  state: "pending" | "partial" | "fulfilled" | "skipped";
  /** True when the planned date is before today and still open. */
  backlog: boolean;
  /** Public operation ids (`wl_op_…`) explicitly linked to this occurrence. */
  linkedOperations: string[];
  progress:
    | {
        mode: "money";
        planned: AgentViewMoney;
        executed: AgentViewMoney;
        delta: AgentViewMoney;
      }
    | {
        mode: "units";
        plannedUnits: string;
        executedUnits: string;
        deltaUnits: string;
        actualCash: AgentViewMoney;
      };
}

/** Pending/backlog reconciliation status for the contribution plan (forecast vs truth). */
export interface AgentViewContributionReconciliation {
  object: "contribution_reconciliation";
  /** The projected window: earliest plan start → `reconciliationWindowDays` ahead. */
  window: { from: string; to: string };
  pending: AgentViewContributionOccurrence[];
  backlog: AgentViewContributionOccurrence[];
  closed: AgentViewContributionOccurrence[];
}

/**
 * FIRE what-if under the contribution plan (ADR 0041, PRD #553 S4/S5): time-varying
 * planned contributions plus a growth assumption toggle. Forecast only — confirmed
 * operations remain truth via `get_operations`.
 */
export interface AgentViewContributionWhatIf {
  object: "contribution_what_if";
  growthAssumption: "flat" | "historical";
  /** Fallback annual return used when a holding lacks #547 history. */
  assumedAnnualReturn: string;
  status: AgentViewFireStatus;
  fireNumber?: AgentViewMoney;
  scenarios: AgentViewFireScenario[];
}

/** One year of projected look-through exposure under the contribution plan (#560). */
export interface AgentViewExposureDriftPoint {
  year: number;
  grossAssets: AgentViewMoney;
  byGeography: AgentViewExposureDimension;
  byAssetClass: AgentViewExposureDimension;
}

/**
 * Exposure-drift what-if under the contribution plan (ADR 0041, #560): how
 * geography and asset-class composition shift as planned contributions land.
 * Forecast only — same growth assumption as `whatIf`.
 */
export interface AgentViewExposureDrift {
  object: "exposure_drift";
  growthAssumption: "flat" | "historical";
  assumedAnnualReturn: string;
  status: "configured" | "empty";
  trajectory: AgentViewExposureDriftPoint[];
}

/**
 * A scope's contribution plan as `get_contribution_plan` exposes it (ADR 0041,
 * PRD #553 S5): the recurring plan, monthly allocation, pending/backlog status,
 * and what-if trajectory. The entire surface is forecast metadata — it never
 * enters net worth or snapshots. Confirmed movements remain truth via operations.
 */
export interface AgentViewContributionPlanContext {
  object: "contribution_plan_context";
  scope: AgentViewScope;
  /** Always true — labels the entire response as forecast, not executed truth. */
  forecast: true;
  truthNote: string;
  status: "empty" | "configured";
  contributions: AgentViewPlannedContribution[];
  /**
   * No `monthlySavingsCapacity` here on purpose (#1416, ADR 0074). This surface
   * used to report the FIRE savings capacity and where it came from, because the
   * plan overrode the user's declared scalar. It no longer does: the plan's own
   * monthly figure is `monthlyAllocation.totalPlanned`, and the capacity the FIRE
   * projection contributes is `get_fire_projection.monthlySavingsCapacity` — one
   * number per question, so the assistant cannot quote a subset as the total.
   */
  monthlyAllocation: AgentViewMonthlyAllocation;
  reconciliation: AgentViewContributionReconciliation;
  whatIf: AgentViewContributionWhatIf;
  exposureDrift: AgentViewExposureDrift;
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
