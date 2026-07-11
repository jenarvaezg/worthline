import type {
  AssetPrice,
  ContributionOccurrenceReconciliation,
  ContributionPlan,
  DebtModel,
  ExportedPublicId,
  ExposureProfile,
  FireScopeConfig,
  Goal,
  InvestmentOperation,
  Liability,
  ManualAsset,
  NetWorthSnapshot,
  Payout,
  PayoutSchedule,
  PriceFreshnessState,
  SourceAdapter,
  SourcePosition,
  WarningOverride,
  Workspace,
} from "@worthline/domain";

import { isNotNull } from "drizzle-orm";

import { readAgentViewPublicIds } from "./agent-view-public-ids";
import type { InvestmentAssetMeta, ValuationAnchorRecord } from "./asset-store";
import type { ConnectedSourceRow } from "./connected-source-store";
import type {
  AmortizationPlanRecord,
  BalanceAnchorRecord,
  EarlyRepaymentRecord,
  InterestRateRevisionRecord,
} from "./liability-store";
import { assetOwnerships, assets, liabilities, liabilityOwnerships } from "./schema";
import type { SnapshotHoldingQuery, SnapshotHoldingRecord } from "./snapshot-store";
import type { StoreContext, StoreDb } from "./store-context";

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
 * A trashed (soft-deleted) holding as the agent view sees it (PRD #328, #342): a
 * recoverable asset/liability that lives outside the main financial context. It
 * carries only the stored facts a trash listing needs — never a derived/investment
 * revaluation. `valueMinor` is the STORED current value (assets) / current balance
 * (liabilities) when present, else null ("value/balance when safely available").
 * `ownerMemberIds` are the members with a stake, so the service can scope the row
 * the same way live holdings are scoped. A pure read — no restore, no hard-delete.
 */
export interface AgentViewTrashedHolding {
  /** Internal asset/liability id — resolved to its `wl_hld_` public id by the service. */
  id: string;
  name: string;
  kind: "asset" | "liability";
  instrument: string | null;
  /** When the holding was trashed (ISO), or null for a legacy row with no stamp. */
  deletedAt: string | null;
  /** Stored current value (asset) / current balance (liability), or null. */
  valueMinor: number | null;
  /** Member ids with an ownership share in this holding. */
  ownerMemberIds: string[];
}

/**
 * A priced asset's valuation freshness as the agent view sees it (PRD #328,
 * #341): the staleness indicator stamped on its price-cache row, the fetch time,
 * the providing source, and the failed-fetch reason when one is recorded.
 * Secret-free by construction — it carries no provider payload, no token, and no
 * price figure. Null when the asset has no cached price (a manual/derived asset
 * with no provider quote). Drives the `price_freshness` data-quality category.
 */
export interface AgentViewPriceFreshness {
  freshnessState: PriceFreshnessState;
  /** When the price was last fetched (ISO). */
  fetchedAt: string;
  /** The provider that supplied the cached price. */
  source: string;
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
  readWorkspace: () => Promise<Workspace | null>;
  readPublicIds: () => Promise<ExportedPublicId[]>;
  readAssets: () => Promise<ManualAsset[]>;
  readLiabilities: () => Promise<Liability[]>;
  /**
   * The live ledger valued on `dateKey`: housing and modelled debts are sampled
   * through their curves (amortization plans, early repayments, anchors); holdings
   * without a curve keep their stored value/balance. This is the read agent-view
   * figures use so they match the dashboard, which values live figures the same
   * way — `readAssets`/`readLiabilities` return the STORED ledger and remain for
   * fact listings that must echo what the user typed.
   */
  readCurveValuedHoldings: (
    dateKey: string,
  ) => Promise<{ assets: ManualAsset[]; liabilities: Liability[] }>;
  readOperations: (assetId: string) => Promise<InvestmentOperation[]>;
  readConnectedSources: () => Promise<AgentViewConnectedSource[]>;
  /**
   * A connected source's mirrored positions (PRD #328, #339). Pure read — never
   * syncs or revalues. Credentials/tokens are not part of a position, so the
   * shape is secret-free.
   */
  readSourcePositions: (sourceId: string) => Promise<SourcePosition[]>;
  /**
   * A connected source's valuation freshness, or null if it was never valued
   * (PRD #328, #339). Sanitized: only the staleness signal, the fetch time, and
   * the failed-fetch reason — never the provider's raw payload or any secret.
   */
  readSourceFreshness: (sourceId: string) => Promise<AgentViewSourceFreshness | null>;
  /** Frozen snapshots for a scope, chronological (snapshot-store ordering). */
  readSnapshots: (scopeId: string) => Promise<NetWorthSnapshot[]>;
  /** Frozen holding rows, optionally filtered by scope and date-key window. */
  readSnapshotHoldings: (query: SnapshotHoldingQuery) => Promise<SnapshotHoldingRecord[]>;
  /** An asset's housing valuation anchors, ascending by date (#338). */
  readValuationAnchors: (assetId: string) => Promise<ValuationAnchorRecord[]>;
  /** A liability's configured debt model, or null (#338). */
  readDebtModel: (liabilityId: string) => Promise<DebtModel | null>;
  /** A liability's amortization plan, or null if it has none (#338). */
  readAmortizationPlan: (liabilityId: string) => Promise<AmortizationPlanRecord | null>;
  /** A plan's interest-rate revisions, ascending by date (#338). */
  readInterestRateRevisions: (planId: string) => Promise<InterestRateRevisionRecord[]>;
  /** A plan's early repayments, ascending by date (#338). */
  readEarlyRepayments: (planId: string) => Promise<EarlyRepaymentRecord[]>;
  /** A liability's balance anchors, ascending by date (#338). */
  readBalanceAnchors: (liabilityId: string) => Promise<BalanceAnchorRecord[]>;
  /** FIRE configs keyed by internal scope id (`household` | member | group), #340. */
  readFireConfig: () => Promise<Record<string, FireScopeConfig>>;
  /**
   * A priced asset's valuation freshness, or null if it has no cached price
   * (#341). Sanitized: only the staleness signal, the fetch time, the providing
   * source, and the failed-fetch reason — never the price figure or any secret.
   */
  readPriceFreshness: (assetId: string) => Promise<AgentViewPriceFreshness | null>;
  /**
   * Persisted overrideable-warning acknowledgements (#341). A pure read — the
   * agent view exposes which overrideable warnings the user marked intentional
   * so it can label them, and NEVER writes a new override.
   */
  readWarningOverrides: () => Promise<WarningOverride[]>;
  /**
   * Trashed (soft-deleted) holdings with the stored facts a trash listing needs
   * (#342). A pure read over `assets`/`liabilities` WHERE `deleted_at IS NOT NULL`
   * — it never restores, hard-deletes, or revalues, and it never touches the live
   * context (the live reads exclude trash by filtering `deleted_at IS NULL`).
   */
  readTrashedHoldings: () => Promise<AgentViewTrashedHolding[]>;
  /** Goals (optionally for one scope) with their assigned holdings (#424). A pure read. */
  readGoals: (scopeId?: string) => Promise<Goal[]>;
  /**
   * Hand-entered exposure profiles keyed by `isin ?? providerSymbol` (PRD #539,
   * ADR 0039). A pure read — the look-through aggregation runs in domain code
   * (`lookThroughExposure`); this port never writes or auto-derives a profile.
   */
  readExposureProfiles: () => Promise<ExposureProfile[]>;
  /**
   * Investment-asset reference metadata — its identity (`isin`, `providerSymbol`)
   * and price provider (PRD #539). A pure read; used to key each holding to its
   * exposure profile for the look-through.
   */
  readInvestmentAssetsWithMeta: () => Promise<InvestmentAssetMeta[]>;
  /**
   * Recorded one-off payouts — dividends, interest, rent as attribution records
   * (PRD #652, ADR 0054). A pure read: payouts touch no figure, snapshot, or
   * ripple, so surfacing them cannot mutate state. Occurrences of a schedule are
   * derived in domain code (`deriveScheduleOccurrences`), never stored — this port
   * exposes only the persisted declarations. Optionally scoped to one holding.
   */
  readPayouts: () => Promise<Payout[]>;
  readPayoutsForHolding: (holdingId: string) => Promise<Payout[]>;
  /** Declared payout schedules; their occurrences are derived on read, never stored. */
  readPayoutSchedules: () => Promise<PayoutSchedule[]>;
  readPayoutSchedulesForHolding: (holdingId: string) => Promise<PayoutSchedule[]>;
  /** A scope's planned contributions (ADR 0041, PRD #553 S1). Forecast metadata only. */
  readContributionPlan: (scopeId: string) => Promise<ContributionPlan>;
  /**
   * A scope's explicit contribution reconciliations (ADR 0041, PRD #553 S2). A
   * pure read — the pending/backlog projection joins these to forecast
   * occurrences in domain code; the agent view never links or closes one.
   */
  readContributionReconciliations: (
    scopeId: string,
  ) => Promise<ContributionOccurrenceReconciliation[]>;
  /** Cached investment unit prices for contribution-plan money conversion. */
  readAllPriceCacheEntries: () => Promise<AssetPrice[]>;
}

export interface AgentViewReadStoreDeps {
  readAssets: () => Promise<ManualAsset[]>;
  readLiabilities: () => Promise<Liability[]>;
  readCurveValuedHoldings: (
    dateKey: string,
  ) => Promise<{ assets: ManualAsset[]; liabilities: Liability[] }>;
  readOperations: (assetId: string) => Promise<InvestmentOperation[]>;
  listConnectedSources: () => Promise<ConnectedSourceRow[]>;
  listSourceAssetIds: (sourceId: string) => Promise<string[]>;
  readSourcePositions: (sourceId: string) => Promise<SourcePosition[]>;
  /** The price-cache row of a source's primary asset (its valuation freshness). */
  readSourcePriceCache: (assetId: string) => Promise<{
    freshnessState: PriceFreshnessState;
    fetchedAt: string;
    staleReason?: string;
  } | null>;
  readSnapshots: (scopeId: string) => Promise<NetWorthSnapshot[]>;
  readSnapshotHoldings: (query: SnapshotHoldingQuery) => Promise<SnapshotHoldingRecord[]>;
  readValuationAnchors: (assetId: string) => Promise<ValuationAnchorRecord[]>;
  readDebtModel: (liabilityId: string) => Promise<DebtModel | null>;
  readAmortizationPlan: (liabilityId: string) => Promise<AmortizationPlanRecord | null>;
  readInterestRateRevisions: (planId: string) => Promise<InterestRateRevisionRecord[]>;
  readEarlyRepayments: (planId: string) => Promise<EarlyRepaymentRecord[]>;
  readBalanceAnchors: (liabilityId: string) => Promise<BalanceAnchorRecord[]>;
  readFireConfig: () => Promise<Record<string, FireScopeConfig>>;
  /** The price-cache row of any asset (its valuation freshness), or null. */
  readPriceCache: (assetId: string) => Promise<{
    freshnessState: PriceFreshnessState;
    fetchedAt: string;
    source: string;
    staleReason?: string;
  } | null>;
  readWarningOverrides: () => Promise<WarningOverride[]>;
  readGoals: (scopeId?: string) => Promise<Goal[]>;
  readExposureProfiles: () => Promise<ExposureProfile[]>;
  readInvestmentAssetsWithMeta: () => Promise<InvestmentAssetMeta[]>;
  readPayouts: () => Promise<Payout[]>;
  readPayoutsForHolding: (holdingId: string) => Promise<Payout[]>;
  readPayoutSchedules: () => Promise<PayoutSchedule[]>;
  readPayoutSchedulesForHolding: (holdingId: string) => Promise<PayoutSchedule[]>;
  readContributionPlan: (scopeId: string) => Promise<ContributionPlan>;
  readContributionReconciliations: (
    scopeId: string,
  ) => Promise<ContributionOccurrenceReconciliation[]>;
  readAllPriceCacheEntries: () => Promise<AssetPrice[]>;
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
    readCurveValuedHoldings: (dateKey) => deps.readCurveValuedHoldings(dateKey),
    readOperations: (assetId) => deps.readOperations(assetId),
    readGoals: (scopeId) => deps.readGoals(scopeId),
    readConnectedSources: async () => {
      const rows = await deps.listConnectedSources();
      return Promise.all(
        rows.map(async (row) => ({
          adapter: row.adapter,
          assetId: row.assetId,
          assetIds: await deps.listSourceAssetIds(row.id),
          id: row.id,
          label: row.label,
          lastSyncAt: row.lastSyncAt,
        })),
      );
    },
    readSourcePositions: (sourceId) => deps.readSourcePositions(sourceId),
    readSourceFreshness: async (sourceId) => {
      const sources = await deps.listConnectedSources();
      const source = sources.find((row) => row.id === sourceId);
      if (!source) {
        return null;
      }
      const cache = await deps.readSourcePriceCache(source.assetId);
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
    readFireConfig: () => deps.readFireConfig(),
    readPriceFreshness: async (assetId) => {
      const cache = await deps.readPriceCache(assetId);
      if (!cache) {
        return null;
      }
      return {
        fetchedAt: cache.fetchedAt,
        freshnessState: cache.freshnessState,
        source: cache.source,
        ...(cache.staleReason === undefined ? {} : { staleReason: cache.staleReason }),
      };
    },
    readWarningOverrides: () => deps.readWarningOverrides(),
    readTrashedHoldings: () => readTrashedHoldings(ctx.db),
    readExposureProfiles: () => deps.readExposureProfiles(),
    readInvestmentAssetsWithMeta: () => deps.readInvestmentAssetsWithMeta(),
    readPayouts: () => deps.readPayouts(),
    readPayoutsForHolding: (holdingId) => deps.readPayoutsForHolding(holdingId),
    readPayoutSchedules: () => deps.readPayoutSchedules(),
    readPayoutSchedulesForHolding: (holdingId) =>
      deps.readPayoutSchedulesForHolding(holdingId),
    readContributionPlan: (scopeId) => deps.readContributionPlan(scopeId),
    readContributionReconciliations: (scopeId) =>
      deps.readContributionReconciliations(scopeId),
    readAllPriceCacheEntries: () => deps.readAllPriceCacheEntries(),
  };
}

/**
 * Read the trashed (soft-deleted) holdings for the agent view (#342): every
 * asset/liability WHERE `deleted_at IS NOT NULL`, with the stored value/balance,
 * instrument, deleted stamp, and owner member ids the trash listing needs. A pure
 * read — it never restores, hard-deletes, revalues, or writes an audit row, and it
 * never touches the live context (the live reads exclude trash). No derived /
 * investment valuation is computed here; the STORED current value/balance is
 * exposed as-is, mirroring the trash listing the rest of the app shows.
 */
async function readTrashedHoldings(db: StoreDb): Promise<AgentViewTrashedHolding[]> {
  const assetRows = await db
    .select({
      currentValueMinor: assets.currentValueMinor,
      deletedAt: assets.deletedAt,
      id: assets.id,
      instrument: assets.instrument,
      name: assets.name,
    })
    .from(assets)
    .where(isNotNull(assets.deletedAt))
    .all();

  const liabilityRows = await db
    .select({
      currentBalanceMinor: liabilities.currentBalanceMinor,
      deletedAt: liabilities.deletedAt,
      id: liabilities.id,
      instrument: liabilities.instrument,
      name: liabilities.name,
    })
    .from(liabilities)
    .where(isNotNull(liabilities.deletedAt))
    .all();

  const assetOwners = groupOwnerMemberIds(
    await db
      .select({
        holdingId: assetOwnerships.assetId,
        memberId: assetOwnerships.memberId,
      })
      .from(assetOwnerships)
      .all(),
  );
  const liabilityOwners = groupOwnerMemberIds(
    await db
      .select({
        holdingId: liabilityOwnerships.liabilityId,
        memberId: liabilityOwnerships.memberId,
      })
      .from(liabilityOwnerships)
      .all(),
  );

  return [
    ...assetRows.map((row) => ({
      deletedAt: row.deletedAt,
      id: row.id,
      instrument: row.instrument,
      kind: "asset" as const,
      name: row.name,
      ownerMemberIds: assetOwners.get(row.id) ?? [],
      valueMinor: row.currentValueMinor,
    })),
    ...liabilityRows.map((row) => ({
      deletedAt: row.deletedAt,
      id: row.id,
      instrument: row.instrument,
      kind: "liability" as const,
      name: row.name,
      ownerMemberIds: liabilityOwners.get(row.id) ?? [],
      valueMinor: row.currentBalanceMinor,
    })),
  ];
}

/** Group flat `{ holdingId, memberId }` ownership rows into member ids per holding. */
function groupOwnerMemberIds(
  rows: { holdingId: string; memberId: string }[],
): Map<string, string[]> {
  const byHolding = new Map<string, string[]>();
  for (const row of rows) {
    const existing = byHolding.get(row.holdingId);
    if (existing) {
      existing.push(row.memberId);
    } else {
      byHolding.set(row.holdingId, [row.memberId]);
    }
  }
  return byHolding;
}
