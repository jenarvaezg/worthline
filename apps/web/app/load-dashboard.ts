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
import { captureDailySnapshotForWorkspace } from "@worthline/db";
import type {
  AssetPrice,
  BenchmarkComparisonResult,
  CompositionRange,
  DatedSnapshotHoldingRow,
  DrilldownKey,
  DrilldownState,
  NetWorthFraming,
} from "@worthline/domain";
import {
  availableCompositionRanges,
  buildCompositionSeries,
  buildDrilldown,
  collectHoldingPayouts,
  compareGrowthToBenchmark,
  deriveFramedSnapshotDeltas,
  listScopeOptions,
  monthsBetween,
  portfolioReturnsView,
  prepareDashboardState,
  rangeStartMonthKey,
} from "@worthline/domain";
import type {
  CompositionSeriesPoint,
  DashboardState,
  DatedPayout,
  FramedSnapshotDeltas,
  HoldingReturnsView,
  LocalPersistenceStatus,
} from "@worthline/domain";

import { buildMatrixCells, type MatrixCellPayload } from "./dashboard-cells";
import { cellKey, crossOf, parseMode, type MatrixCoord } from "./dashboard-matrix";

const SPANISH_CPI_SERIES_ID = "ipc-es";

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
  /** Optional CPI benchmark read from the control plane (ADR 0060). */
  readBenchmarkPrices?: (
    seriesId: string,
  ) => Promise<Array<{ dateKey: string; value: string }>>;
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
   * Portfolio investment returns (#551, ADR 0040): the three present-time measures
   * over every operation-bearing holding, for the hero's returns line. Whole-
   * portfolio (unscoped) — returns are intrinsic to the investments, not a
   * member's slice. Null when there are no operation-bearing investments.
   */
  portfolioReturns: HoldingReturnsView | null;
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
   * Frozen rows read for the selected scope during this dashboard load. Shared
   * by composition/drill data and page-level movers (#571).
   */
  snapshotHoldingRows: DatedSnapshotHoldingRow[];
  /** The actual active range after defaulting omitted `range` to a bounded window. */
  activeCompositionRange: CompositionRange;
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
  /** Net worth vs CPI over the same active window as the Evolución chart. */
  benchmarkComparison: BenchmarkComparisonResult;
}

export async function loadDashboard(
  input: LoadDashboardInput,
): Promise<LoadDashboardResult> {
  const { store, persistence, scopeId, selectedView, drill, range, now, refreshPrices } =
    input;

  // ── 1. Refresh stale prices ───────────────────────────────────────────────
  // TX-safety: no transaction is open during the read phase; these two are
  // independent and can race freely.
  const [investmentAssets, initialCache] = await Promise.all([
    store.assets.readInvestmentAssetsWithMeta(),
    store.operations.readAllPriceCacheEntries(),
  ]);

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

  // Build the projection context ONCE (dedup #566): the only writes to the four
  // underlying tables (operations, investment meta, price cache, ownerships) in a
  // cold load are the `upsertPrice` calls in §1 above, which have all committed
  // before this point. A single shared context is therefore byte-identical to the
  // two separate builds that `readAssets` and `readScopedPositionsWithDetails`
  // would otherwise each perform. `hasInvestments = true` (the union) means the
  // three investment-only reads run even when there are no investments — a
  // negligible one-time cost for empty maps, still cheaper than two full builds.
  const projectionContext = await store.snapshots.buildProjectionContext();

  const dateKey = now.slice(0, 10);
  // The live figures use the same curve-valued ledger as snapshot capture:
  // housing appreciation and modelled debt balances are sampled at the dashboard
  // date, while model-less holdings keep their stored current value/balance.
  const { assets, liabilities } = await store.snapshots.readCurveValuedHoldingsAtDate(
    dateKey,
    projectionContext,
  );
  const scopes = listScopeOptions(workspace);
  const selectedScope = scopes.find((s) => s.id === scopeId) ?? scopes[0];

  // ── 3. Snapshot capture — self-heal only (ADR 0037, PRD #528 S3) ───────────
  // The daily cron (S2, #530) is the floor: it records every scope's
  // close-of-day snapshot whether or not anyone signs in. So the render captures
  // ONLY when today's snapshot is still absent for the scope — a self-heal if the
  // cron has not yet run — and no-ops otherwise (the common load). This takes the
  // per-scope saveSnapshot writes (~6 serial round-trips/scope) off the critical
  // path of the streamed figures (#485); the figures are computed live and never
  // depend on the write. A declared dated fact (operation, valuation anchor,
  // housing valuation) still ripples today's snapshot immediately via its own
  // seam (ADR 0012 / ADR 0020) — unchanged. The 21:00 cron overrides this
  // provisional intraday point with the day's close (latest-wins, ADR 0005).
  //
  // The existence check is free: these are the selected scope's snapshots the
  // histórico chart already needs (reused in §4, NOT re-read). On the rare
  // self-heal we re-read so the chart includes today's freshly-captured point.
  let snapshots = selectedScope
    ? await store.snapshots.readSnapshots(selectedScope.id)
    : [];
  if (selectedScope && !snapshots.some((snapshot) => snapshot.dateKey === dateKey)) {
    await captureDailySnapshotForWorkspace(store, now, projectionContext);
    snapshots = await store.snapshots.readSnapshots(selectedScope.id);
  }

  // ── 4. Collect remaining data for state assembly ─────────────────────────

  // The selected scope's positions for the dashboard state (#208), narrowing the
  // same shared projection built in §2 — no extra operation read (dedup #566).
  const scopedProjection = await store.snapshots.readScopedPositionsWithDetails(
    selectedScope?.id,
    projectionContext,
  );
  const positions = selectedScope ? scopedProjection.positions : [];

  // Portfolio investment returns for the hero's returns line (#551, ADR 0040):
  // folds every operation-bearing holding through the return engine, reusing the
  // shared context (no extra operation read). Whole-portfolio, not scope-weighted
  // — a fund's return is the same figure whoever owns which share.
  // ponytail: unscoped portfolio return; per-member-scope weighting is deferred
  // until a scoped consumer needs it (household member scopes are the edge case).
  // Recorded payouts (one-offs + derived occurrences up to today) enter the
  // hero's money-weighted return and realized gain so distributing holdings stop
  // understating (#657, ADR 0054). Keyed by holding id, as operationsByAsset is.
  const [payoutRecords, payoutSchedules] = await Promise.all([
    store.payouts.readPayouts(),
    store.payouts.readPayoutSchedules(),
  ]);
  const payoutsByAsset = new Map<string, DatedPayout[]>(
    [...collectHoldingPayouts(payoutRecords, payoutSchedules, dateKey)].map(
      ([assetId, rows]) => [
        assetId,
        rows.map((row) => ({ amountMinor: row.amountMinor, date: row.dateISO })),
      ],
    ),
  );
  const portfolioReturns = portfolioReturnsView({
    cachedPriceByAsset: projectionContext.cachedPriceByAsset,
    currency: workspace.baseCurrency,
    manualPriceByAsset: projectionContext.manualPriceByAsset,
    operationsByAsset: projectionContext.operationsByAsset,
    payoutsByAsset,
    valuationDate: dateKey,
  });

  // ── §4 parallel reads — mutually independent ─────────────────────────────
  // `snapshots` was already read in §3 (the capture-existence check doubles as
  // the chart read), so it is not re-read here.
  // TX-safety: these reads run after any saveSnapshot() above has committed its
  // own transaction, so no interactive tx is open here. ctx.getWorkspace() is
  // promise-memoized (Step 0), making concurrent internal calls safe.
  const [overrides, fireConfig, goals] = await Promise.all([
    store.readWarningOverrides(),
    store.readFireConfig(),
    // Goals for the selected scope (#426): reserve capital against FIRE eligibility.
    selectedScope ? store.goals.readGoals(selectedScope.id) : Promise.resolve([]),
  ]);

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
  const activeRange = range ?? compositionRanges[0] ?? "all";
  const eagerRanges =
    compositionRanges.length === 1 || activeRange === "all"
      ? compositionRanges
      : compositionRanges.filter((offered) => offered !== "all");
  const longestEagerRange =
    activeRange === "all"
      ? "all"
      : (eagerRanges.filter((offered) => offered !== "all").at(-1) ?? activeRange);
  const holdingRowsFrom = rangeStartMonthKey(input.today, longestEagerRange);
  // Frozen holding rows of the scope, read once and shared by the composition
  // chart, drilldown matrix, and page-level movers (#571). When `all` is lazy,
  // this read is bounded to the longest eager range; `/api/dashboard/cells`
  // reads the full history only when the user selects `range=all` (#572).
  const holdingRows = selectedScope
    ? await store.snapshots.readSnapshotHoldings({
        ...(holdingRowsFrom ? { from: `${holdingRowsFrom}-01` } : {}),
        scopeId: selectedScope.id,
      })
    : [];

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
  const benchmarkComparison = await buildBenchmarkComparison({
    readBenchmarkPrices: input.readBenchmarkPrices,
    series: compositionSeries,
  });

  // ── 4b′. Per-range series (S3 #519 / #572) ───────────────────────────────
  // Ship the eager ranges the client can switch instantly. `all` is omitted from
  // default bounded loads and fetched on demand through /api/dashboard/cells; an
  // explicit `range=all` deep-link still keys it here for server render safety.
  const seriesRanges = eagerRanges.includes(activeRange)
    ? eagerRanges
    : [...eagerRanges, activeRange];
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
    ...crossOf(currentCell, eagerRanges),
    ...eagerRanges.map((offered) => ({ mode: "chart" as const, range: offered })),
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
    activeCompositionRange: activeRange,
    benchmarkComparison,
    compositionRanges,
    compositionSeries,
    compositionSeriesByRange,
    drilldown,
    headlineDeltas,
    matrixCells,
    needsOnboarding: false,
    portfolioReturns,
    pricingErrors,
    snapshotHoldingRows: holdingRows,
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
    activeCompositionRange: "all",
    benchmarkComparison: {
      comparison: null,
      unavailableReason: "benchmark_unavailable",
    },
    compositionRanges: [],
    compositionSeries: [],
    compositionSeriesByRange: {},
    drilldown: null,
    headlineDeltas: { sinceMonthlyClose: null, sincePrevious: null },
    matrixCells: {},
    needsOnboarding: true,
    portfolioReturns: null,
    pricingErrors,
    snapshotHoldingRows: [],
  };
}

async function buildBenchmarkComparison(input: {
  readBenchmarkPrices: LoadDashboardInput["readBenchmarkPrices"];
  series: CompositionSeriesPoint[];
}): Promise<BenchmarkComparisonResult> {
  if (!input.readBenchmarkPrices) {
    return { comparison: null, unavailableReason: "benchmark_unavailable" };
  }

  try {
    const benchmark = (await input.readBenchmarkPrices(SPANISH_CPI_SERIES_ID))
      .map((point) => ({
        dateKey: point.dateKey,
        value: Number(point.value),
      }))
      .filter((point) => Number.isFinite(point.value));

    return compareGrowthToBenchmark({
      benchmark,
      subject: input.series.map((point) => ({
        dateKey: point.dateKey,
        value: point.netWorthMinor,
      })),
    });
  } catch {
    return { comparison: null, unavailableReason: "benchmark_unavailable" };
  }
}
