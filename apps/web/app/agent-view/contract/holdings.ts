import type { PriceFreshnessState } from "@worthline/domain";
import type { AgentViewVsBenchmark } from "./data-quality";
import type {
  AgentViewAmortizationFacts,
  AgentViewBalanceAnchorFacts,
  AgentViewValuationAnchor,
} from "./debt";
import type { AgentViewExposureProfile } from "./exposure";
import type { AgentViewHoldingPayouts } from "./payouts";
import type { AgentViewReturns } from "./returns";
import type {
  AgentViewLiquidityTier,
  AgentViewMoney,
  AgentViewObjectReference,
  AgentViewPaginationMeta,
} from "./shared";

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
