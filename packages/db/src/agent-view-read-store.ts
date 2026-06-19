import type {
  DebtModel,
  ExportedPublicId,
  InvestmentOperation,
  Liability,
  ManualAsset,
  NetWorthSnapshot,
  PriceFreshnessState,
  SourceAdapter,
  SourcePosition,
  Workspace,
} from "@worthline/domain";

import { readAgentViewPublicIds } from "./agent-view-public-ids";
import type { ValuationAnchorRecord } from "./asset-store";
import type { ConnectedSourceRow } from "./connected-source-store";
import type {
  AmortizationPlanRecord,
  BalanceAnchorRecord,
  EarlyRepaymentRecord,
  InterestRateRevisionRecord,
} from "./liability-store";
import type { SnapshotHoldingQuery, SnapshotHoldingRecord } from "./snapshot-store";
import type { StoreContext } from "./store-context";

/**
 * A connected source as the agent view sees it — identity, label, freshness, and
 * the holdings it materialized. Credentials and tokens are excluded by
 * construction; the agent view never exposes secrets (PRD #328).
 */
export interface AgentViewConnectedSource {
  id: string;
  adapter: SourceAdapter;
  label: string;
  lastSyncAt: string | null;
  /** The market (primary) asset this source materialized — its freshness anchor. */
  assetId: string;
  /** Asset ids this source materialized — one per occupied rung. */
  assetIds: string[];
}

/**
 * A connected source's valuation freshness as the agent view sees it (PRD #328,
 * #339): the staleness indicator stamped on the source's primary price-cache row
 * by `revaluePositions`, with the provider tag and the failed-fetch reason when
 * one is recorded. Secret-free by construction — it carries no credentials,
 * tokens, or raw provider payloads. Null when the source has never been valued.
 */
export interface AgentViewSourceFreshness {
  freshnessState: PriceFreshnessState;
  /** When the value was last fetched (ISO). */
  fetchedAt: string;
  /** Why the last fetch is degraded (a failed/stale signal), when recorded. */
  staleReason?: string;
}

/**
 * Narrow read-only port for the external agent view (PRD #328, ADR 0023). It
 * exposes only the reads the agent-view service needs and never any write or
 * side-effecting path — agent reads must not refresh prices, sync sources, or
 * capture snapshots. Construction injects already-bound store reads so the port
 * cannot reach the rest of the store surface.
 */
export interface AgentViewReadStore {
  readWorkspace: () => Workspace | null;
  readPublicIds: () => ExportedPublicId[];
  readAssets: () => ManualAsset[];
  readLiabilities: () => Liability[];
  readOperations: (assetId: string) => InvestmentOperation[];
  readConnectedSources: () => AgentViewConnectedSource[];
  /**
   * A connected source's mirrored positions (PRD #328, #339). Pure read — never
   * syncs or revalues. Credentials/tokens are not part of a position, so the
   * shape is secret-free.
   */
  readSourcePositions: (sourceId: string) => SourcePosition[];
  /**
   * A connected source's valuation freshness, or null if it was never valued
   * (PRD #328, #339). Sanitized: only the staleness signal, the fetch time, and
   * the failed-fetch reason — never the provider's raw payload or any secret.
   */
  readSourceFreshness: (sourceId: string) => AgentViewSourceFreshness | null;
  /** Frozen snapshots for a scope, chronological (snapshot-store ordering). */
  readSnapshots: (scopeId: string) => NetWorthSnapshot[];
  /** Frozen holding rows, optionally filtered by scope and date-key window. */
  readSnapshotHoldings: (query: SnapshotHoldingQuery) => SnapshotHoldingRecord[];
  /** An asset's housing valuation anchors, ascending by date (#338). */
  readValuationAnchors: (assetId: string) => ValuationAnchorRecord[];
  /** A liability's configured debt model, or null (#338). */
  readDebtModel: (liabilityId: string) => DebtModel | null;
  /** A liability's amortization plan, or null if it has none (#338). */
  readAmortizationPlan: (liabilityId: string) => AmortizationPlanRecord | null;
  /** A plan's interest-rate revisions, ascending by date (#338). */
  readInterestRateRevisions: (planId: string) => InterestRateRevisionRecord[];
  /** A plan's early repayments, ascending by date (#338). */
  readEarlyRepayments: (planId: string) => EarlyRepaymentRecord[];
  /** A liability's balance anchors, ascending by date (#338). */
  readBalanceAnchors: (liabilityId: string) => BalanceAnchorRecord[];
}

export interface AgentViewReadStoreDeps {
  readAssets: () => ManualAsset[];
  readLiabilities: () => Liability[];
  readOperations: (assetId: string) => InvestmentOperation[];
  listConnectedSources: () => ConnectedSourceRow[];
  listSourceAssetIds: (sourceId: string) => string[];
  readSourcePositions: (sourceId: string) => SourcePosition[];
  /** The price-cache row of a source's primary asset (its valuation freshness). */
  readSourcePriceCache: (assetId: string) => {
    freshnessState: PriceFreshnessState;
    fetchedAt: string;
    staleReason?: string;
  } | null;
  readSnapshots: (scopeId: string) => NetWorthSnapshot[];
  readSnapshotHoldings: (query: SnapshotHoldingQuery) => SnapshotHoldingRecord[];
  readValuationAnchors: (assetId: string) => ValuationAnchorRecord[];
  readDebtModel: (liabilityId: string) => DebtModel | null;
  readAmortizationPlan: (liabilityId: string) => AmortizationPlanRecord | null;
  readInterestRateRevisions: (planId: string) => InterestRateRevisionRecord[];
  readEarlyRepayments: (planId: string) => EarlyRepaymentRecord[];
  readBalanceAnchors: (liabilityId: string) => BalanceAnchorRecord[];
}

export function createAgentViewReadStore(
  ctx: StoreContext,
  deps: AgentViewReadStoreDeps,
): AgentViewReadStore {
  return {
    readWorkspace: () => ctx.getWorkspace(),
    readPublicIds: () => readAgentViewPublicIds(ctx.db),
    readAssets: () => deps.readAssets(),
    readLiabilities: () => deps.readLiabilities(),
    readOperations: (assetId) => deps.readOperations(assetId),
    readConnectedSources: () =>
      deps.listConnectedSources().map((row) => ({
        adapter: row.adapter,
        assetId: row.assetId,
        assetIds: deps.listSourceAssetIds(row.id),
        id: row.id,
        label: row.label,
        lastSyncAt: row.lastSyncAt,
      })),
    readSourcePositions: (sourceId) => deps.readSourcePositions(sourceId),
    readSourceFreshness: (sourceId) => {
      const source = deps.listConnectedSources().find((row) => row.id === sourceId);
      if (!source) {
        return null;
      }
      const cache = deps.readSourcePriceCache(source.assetId);
      if (!cache) {
        return null;
      }
      return {
        fetchedAt: cache.fetchedAt,
        freshnessState: cache.freshnessState,
        ...(cache.staleReason === undefined ? {} : { staleReason: cache.staleReason }),
      };
    },
    readSnapshots: (scopeId) => deps.readSnapshots(scopeId),
    readSnapshotHoldings: (query) => deps.readSnapshotHoldings(query),
    readValuationAnchors: (assetId) => deps.readValuationAnchors(assetId),
    readDebtModel: (liabilityId) => deps.readDebtModel(liabilityId),
    readAmortizationPlan: (liabilityId) => deps.readAmortizationPlan(liabilityId),
    readInterestRateRevisions: (planId) => deps.readInterestRateRevisions(planId),
    readEarlyRepayments: (planId) => deps.readEarlyRepayments(planId),
    readBalanceAnchors: (liabilityId) => deps.readBalanceAnchors(liabilityId),
  };
}
