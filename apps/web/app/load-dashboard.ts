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
  CoinPosition,
  CompositionRange,
  DrilldownKey,
  DrilldownState,
  InvestmentCaptureDetail,
  LiquidityTier,
  NetWorthFraming,
  SnapshotPositionInput,
  TokenPosition,
} from "@worthline/domain";
import {
  availableCompositionRanges,
  buildCompositionSeries,
  buildDrilldown,
  captureSnapshotForScope,
  coinPositionSnapshotInput,
  deriveFramedSnapshotDeltas,
  listScopeOptions,
  monthsBetween,
  prepareDashboardState,
  rangeStartMonthKey,
  tokenPositionSnapshotInput,
} from "@worthline/domain";
import type {
  CompositionSeriesPoint,
  DashboardState,
  FramedSnapshotDeltas,
  LocalPersistenceStatus,
} from "@worthline/domain";

import { buildMatrixCells, type MatrixCellPayload } from "./dashboard-cells";
import { cellKey, crossOf, parseMode, type MatrixCoord } from "./dashboard-matrix";

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
   * The composition series precomputed for EACH offered range (S3 #519, ADR
   * 0036): the client range island switches between these with no round-trip
   * (the #518 pattern — ship the alternatives, toggle in the browser). Keyed by
   * exactly the `compositionRanges`; the active range's entry equals
   * `compositionSeries`. Empty `{}` when there is no scope.
   */
  compositionSeriesByRange: Partial<Record<CompositionRange, CompositionSeriesPoint[]>>;
  /**
   * The initial matrix cross (S4 #520, ADR 0038): the composition cells (chart
   * series / drilldowns) reachable in one click from the URL's cell — the
   * current column + the full chart row — keyed by `cellKey`. The client island
   * seeds its cache with these and prefetches the next cross from the read API.
   * Empty `{}` when there is no scope.
   */
  matrixCells: Record<string, MatrixCellPayload>;
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
  const investmentAssets = await store.assets.readInvestmentAssetsWithMeta();
  const initialCache = await store.operations.readAllPriceCacheEntries();

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
      await store.operations.upsertPrice(price);
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
  const workspace = await store.workspace.readWorkspace();

  if (!workspace) {
    // Return a minimal result that signals the page to redirect.
    return buildEmptyResult(persistence, pricingErrors);
  }

  const assets = await store.assets.readAssets();
  const liabilities = await store.liabilities.readLiabilities();
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
  const scopedProjection = await store.snapshots.readScopedPositionsWithDetails(
    selectedScope?.id,
  );
  const investmentDetails: ReadonlyMap<string, InvestmentCaptureDetail> =
    scopedProjection.details;

  // Per-connected-source position breakdown (ADR 0035): freeze each connected
  // holding's per-position values into the snapshot, keyed by the materialized
  // asset id so `buildSnapshotHoldingRows` attaches them as child rows. Shared
  // across scopes like `investmentDetails`; the capture scope-allocates down.
  // Numista freezes one row per coin (frozen `max(metal, numismatic)`, PRD #459
  // S1); Binance freezes one row per token (live `balance × price`, PRD #459 S2).
  const positionDetails = new Map<string, SnapshotPositionInput[]>();
  for (const source of await store.connectedSources.listSources()) {
    if (source.adapter === "numista") {
      const coins = (await store.connectedSources.readPositions(source.id)).filter(
        (position): position is CoinPosition => position.kind === "coin",
      );
      if (coins.length > 0) {
        positionDetails.set(source.assetId, coins.map(coinPositionSnapshotInput));
      }
    } else if (source.adapter === "binance") {
      // Binance varies live and spans rungs (ADR 0021, #248): freeze the per-token
      // breakdown beneath EACH materialized rung holding (market + term-locked), so
      // each token's contribution lands under the holding it actually rolls up into.
      const tokens = (await store.connectedSources.readPositions(source.id)).filter(
        (position): position is TokenPosition => position.kind === "token",
      );
      if (tokens.length === 0) continue;
      // Map each occupied rung to the source's asset materialized on it — the
      // source's assets carry their rung as their liquidity tier, one per rung.
      const sourceAssetIds = new Set(
        await store.connectedSources.listSourceAssetIds(source.id),
      );
      const assetIdByTier = new Map<LiquidityTier, string>();
      for (const asset of assets) {
        if (sourceAssetIds.has(asset.id)) {
          assetIdByTier.set(asset.liquidityTier, asset.id);
        }
      }
      const tokensByTier = new Map<LiquidityTier, TokenPosition[]>();
      for (const token of tokens) {
        const rung = tokensByTier.get(token.liquidityTier);
        if (rung) rung.push(token);
        else tokensByTier.set(token.liquidityTier, [token]);
      }
      for (const [tier, group] of tokensByTier) {
        const assetId = assetIdByTier.get(tier);
        if (assetId) {
          positionDetails.set(assetId, group.map(tokenPositionSnapshotInput));
        }
      }
    }
  }

  for (const scope of scopes) {
    const capture = captureSnapshotForScope({
      assets,
      capturedAt: now,
      existingSnapshots: await store.snapshots.readSnapshots(scope.id),
      investmentDetails,
      liabilities,
      positionDetails,
      scope,
      workspace,
    });

    await store.snapshots.saveSnapshot({
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
  const overrides = await store.readWarningOverrides();
  const fireConfig = await store.readFireConfig();
  // Goals for the selected scope (#426): reserve capital against FIRE eligibility.
  const goals = selectedScope ? await store.goals.readGoals(selectedScope.id) : [];
  const snapshots = selectedScope
    ? await store.snapshots.readSnapshots(selectedScope.id)
    : [];

  // Frozen holding rows of the scope, read once and shared by the composition
  // chart (always) and the drilldown (when active). Housing is its own rung now
  // (ADR 0022): the chart buckets it by rung and the drill selects it by rung, so
  // no by-id housing carve is threaded through any more.
  const holdingRows = selectedScope
    ? await store.snapshots.readSnapshotHoldings({ scopeId: selectedScope.id })
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

  // ── 4b′. Per-range series (S3 #519) — the alternatives the client switches ──
  // One series per OFFERED range, so a range pill toggles client-side with no
  // round-trip (interaction-patterns §2). Each builds from the FULL rows: the
  // series only plots row-backed closes inside its own window, so a per-range
  // window over the full rows is byte-identical to windowing the rows first. The
  // active range reuses the series already built above instead of rebuilding it,
  // and is ALWAYS keyed — even if it is not an offered pill (e.g. a deep-link to
  // a range narrower than the history) — so the island never renders an empty
  // chart for the window the URL asked for.
  const seriesRanges = compositionRanges.includes(activeRange)
    ? compositionRanges
    : [...compositionRanges, activeRange];
  const compositionSeriesByRange = Object.fromEntries(
    seriesRanges.map((offered) => [
      offered,
      offered === activeRange
        ? compositionSeries
        : buildCompositionSeries({
            range: offered,
            rows: holdingRows,
            snapshots,
            today: input.today,
          }),
    ]),
  ) as Partial<Record<CompositionRange, CompositionSeriesPoint[]>>;

  // ── 4c. Drilldown (#76, #77, #145) — drill view state from frozen rows ───
  // Reads the SAME windowed rows the composition chart does (§4a), so a drill
  // always mirrors the chart's window — one window owner, two consumers.
  // Only currently-held holdings get per-holding cards now (this design pass):
  // Papelera (soft-deleted, #268) AND retired holdings are dropped from the
  // grid, their history living on in the aggregate. Trash is read whenever there
  // is a scope now (S4 #520): the initial matrix cross always ships the drill
  // COLUMN, so the drill builders always need the trashed ids.
  const trash = selectedScope ? await store.readTrash() : { assets: [], liabilities: [] };
  const currentHoldingIds = [
    ...assets.map((asset) => asset.id),
    ...liabilities.map((liability) => liability.id),
  ];
  const trashedHoldingIds = [
    ...trash.assets.map((asset) => asset.id),
    ...trash.liabilities.map((liability) => liability.id),
  ];
  const drilldown =
    drill && selectedScope
      ? buildDrilldown(drill, {
          currentHoldingIds,
          rows: windowedRows,
          trashedHoldingIds,
        })
      : null;

  // ── 4d. Initial matrix cross (S4 #520, ADR 0038) — the cells the island can
  // reach in one click from the URL's cell: the current column (every mode at
  // the active range) + the full chart row (every offered range), so opening any
  // drill or toggling any range is instant with no round-trip. The island
  // prefetches the next cross from /api/dashboard/cells on each move.
  const currentCell: MatrixCoord = { mode: parseMode(drill), range: activeRange };
  const shipByKey = new Map<string, MatrixCoord>();
  for (const coord of [
    ...crossOf(currentCell, compositionRanges),
    ...compositionRanges.map((offered) => ({ mode: "chart" as const, range: offered })),
  ]) {
    shipByKey.set(cellKey(coord), coord);
  }
  const matrixCells = selectedScope
    ? buildMatrixCells(
        [...shipByKey.values()],
        { snapshots, holdingRows, currentHoldingIds, trashedHoldingIds },
        input.today,
      )
    : {};

  // ── 5. Compute dashboard state ────────────────────────────────────────────
  const state = prepareDashboardState({
    assets,
    fireConfig,
    goals,
    liabilities,
    overrides,
    persistence,
    positions,
    priceCache,
    scopes,
    selectedScope,
    selectedView,
    snapshots,
    today: input.today,
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
    compositionSeriesByRange,
    drilldown,
    headlineDeltas,
    matrixCells,
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
    compositionSeriesByRange: {},
    drilldown: null,
    headlineDeltas: { sinceMonthlyClose: null, sincePrevious: null },
    matrixCells: {},
    needsOnboarding: true,
    pricingErrors,
  };
}
