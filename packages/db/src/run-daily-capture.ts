import type { AssetPrice, InvestmentPriceProvider } from "@worthline/domain";
import type { InvestmentAssetMeta } from "./asset-store";
import { captureDailySnapshotForWorkspace } from "./capture-daily-snapshot";
import type { WorthlineStore } from "./store-types";
import { dailyCaptureRunKey, type SyncJobResult } from "./sync-job";

/** A workspace the cron must capture — its id and per-workspace database URL. */
export interface DailyCaptureWorkspace {
  id: string;
  dbUrl: string;
}

export interface DailyCapturePricePair {
  provider: InvestmentPriceProvider;
  symbol: string;
  currency: string;
}

export interface DailyCaptureFetchedPrice extends Omit<AssetPrice, "assetId"> {
  provider: InvestmentPriceProvider;
  symbol: string;
}

export interface DailyCaptureBenchmarkSeries {
  id: string;
}

export interface DailyCaptureBenchmarkPrice {
  dateKey: string;
  value: string;
}

interface WorkspaceCapturePlan {
  workspace: DailyCaptureWorkspace;
  store: WorthlineStore;
  assets: InvestmentAssetMeta[];
}

export interface RunDailyCaptureDeps {
  /** Enumerate every real workspace (control plane). */
  listAllWorkspaces: () => Promise<DailyCaptureWorkspace[]>;
  /** Open a workspace's store with the shared group token, no session. */
  openStore: (workspace: DailyCaptureWorkspace) => Promise<WorthlineStore>;
  /**
   * Fetch every distinct provider symbol once for the whole fleet. The runner
   * fans each fetched price back out to every workspace asset that uses the pair.
   */
  fetchPrices: (
    pairs: DailyCapturePricePair[],
    now: string,
  ) => Promise<DailyCaptureFetchedPrice[]>;
  /**
   * Run-level idempotency guard: true means THIS pass already finalized. Keyed
   * by a pass-qualified run key (`YYYY-MM-DD:am|pm`, #895) so the morning
   * (provisional) and evening (close) passes finalize independently — the guard
   * still dedupes accidental double-triggers within a pass.
   */
  isRunFinalized?: (runKey: string) => Promise<boolean>;
  /** Persist successful run finalization for this pass. */
  markRunFinalized?: (runKey: string, finalizedAt: string) => Promise<void>;
  /**
   * Sync a workspace's connected sources before capture (#895): re-read Binance
   * balances and Numista/coin valuations so the snapshot freezes fresh figures.
   * Isolated per workspace here and per source inside the orchestration, which
   * degrades to last-known (never 0) on an outage rather than throwing. Optional
   * — omitted in tests that don't exercise connected sources.
   */
  syncConnectedSources?: (
    store: WorthlineStore,
    now: string,
  ) => Promise<{ errors: string[] }>;
  /**
   * Whether this workspace's connected sources may sync on this pass (PRD #1160
   * S2, #1162). A workspace whose premium has lapsed keeps every figure already
   * ingested, but its sources are PAUSED: the sync phase is skipped so no fresh
   * ingestion happens, while the snapshot still captures last-known values (the
   * manual-valuation path below is always free). Omitted → every workspace syncs
   * (tests and any deploy without entitlements). The snapshot NEVER pauses; only
   * the connected-source sync does.
   */
  shouldSyncConnectedSources?: (workspace: DailyCaptureWorkspace) => Promise<boolean>;
  /** Catalog series fetched into the shared control-plane benchmark cache. */
  listBenchmarkSeries?: () => Promise<DailyCaptureBenchmarkSeries[]>;
  /** Existing cached rows for one benchmark series. */
  readBenchmarkPrices?: (
    seriesId: string,
  ) => Promise<Array<DailyCaptureBenchmarkPrice & { seriesId: string }>>;
  /** Fetch source rows for one benchmark series. */
  fetchBenchmarkPrices?: (
    series: DailyCaptureBenchmarkSeries,
    now: string,
  ) => Promise<DailyCaptureBenchmarkPrice[]>;
  /** Persist missing benchmark rows for one series. */
  saveBenchmarkPrices?: (
    seriesId: string,
    prices: DailyCaptureBenchmarkPrice[],
  ) => Promise<void>;
  /** Real wall-clock ISO timestamp — the day's close. Never the demo pin. */
  now: string;
}

export interface DailyCaptureFailure {
  workspaceId: string;
  error: string;
}

export interface DailyCaptureBenchmarkFailure {
  seriesId: string;
  error: string;
}

/** One connected-source sync degradation for a workspace (#895). */
export interface DailyCaptureSourceSyncFailure {
  workspaceId: string;
  error: string;
}

export interface RunDailyCaptureResult {
  total: number;
  captured: number;
  failures: DailyCaptureFailure[];
  benchmarkFailures: DailyCaptureBenchmarkFailure[];
  /**
   * Per-workspace connected-source sync degradations (#895). These NEVER count
   * as capture failures — the snapshot still freezes last-known values — so they
   * do not block run finalization; they are surfaced for observability only.
   */
  sourceSyncFailures: DailyCaptureSourceSyncFailure[];
  dateKey?: string;
  skipped?: boolean;
}

/**
 * Fleet daily snapshot capture (ADR 0037, PRD #528, #895). Runs twice a day
 * (≈09:00 provisional + ≈21:00 close, latest-wins ADR 0005); the pass-qualified
 * finalization guard lets both passes run while still short-circuiting redundant
 * triggers within a pass. Each pass: collects the fleet-wide union of
 * market-price provider symbols and fetches each unique pair once; then, per
 * workspace, syncs its connected sources (re-reading STALE Binance/Numista
 * sources past their daily TTL so the snapshot freezes fresh figures when due —
 * a source refreshed by the earlier pass stays put), persists the fresh market
 * prices, and captures the day's snapshot **unconditionally**. Per-workspace
 * failures are isolated: one unreachable tenant never blocks the rest, and a
 * connected-source outage degrades to last-known (never 0) without failing the
 * capture. This is the sole writer of snapshots — the GET is cache-only (#895).
 *
 * Pure orchestration over injected seams — no control plane, no network, no
 * clock of its own (the cron route wires the real dependencies).
 */
export async function runDailyCapture(
  deps: RunDailyCaptureDeps,
): Promise<RunDailyCaptureResult> {
  const dateKey = dateKeyFromIso(deps.now);
  const runKey = dailyCaptureRunKey(deps.now);
  if (await deps.isRunFinalized?.(runKey)) {
    return {
      total: 0,
      captured: 0,
      failures: [],
      benchmarkFailures: [],
      sourceSyncFailures: [],
      dateKey,
      skipped: true,
    };
  }

  const workspaces = await deps.listAllWorkspaces();
  const failures: DailyCaptureFailure[] = [];
  const sourceSyncFailures: DailyCaptureSourceSyncFailure[] = [];
  let captured = 0;

  const plans: WorkspaceCapturePlan[] = [];

  for (const workspace of workspaces) {
    let store: WorthlineStore | undefined;
    try {
      store = await deps.openStore(workspace);
      const assets = await store.assets.readInvestmentAssetsWithMeta();
      plans.push({ workspace, store, assets });
    } catch (error) {
      failures.push({
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
      store?.close();
    }
  }

  const uniquePairs = collectUniquePricePairs(plans);
  const fetchedPrices =
    uniquePairs.length > 0 ? await deps.fetchPrices(uniquePairs, deps.now) : [];
  const fetchedByPair = new Map(
    fetchedPrices.map((price) => [pricePairKey(price.provider, price.symbol), price]),
  );

  for (const plan of plans) {
    try {
      // ── Source-sync phase (#895) — re-read balances/valuations pre-capture ──
      // Runs BEFORE the snapshot so it freezes fresh connected-source figures.
      // Wrapped in its own guard: a sync crash must NEVER block the capture nor
      // count as a workspace failure — the snapshot still freezes last-known
      // values (never zeroed). Per-source isolation lives inside the sync.
      if (deps.syncConnectedSources) {
        // Premium gate (#1162): a lapsed-to-free workspace's sources are paused —
        // skip the sync so nothing fresh is ingested, but the snapshot below still
        // freezes last-known values. The gate reads the control plane, so its own
        // failure is contained HERE and NEVER escapes to the outer capture guard:
        // an entitlement-read hiccup skips this pass's sync (fail-closed on
        // ingestion) and is recorded as a source-sync degradation — the free
        // snapshot must still be captured, exactly like a sync-phase crash.
        let maySync = true;
        if (deps.shouldSyncConnectedSources) {
          try {
            maySync = await deps.shouldSyncConnectedSources(plan.workspace);
          } catch (error) {
            maySync = false;
            sourceSyncFailures.push({
              workspaceId: plan.workspace.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (maySync) {
          try {
            const { errors } = await deps.syncConnectedSources(plan.store, deps.now);
            for (const error of errors) {
              sourceSyncFailures.push({ workspaceId: plan.workspace.id, error });
            }
          } catch (error) {
            sourceSyncFailures.push({
              workspaceId: plan.workspace.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      const pricesToUpsert = [];
      for (const asset of plan.assets) {
        if (!asset.providerSymbol) continue;
        const fetched = fetchedByPair.get(
          pricePairKey(asset.priceProvider, asset.providerSymbol),
        );
        if (!fetched || fetched.freshnessState === "failed") continue;
        pricesToUpsert.push({
          assetId: asset.id,
          currency: fetched.currency,
          fetchedAt: fetched.fetchedAt,
          freshnessState: fetched.freshnessState,
          price: fetched.price,
          source: fetched.source,
          ...(fetched.priceDate ? { priceDate: fetched.priceDate } : {}),
          ...(fetched.staleReason ? { staleReason: fetched.staleReason } : {}),
        });
      }
      if (pricesToUpsert.length > 0) {
        await plan.store.operations.upsertPrices(pricesToUpsert);
      }
      await captureDailySnapshotForWorkspace(plan.store, deps.now);
      captured += 1;
    } catch (error) {
      failures.push({
        workspaceId: plan.workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      plan.store.close();
    }
  }

  if (failures.length === 0) {
    await deps.markRunFinalized?.(runKey, deps.now);
  }

  const benchmarkFailures = await runBenchmarkPhase(deps);

  return {
    total: workspaces.length,
    captured,
    failures,
    benchmarkFailures,
    sourceSyncFailures,
    dateKey,
  };
}

/**
 * Map a {@link RunDailyCaptureResult} onto the durable queue's typed outcome (S4
 * #1064). This is how the `daily-capture` job kind reports to the worker so the
 * store decides ack-vs-retry:
 *
 *   - `skipped` (the run-key guard already finalized this pass) → a benign no-op
 *     ack: the pass is done, so retrying would only loop. This is the composition
 *     that keeps at-least-once REDELIVERY safe — a re-leased daily-capture job
 *     re-invokes `runDailyCapture`, whose `isRunFinalized` guard short-circuits, so
 *     no second capture happens.
 *   - per-workspace capture `failures` → a RETRIABLE error. `runDailyCapture` only
 *     finalizes on zero failures, so a partial failure is genuinely un-finalized
 *     work; the queue re-enqueues it and the re-run re-captures the succeeded
 *     workspaces harmlessly (latest-wins, the sole snapshot writer) while retrying
 *     the failed ones. `sourceSyncFailures`/`benchmarkFailures` are observability
 *     only (they never block finalization), so they do NOT force a retry.
 *   - otherwise → `ok`.
 */
export function dailyCaptureJobOutcome(result: RunDailyCaptureResult): SyncJobResult {
  if (result.skipped) {
    return { reason: "no-op", status: "skipped" };
  }
  if (result.failures.length > 0) {
    return {
      cause: result,
      error: {
        code: "daily_capture_partial_failure",
        message: `daily capture failed for ${result.failures.length} workspace(s)`,
        retriable: true,
      },
      status: "error",
    };
  }
  return { status: "ok" };
}

async function runBenchmarkPhase(
  deps: RunDailyCaptureDeps,
): Promise<DailyCaptureBenchmarkFailure[]> {
  if (
    !deps.listBenchmarkSeries ||
    !deps.readBenchmarkPrices ||
    !deps.fetchBenchmarkPrices ||
    !deps.saveBenchmarkPrices
  ) {
    return [];
  }

  const failures: DailyCaptureBenchmarkFailure[] = [];
  const seriesList = await deps.listBenchmarkSeries();
  for (const series of seriesList) {
    try {
      const existing = await deps.readBenchmarkPrices(series.id);
      const existingDates = new Set(existing.map((point) => point.dateKey));
      const fetched = await deps.fetchBenchmarkPrices(series, deps.now);
      const missing = fetched.filter((point) => !existingDates.has(point.dateKey));
      if (missing.length > 0) {
        await deps.saveBenchmarkPrices(series.id, missing);
      }
    } catch (error) {
      failures.push({
        seriesId: series.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
}

function collectUniquePricePairs(plans: WorkspaceCapturePlan[]): DailyCapturePricePair[] {
  const pairs = new Map<string, DailyCapturePricePair>();
  for (const plan of plans) {
    for (const asset of plan.assets) {
      if (!asset.providerSymbol) continue;
      const key = pricePairKey(asset.priceProvider, asset.providerSymbol);
      if (pairs.has(key)) continue;
      pairs.set(key, {
        provider: asset.priceProvider,
        symbol: asset.providerSymbol,
        currency: asset.currency,
      });
    }
  }
  return [...pairs.values()];
}

function pricePairKey(provider: InvestmentPriceProvider, symbol: string): string {
  return `${provider}\0${symbol}`;
}

function dateKeyFromIso(now: string): string {
  return now.slice(0, 10);
}
