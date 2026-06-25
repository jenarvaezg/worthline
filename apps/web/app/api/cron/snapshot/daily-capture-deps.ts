import {
  createControlPlaneStore,
  createWorthlineStore,
  type RunDailyCaptureDeps,
} from "@worthline/db";
import { refreshStalePrices } from "@worthline/pricing";

import { refreshAndPersistStalePrices } from "@web/refresh-prices";

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
    fetchPrices: async (store, now) => {
      const [assets, cacheEntries] = await Promise.all([
        store.assets.readInvestmentAssetsWithMeta(),
        store.operations.readAllPriceCacheEntries(),
      ]);
      await refreshAndPersistStalePrices({
        assets,
        cacheEntries,
        nowIso: now,
        refreshStalePrices,
        upsertPrice: (price) => store.operations.upsertPrice(price),
        readCache: () => store.operations.readAllPriceCacheEntries(),
      });
    },
  };
}
