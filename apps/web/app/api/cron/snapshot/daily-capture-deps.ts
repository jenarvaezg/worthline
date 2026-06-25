import {
  createControlPlaneStore,
  createWorthlineStore,
  type DailyCaptureFetchedPrice,
  type RunDailyCaptureDeps,
} from "@worthline/db";
import { refreshStalePrices } from "@worthline/pricing";

type CronEnv = Record<string, string | undefined>;

/**
 * Wire the real dependencies for the daily-capture cron (ADR 0037, PRD #528).
 * The system actor lists every workspace from the control plane and opens each
 * per-workspace database with the shared group token and no session — a narrow,
 * capture-only cross-tenant path.
 *
 * `now` is the real wall clock: the job must never honor WORTHLINE_DEMO_NOW (it
 * would pin a frozen demo date into production snapshots). Demo workspaces are
 * ephemeral/in-memory and never enumerated here, so they are skipped by
 * construction.
 */
export function buildDailyCaptureDeps(env: CronEnv = process.env): RunDailyCaptureDeps {
  const controlPlaneUrl = env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  const groupToken = env["WORTHLINE_DB_AUTH_TOKEN"];

  return {
    now: new Date().toISOString(),
    listAllWorkspaces: async () => {
      if (!controlPlaneUrl) {
        throw new Error("Daily capture requires WORTHLINE_CONTROL_PLANE_DB_URL.");
      }
      const controlPlane = await createControlPlaneStore({
        url: controlPlaneUrl,
        ...(groupToken ? { authToken: groupToken } : {}),
      });
      try {
        const workspaces = await controlPlane.listAllWorkspaces();
        return workspaces.map((w) => ({ id: w.id, dbUrl: w.dbUrl }));
      } finally {
        controlPlane.close();
      }
    },
    openStore: (workspace) =>
      createWorthlineStore({
        url: workspace.dbUrl,
        ...(groupToken ? { authToken: groupToken } : {}),
      }),
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
