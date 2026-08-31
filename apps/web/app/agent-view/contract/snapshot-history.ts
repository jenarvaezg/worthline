import type { AgentViewHoldingDirection } from "./holdings";
import type {
  AgentViewFinancialSummary,
  AgentViewLiquidityTier,
  AgentViewMoney,
  AgentViewObjectReference,
  AgentViewPaginationMeta,
} from "./shared";

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
