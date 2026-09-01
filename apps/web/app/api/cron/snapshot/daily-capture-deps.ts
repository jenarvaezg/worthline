import { buildMissedCaptureAlerts } from "@web/admin/missed-capture-alert";
import { buildSourceSyncAlerts } from "@web/admin/source-sync-alert";
import { runBinanceRefresh } from "@web/ajustes/binance-refresh";
import { runNumistaCoinRefresh } from "@web/ajustes/numista-coin-refresh";
import { withControlPlaneStore } from "@web/control-plane-store";
import { isPremiumIngestionAllowed } from "@web/entitlements/effective-plan";
import { openAuthorizedStore } from "@web/principal";
import {
  type BenchmarkPriceCache,
  type DailyCaptureFetchedPrice,
  type DailyCaptureLog,
  deriveEffectivePlan,
  type EntitlementDirectory,
  type JobStore,
  type MaintainerAlertLog,
  type RunDailyCaptureDeps,
  type TenancyDirectory,
} from "@worthline/db";
import {
  benchmarkCatalogEntryBySeriesId,
  listMarketIndexSeriesIds,
} from "@worthline/domain";
import {
  fetchSpanishCpi,
  fetchYahooMonthlyBenchmark,
  refreshStalePrices,
} from "@worthline/pricing";

type CronEnv = Record<string, string | undefined>;
const SPANISH_CPI_SERIES_ID = "ipc-es";

/** The exact control-plane surface the daily capture touches — nothing wider. */
type DailyCaptureControlPlane = Pick<TenancyDirectory, "listAllWorkspaces"> &
  Pick<EntitlementDirectory, "readWorkspaceEntitlement"> &
  Pick<MaintainerAlertLog, "raiseMaintainerAlert"> &
  Pick<JobStore, "readLatestJobDedupeKey"> &
  DailyCaptureLog &
  BenchmarkPriceCache;

/**
 * Wire the real dependencies for the daily-capture cron (ADR 0037, PRD #528).
 * The system actor lists every workspace from the control plane and opens each
 * per-workspace database through the authorization port as an explicit `system`
 * principal (#998 S2) — with that workspace's scoped Turso JWT (#1185) and no
 * session, a narrow, capture-only cross-tenant path.
 *
 * `now` is the real wall clock: the job must never honor WORTHLINE_DEMO_NOW (it
 * would pin a frozen demo date into production snapshots). Demo workspaces are
 * ephemeral/in-memory and never enumerated here, so they are skipped by
 * construction.
 */
export function buildDailyCaptureDeps(
  env: CronEnv = process.env,
  opts: { now?: string } = {},
): RunDailyCaptureDeps {
  const groupToken = env["WORTHLINE_DB_AUTH_TOKEN"];
  const now = opts.now ?? new Date().toISOString();

  /**
   * The cron's control-plane port: every dep below is one short-lived connection
   * (the pass spans hours; holding one open across it would be the leak). Before
   * #1694 the open/try/finally block was written out seven times in this object;
   * now each dep is one call to the shared helper.
   */
  const withCron = <T>(
    run: (store: DailyCaptureControlPlane) => Promise<T>,
  ): Promise<T> =>
    withControlPlaneStore<T, DailyCaptureControlPlane>(run, {
      env,
      purpose: "Daily capture",
    });

  return {
    // The daily-capture job pins its capture instant at ENQUEUE time (S4 #1064) and
    // carries it in the payload, so a worker draining later derives the same
    // date/run-key/snapshot instant it deduped on (never the drain clock). Falls
    // back to the wall clock for a direct, un-queued call.
    now,
    listAllWorkspaces: () =>
      withCron(async (controlPlane) => {
        const workspaces = await controlPlane.listAllWorkspaces();
        return workspaces.map((w) => ({
          id: w.id,
          dbUrl: w.dbUrl,
          // Prefer the per-database JWT; fall back to the group token only for
          // pre-#1185 rows that have not been backfilled yet.
          ...(w.dbAuthToken
            ? { authToken: w.dbAuthToken }
            : groupToken
              ? { authToken: groupToken }
              : {}),
        }));
      }),
    // Premium gate (#1162): a workspace whose plan has lapsed to free keeps its
    // ingested data, but its connected sources are PAUSED — the cron skips their
    // sync so nothing new is ingested, while the snapshot still freezes
    // last-known values. Derived server-side from the entitlement row (S1).
    shouldSyncConnectedSources: (workspace) =>
      withCron(async (controlPlane) => {
        const entitlement = await controlPlane.readWorkspaceEntitlement(workspace.id);
        return isPremiumIngestionAllowed(deriveEffectivePlan(entitlement, now));
      }),
    isRunFinalized: (runKey) =>
      withCron((controlPlane) => controlPlane.hasDailyCaptureRun(runKey)),
    markRunFinalized: (runKey, finalizedAt) =>
      withCron((controlPlane) => controlPlane.recordDailyCaptureRun(runKey, finalizedAt)),
    // Missed-pass detection (#1339). Vercel Cron is best-effort on the current
    // plan: whole passes are never invoked (evidence on the issue) and the loss is
    // invisible today. The baseline is the durable QUEUE, exactly the table that
    // evidence came from: every invocation enqueues its pass under the run key as
    // dedupe key before doing anything else, so the newest key below this pass is
    // the last pass that actually arrived. The gap is raised as a maintainer alert
    // on the control plane — no new table, no new dependency, nothing user-facing.
    readLatestInvokedPass: (before) =>
      withCron((controlPlane) =>
        controlPlane.readLatestJobDedupeKey({ kind: "daily-capture", before }),
      ),
    reportMissedPasses: (report) =>
      withCron(async (controlPlane) => {
        // One alert per missed pass, keyed so a re-detection accumulates an
        // occurrence instead of minting a duplicate (see the alert contract).
        for (const alert of buildMissedCaptureAlerts(report)) {
          await controlPlane.raiseMaintainerAlert(alert);
        }
      }),
    // The consumer `sourceSyncFailures` never had (#1755). One alert per degraded
    // workspace, keyed so repeated nights accumulate occurrences on one incident
    // instead of minting a new alert each time. The engine contains a throw here,
    // so a control-plane hiccup costs the alert and nothing else.
    reportSourceSyncFailures: (failures) =>
      withCron(async (controlPlane) => {
        for (const alert of buildSourceSyncAlerts(failures, now)) {
          await controlPlane.raiseMaintainerAlert(alert);
        }
      }),
    listBenchmarkSeries: async () => [
      { id: SPANISH_CPI_SERIES_ID },
      ...listMarketIndexSeriesIds().map((id) => ({ id })),
    ],
    readBenchmarkPrices: (seriesId) =>
      withCron((controlPlane) => controlPlane.readBenchmarkPrices(seriesId)),
    fetchBenchmarkPrices: async (series) => {
      if (series.id === SPANISH_CPI_SERIES_ID) {
        return fetchSpanishCpi();
      }
      const entry = benchmarkCatalogEntryBySeriesId(series.id);
      if (!entry) return [];
      return fetchYahooMonthlyBenchmark(entry.yahooSymbol);
    },
    saveBenchmarkPrices: (seriesId, prices) =>
      withCron((controlPlane) => controlPlane.upsertBenchmarkPrices(seriesId, prices)),
    // The cron is a `system` actor: it carries its own workspace coordinates
    // (per-workspace URL + scoped Turso JWT) rather than resolving them from a
    // request, and opens each workspace THROUGH the authorization port like
    // every other surface (#998 S2) — never a raw DB open.
    openStore: (workspace) =>
      openAuthorizedStore({
        kind: "system",
        options: {
          url: workspace.dbUrl,
          ...(workspace.authToken ? { authToken: workspace.authToken } : {}),
        },
      }),
    // Source-sync phase (#895): the same stale-gated orchestrations the GET used
    // to run, now on the cron. Each isolates per source and degrades to
    // last-known (never 0) on a Binance/Numista outage — the errors are
    // collected for observability, never thrown.
    syncConnectedSources: async (store, now) => {
      const [binance, numista] = await Promise.all([
        runBinanceRefresh(store, now),
        runNumistaCoinRefresh(store, now),
      ]);
      return { errors: [...binance.errors, ...numista.errors] };
    },
    fetchPrices: async (pairs, now): Promise<DailyCaptureFetchedPrice[]> => {
      if (pairs.length === 0) return [];

      const syntheticAssets = pairs.map((pair, index) => ({
        id: `daily:${index}`,
        currency: pair.currency,
        priceProvider: pair.provider,
        providerSymbol: pair.symbol,
      }));
      const result = await refreshStalePrices([], syntheticAssets, now, {
        force: true,
      });

      return result.refreshed.map((price, index) => {
        const pair = pairs[index]!;
        return {
          provider: pair.provider,
          symbol: pair.symbol,
          currency: price.currency,
          fetchedAt: price.fetchedAt,
          freshnessState: price.freshnessState,
          price: price.price,
          source: price.source,
          ...(price.priceDate ? { priceDate: price.priceDate } : {}),
          ...(price.staleReason ? { staleReason: price.staleReason } : {}),
        };
      });
    },
  };
}
