import { runBinanceRefresh } from "@web/ajustes/binance-refresh";
import { runNumistaCoinRefresh } from "@web/ajustes/numista-coin-refresh";
import { isPremiumIngestionAllowed } from "@web/entitlements/effective-plan";
import { openAuthorizedStore } from "@web/principal";
import {
  type BenchmarkPriceCache,
  createControlPlaneStore,
  type DailyCaptureFetchedPrice,
  type DailyCaptureLog,
  deriveEffectivePlan,
  type EntitlementDirectory,
  type RunDailyCaptureDeps,
  type TenancyDirectory,
} from "@worthline/db";
import {
  benchmarkCatalogEntryBySeriesId,
  listMarketIndexSeriesIds,
} from "@worthline/domain";
import {
  fetchSpanishCpi,
  fetchStooqMonthlyBenchmark,
  refreshStalePrices,
} from "@worthline/pricing";

type CronEnv = Record<string, string | undefined>;
const SPANISH_CPI_SERIES_ID = "ipc-es";

/**
 * Wire the real dependencies for the daily-capture cron (ADR 0037, PRD #528).
 * The system actor lists every workspace from the control plane and opens each
 * per-workspace database through the authorization port as an explicit `system`
 * principal (#998 S2) — with the shared group token and no session, a narrow,
 * capture-only cross-tenant path.
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
  const controlPlaneUrl = env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  const groupToken = env["WORTHLINE_DB_AUTH_TOKEN"];
  const now = opts.now ?? new Date().toISOString();
  const openControlPlane = async (): Promise<
    Pick<TenancyDirectory, "listAllWorkspaces"> &
      Pick<EntitlementDirectory, "readWorkspaceEntitlement"> &
      DailyCaptureLog &
      BenchmarkPriceCache & { close(): void }
  > => {
    if (!controlPlaneUrl) {
      throw new Error("Daily capture requires WORTHLINE_CONTROL_PLANE_DB_URL.");
    }
    return createControlPlaneStore({
      url: controlPlaneUrl,
      ...(groupToken ? { authToken: groupToken } : {}),
    });
  };

  return {
    // The daily-capture job pins its capture instant at ENQUEUE time (S4 #1064) and
    // carries it in the payload, so a worker draining later derives the same
    // date/run-key/snapshot instant it deduped on (never the drain clock). Falls
    // back to the wall clock for a direct, un-queued call.
    now,
    listAllWorkspaces: async () => {
      const controlPlane = await openControlPlane();
      try {
        const workspaces = await controlPlane.listAllWorkspaces();
        return workspaces.map((w) => ({ id: w.id, dbUrl: w.dbUrl }));
      } finally {
        controlPlane.close();
      }
    },
    // Premium gate (#1162): a workspace whose plan has lapsed to free keeps its
    // ingested data, but its connected sources are PAUSED — the cron skips their
    // sync so nothing new is ingested, while the snapshot still freezes
    // last-known values. Derived server-side from the entitlement row (S1).
    shouldSyncConnectedSources: async (workspace) => {
      const controlPlane = await openControlPlane();
      try {
        const entitlement = await controlPlane.readWorkspaceEntitlement(workspace.id);
        return isPremiumIngestionAllowed(deriveEffectivePlan(entitlement, now));
      } finally {
        controlPlane.close();
      }
    },
    isRunFinalized: async (runKey) => {
      const controlPlane = await openControlPlane();
      try {
        return await controlPlane.hasDailyCaptureRun(runKey);
      } finally {
        controlPlane.close();
      }
    },
    markRunFinalized: async (runKey, finalizedAt) => {
      const controlPlane = await openControlPlane();
      try {
        await controlPlane.recordDailyCaptureRun(runKey, finalizedAt);
      } finally {
        controlPlane.close();
      }
    },
    listBenchmarkSeries: async () => [
      { id: SPANISH_CPI_SERIES_ID },
      ...listMarketIndexSeriesIds().map((id) => ({ id })),
    ],
    readBenchmarkPrices: async (seriesId) => {
      const controlPlane = await openControlPlane();
      try {
        return await controlPlane.readBenchmarkPrices(seriesId);
      } finally {
        controlPlane.close();
      }
    },
    fetchBenchmarkPrices: async (series) => {
      if (series.id === SPANISH_CPI_SERIES_ID) {
        return fetchSpanishCpi();
      }
      const entry = benchmarkCatalogEntryBySeriesId(series.id);
      if (!entry) return [];
      return fetchStooqMonthlyBenchmark(entry.stooqSymbol);
    },
    saveBenchmarkPrices: async (seriesId, prices) => {
      const controlPlane = await openControlPlane();
      try {
        await controlPlane.upsertBenchmarkPrices(seriesId, prices);
      } finally {
        controlPlane.close();
      }
    },
    // The cron is a `system` actor: it carries its own workspace coordinates
    // (control-plane URL + group token) rather than resolving them from a
    // request, and opens each workspace THROUGH the authorization port like
    // every other surface (#998 S2) — never a raw DB open.
    openStore: (workspace) =>
      openAuthorizedStore({
        kind: "system",
        options: {
          url: workspace.dbUrl,
          ...(groupToken ? { authToken: groupToken } : {}),
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
