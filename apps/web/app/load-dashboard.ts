/**
 * Dashboard load module (issue #69).
 *
 * Single deep module: scope in → dashboard state out.
 *
 * Sequence:
 * 1. Refresh stale prices (via injected refreshPrices — caller supplies the
 *    refreshAndPersistStalePrices orchestration or a test stub).
 * 2. Capture at most one snapshot per scope per day, day's latest winning
 *    (ADR 0005). Runs for every scope so all scopes accumulate history.
 * 3. Compute dashboard state via prepareDashboardState from @worthline/domain.
 *
 * Pricing failures degrade to last-known values; errors surface in the returned
 * `pricingErrors` field — never swallowed silently.
 */

import type { WorthlineStore } from "@worthline/db";
import type {
  AssetPrice,
  DrilldownKey,
  DrilldownState,
  InvestmentCaptureDetail,
  NetWorthFraming,
} from "@worthline/domain";
import {
  buildDrilldown,
  captureSnapshotForScope,
  isHousingAsset,
  listScopeOptions,
  prepareDashboardState,
} from "@worthline/domain";
import type { DashboardState, LocalPersistenceStatus } from "@worthline/domain";

export interface RefreshPricesResult {
  /** Price cache after refresh (always populated — stale cache on failure). */
  priceCache: AssetPrice[];
  /** Non-empty on partial or total failure. */
  errors: string[];
}

export interface LoadDashboardInput {
  /** The open store to use for all reads and writes. Caller owns lifecycle. */
  store: WorthlineStore;
  /** Bootstrap persistence status (from runBootstrapHealthcheck). */
  persistence: LocalPersistenceStatus;
  /** Scope ID from the cookie — undefined falls back to first/household scope. */
  scopeId: string | undefined;
  /** Which framing to headline with. */
  selectedView: NetWorthFraming;
  /**
   * Active drilldown (#76), parsed from the `drill=` query param.
   * When set, the result carries the drill view state built from the scope's
   * frozen snapshot holding rows. Absent/null = no drill.
   */
  drill?: DrilldownKey | null;
  /**
   * "Today" as YYYY-MM-DD. Retained for API compatibility: the snapshot
   * capture policy now derives its date from `now` inside
   * captureSnapshotForScope, and callers already pass `today = now.slice(0, 10)`.
   */
  today: string;
  /**
   * "Now" as ISO timestamp for snapshot capturedAt and staleness checks.
   */
  now: string;
  /**
   * Injected price-refresh orchestration.
   * In production: refreshAndPersistStalePrices bound to the real pricing provider.
   * In tests: a stub (noOpRefresh or a failing stub).
   */
  refreshPrices: (input: {
    cacheEntries: AssetPrice[];
    assets: Array<{ id: string; currency: string; providerSymbol?: string }>;
    nowIso: string;
  }) => Promise<RefreshPricesResult>;
}

export interface LoadDashboardResult extends DashboardState {
  /**
   * True when no workspace has been set up — page should redirect to /empezar.
   * When true, all other fields carry empty/undefined values.
   */
  needsOnboarding: boolean;
  /**
   * Explicit pricing-failure signal. Empty array = clean refresh.
   * Non-empty = one or more symbols failed; figures use last-known values.
   * Never undefined — always an array so the page can conditionally render.
   */
  pricingErrors: string[];
  /**
   * Drill view state (#76, #77) when a drill was requested — built from the
   * scope's frozen snapshot holding rows. `null` when no drill is active.
   */
  drilldown: DrilldownState | null;
}

export async function loadDashboard(
  input: LoadDashboardInput,
): Promise<LoadDashboardResult> {
  const { store, persistence, scopeId, selectedView, drill, now, refreshPrices } = input;

  // ── 1. Refresh stale prices ───────────────────────────────────────────────
  const investmentAssets = store.assets.readInvestmentAssetsWithMeta();
  const initialCache = store.operations.readAllPriceCacheEntries();

  const { priceCache, errors: pricingErrors } = await refreshPrices({
    cacheEntries: initialCache,
    assets: investmentAssets,
    nowIso: now,
  });

  // Persist refreshed prices back to the store
  for (const price of priceCache) {
    if (
      initialCache.every(
        (c) => c.assetId !== price.assetId || c.fetchedAt !== price.fetchedAt,
      )
    ) {
      store.operations.upsertPrice(price);
    }
  }

  // ── 2. Read workspace — redirect signal if absent ─────────────────────────
  const workspace = store.workspace.readWorkspace();

  if (!workspace) {
    // Return a minimal result that signals the page to redirect.
    return buildEmptyResult(persistence, pricingErrors);
  }

  const assets = store.assets.readAssets();
  const liabilities = store.liabilities.readLiabilities();
  const scopes = listScopeOptions(workspace);
  const selectedScope = scopes.find((s) => s.id === scopeId) ?? scopes[0];

  // ── 3. Snapshot capture (ADR 0005, ADR 0008) ──────────────────────────────
  // Runs for every scope so all scopes accumulate history, not just the
  // currently viewed one. Each capture persists the valued portfolio behind
  // its figures — one frozen row per holding — atomically with the snapshot.
  // Investments additionally freeze units and the unit price used that day.
  const investmentDetails = new Map<string, InvestmentCaptureDetail>(
    store.snapshots.readPositions().map((position) => [
      position.assetId,
      {
        units: position.currentUnits,
        ...(position.currentPricePerUnit
          ? { unitPrice: position.currentPricePerUnit }
          : {}),
      },
    ]),
  );

  for (const scope of scopes) {
    const capture = captureSnapshotForScope({
      assets,
      capturedAt: now,
      existingSnapshots: store.snapshots.readSnapshots(scope.id),
      investmentDetails,
      liabilities,
      scope,
      workspace,
    });

    if (capture) {
      store.snapshots.saveSnapshot({
        holdings: capture.holdings,
        replace: capture.replace,
        snapshot: capture.snapshot,
      });
    }
  }

  // ── 4. Collect remaining data for state assembly ─────────────────────────
  const positions = selectedScope ? store.snapshots.readPositions(selectedScope.id) : [];
  const overrides = store.readWarningOverrides();
  const fireConfig = store.readFireConfig();
  const snapshots = selectedScope ? store.snapshots.readSnapshots(selectedScope.id) : [];

  // ── 4b. Drilldown (#76, #77) — drill view state from frozen holding rows ─
  const drilldown =
    drill && selectedScope
      ? buildDrilldown(drill, {
          currentHoldingIds: [
            ...assets.map((asset) => asset.id),
            ...liabilities.map((liability) => liability.id),
          ],
          // Housing is sourced by id, not rung (ADR 0013 bridge): real-estate holdings.
          housingHoldingIds: assets
            .filter((asset) => isHousingAsset(asset))
            .map((asset) => asset.id),
          rows: store.snapshots.readSnapshotHoldings({ scopeId: selectedScope.id }),
        })
      : null;

  // ── 5. Compute dashboard state ────────────────────────────────────────────
  const state = prepareDashboardState({
    assets,
    fireConfig,
    liabilities,
    overrides,
    persistence,
    positions,
    priceCache,
    scopes,
    selectedScope,
    selectedView,
    snapshots,
    workspace,
  });

  return {
    ...state,
    drilldown,
    needsOnboarding: false,
    pricingErrors,
  };
}

/**
 * Minimal result for the no-workspace case. prepareDashboardState requires a
 * workspace so we construct a compatible empty shell here instead.
 */
function buildEmptyResult(
  persistence: LocalPersistenceStatus,
  pricingErrors: string[],
): LoadDashboardResult {
  // Use prepareDashboardState with null workspace so DashboardState types are
  // satisfied and all optional fields carry their natural empty values.
  const state = prepareDashboardState({
    assets: [],
    fireConfig: {},
    liabilities: [],
    overrides: [],
    persistence,
    positions: [],
    priceCache: [],
    scopes: [],
    selectedScope: undefined,
    selectedView: "total",
    snapshots: [],
    workspace: null,
  });

  return {
    ...state,
    drilldown: null,
    needsOnboarding: true,
    pricingErrors,
  };
}
