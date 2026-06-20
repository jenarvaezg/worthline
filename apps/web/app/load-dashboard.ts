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
  CompositionRange,
  DrilldownKey,
  DrilldownState,
  InvestmentCaptureDetail,
  NetWorthFraming,
} from "@worthline/domain";
import {
  availableCompositionRanges,
  buildCompositionSeries,
  buildDrilldown,
  captureSnapshotForScope,
  deriveFramedSnapshotDeltas,
  listScopeOptions,
  monthsBetween,
  prepareDashboardState,
  rangeStartMonthKey,
} from "@worthline/domain";
import type {
  CompositionSeriesPoint,
  DashboardState,
  FramedSnapshotDeltas,
  LocalPersistenceStatus,
} from "@worthline/domain";

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
   * Composition chart temporal range (#144): windows both the chart series and
   * the active drill, and the density adapts to the windowed span. Defaults to
   * `all` (full history) when omitted.
   */
  range?: CompositionRange;
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
  /**
   * Optional: refresh stale connected coin-collection valuations before snapshot
   * capture (PRD #166, ADR 0017), so the snapshot freezes the freshly-valued
   * coins. Production binds the Numista-backed orchestration; omitted in tests.
   * Returns one message per source that failed, merged into `pricingErrors`.
   */
  refreshCoinValuations?: () => Promise<{ errors: string[] }>;
  /**
   * Optional: keep connected Binance sources current before snapshot capture
   * (PRD #245 S4, ADR 0007/0021). Re-reads each stale source's balances and
   * re-values them live, so today's snapshot freezes the freshly-valued holdings.
   * Production binds the Binance-backed orchestration; omitted in tests.
   * Returns one message per source that failed, merged into `pricingErrors`.
   */
  refreshBinanceSources?: () => Promise<{ errors: string[] }>;
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
  /**
   * The net-worth composition chart series (#142): one banded base point per
   * monthly close plus the open period, aggregated from the scope's frozen
   * holding rows. Empty when there is no scope.
   */
  compositionSeries: CompositionSeriesPoint[];
  /**
   * The temporal ranges worth offering for this scope's history (#144): a bounded
   * range only when the history is longer than its window, plus `all`. A single
   * entry means the range control should hide itself. Empty when there is no scope.
   */
  compositionRanges: CompositionRange[];
  /**
   * The two hero delta chips (#244), each pre-computed in the active framing —
   * the change vs the previous snapshot and vs the prior-month close, with
   * percent. The page renders these directly; it never re-derives a figure from
   * raw snapshots. Each chip is `null` when there is no base to compare against.
   * Mirrors `presentation`, which already carries the framed headline figure.
   */
  headlineDeltas: FramedSnapshotDeltas;
}

export async function loadDashboard(
  input: LoadDashboardInput,
): Promise<LoadDashboardResult> {
  const { store, persistence, scopeId, selectedView, drill, range, now, refreshPrices } =
    input;

  // ── 1. Refresh stale prices ───────────────────────────────────────────────
  const investmentAssets = store.assets.readInvestmentAssetsWithMeta();
  const initialCache = store.operations.readAllPriceCacheEntries();

  const { priceCache, errors: priceErrors } = await refreshPrices({
    cacheEntries: initialCache,
    assets: investmentAssets,
    nowIso: now,
  });
  let pricingErrors = priceErrors;

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

  // ── 1b. Refresh stale coin-collection valuations (PRD #166) ───────────────
  // Decoupled from position sync: rides the same daily pass, recomputing metal
  // value from the daily spot and refetching numismatic estimates only past their
  // long TTL. Degrades to last-known on a Numista outage; runs before snapshot
  // capture so today's snapshot freezes the freshly-valued coins.
  if (input.refreshCoinValuations) {
    const { errors } = await input.refreshCoinValuations();
    pricingErrors = [...pricingErrors, ...errors];
  }

  // ── 1c. Refresh stale Binance sources (PRD #245 S4) ───────────────────────
  // Keeps connected Binance accounts current on the same daily pass: re-reads
  // each stale source's balances and re-values them LIVE (ADR 0021). Degrades to
  // last-known on an outage (never zeroed); runs before snapshot capture so
  // today's snapshot freezes the freshly-valued holdings.
  if (input.refreshBinanceSources) {
    const { errors } = await input.refreshBinanceSources();
    pricingErrors = [...pricingErrors, ...errors];
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
  //
  // The dashboard needs two things off the investment positions per request: the
  // UNSCOPED capture details that freeze every scope's snapshot rows, and the
  // SELECTED scope's positions for the dashboard state (read in §4). Both derive
  // from the same raw operations and the same price rule (ADR 0006), so we build
  // the projection once and reuse it (#208) instead of reading every operation
  // twice. The selected-scope positions narrow the same per-asset figures; the
  // capture details stay byte-identical to the old unscoped readPositions() map.
  const scopedProjection = store.snapshots.readScopedPositionsWithDetails(
    selectedScope?.id,
  );
  const investmentDetails: ReadonlyMap<string, InvestmentCaptureDetail> =
    scopedProjection.details;

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

    store.snapshots.saveSnapshot({
      holdings: capture.holdings,
      replace: capture.replace,
      snapshot: capture.snapshot,
    });
  }

  // ── 4. Collect remaining data for state assembly ─────────────────────────
  // The selected scope's positions came from the same projection as the capture
  // details above (#208) — no second operation read. Empty when there is no scope
  // (matching the prior `selectedScope ? … : []`).
  const positions = selectedScope ? scopedProjection.positions : [];
  const overrides = store.readWarningOverrides();
  const fireConfig = store.readFireConfig();
  const snapshots = selectedScope ? store.snapshots.readSnapshots(selectedScope.id) : [];

  // Frozen holding rows of the scope, read once and shared by the composition
  // chart (always) and the drilldown (when active). Housing is its own rung now
  // (ADR 0022): the chart buckets it by rung and the drill selects it by rung, so
  // no by-id housing carve is threaded through any more.
  const holdingRows = selectedScope
    ? store.snapshots.readSnapshotHoldings({ scopeId: selectedScope.id })
    : [];
  const activeRange = range ?? "all";

  // ── 4a. Range window (#144) — owned ONCE here, fed to both consumers ──────
  // The active range's cutoff and the holding rows it keeps are computed a single
  // time and shared by the composition chart and the drilldown, so neither
  // re-derives the window. A null cutoff (`all`) keeps the full history. The
  // composition still buckets the windowed snapshots by density internally, but
  // it now reads the SAME windowed rows the drill does — every plotted close
  // sits inside the window, so its rows survive regardless (byte-identical).
  const rangeCutoff = rangeStartMonthKey(input.today, activeRange);
  const windowedRows = rangeCutoff
    ? holdingRows.filter((row) => row.dateKey.slice(0, 7) >= rangeCutoff)
    : holdingRows;

  // ── 4b. Composition chart (#142, #144) — windowed net-worth composition ──
  // The selected range windows the series; density then adapts to the span.
  const compositionSeries = buildCompositionSeries({
    range: activeRange,
    rows: windowedRows,
    snapshots,
    today: input.today,
  });

  // The ranges worth offering: bounded ranges only when the history exceeds
  // them (else they'd equal "all"), plus "all" (#144). Span = earliest capture
  // to today, in months.
  const earliestMonthKey = snapshots.reduce<string | null>(
    (earliest, snapshot) =>
      earliest === null || snapshot.monthKey < earliest ? snapshot.monthKey : earliest,
    null,
  );
  const compositionRanges = availableCompositionRanges(
    earliestMonthKey ? monthsBetween(earliestMonthKey, input.today.slice(0, 7)) : 0,
  );

  // ── 4c. Drilldown (#76, #77, #145) — drill view state from frozen rows ───
  // Reads the SAME windowed rows the composition chart does (§4a), so a drill
  // always mirrors the chart's window — one window owner, two consumers.
  // Only currently-held holdings get per-holding cards now (this design pass):
  // Papelera (soft-deleted, #268) AND retired holdings are dropped from the
  // grid, their history living on in the aggregate. Read trash only when a
  // drill is open.
  const trash =
    drill && selectedScope ? store.readTrash() : { assets: [], liabilities: [] };
  const drilldown =
    drill && selectedScope
      ? buildDrilldown(drill, {
          currentHoldingIds: [
            ...assets.map((asset) => asset.id),
            ...liabilities.map((liability) => liability.id),
          ],
          rows: windowedRows,
          trashedHoldingIds: [
            ...trash.assets.map((asset) => asset.id),
            ...trash.liabilities.map((liability) => liability.id),
          ],
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

  // ── 6. Headline delta chips (#244) — framed figures, computed once ────────
  // The two hero chips are figure math (snapshots + framing), so they live
  // behind the contract instead of in the page: the page renders, never derives.
  const headlineDeltas: FramedSnapshotDeltas = state.deltas
    ? deriveFramedSnapshotDeltas(state.deltas, selectedView)
    : { sinceMonthlyClose: null, sincePrevious: null };

  return {
    ...state,
    compositionRanges,
    compositionSeries,
    drilldown,
    headlineDeltas,
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
    compositionRanges: [],
    compositionSeries: [],
    drilldown: null,
    headlineDeltas: { sinceMonthlyClose: null, sincePrevious: null },
    needsOnboarding: true,
    pricingErrors,
  };
}
