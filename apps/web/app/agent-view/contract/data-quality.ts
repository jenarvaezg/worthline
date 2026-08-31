import type { AgentViewObjectReference, AgentViewPaginationMeta } from "./shared";

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
