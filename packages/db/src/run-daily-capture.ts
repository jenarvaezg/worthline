import type { AssetPrice, InvestmentPriceProvider } from "@worthline/domain";

import { captureDailySnapshotForWorkspace } from "./capture-daily-snapshot";
import type { InvestmentAssetMeta } from "./asset-store";
import type { WorthlineStore } from "./store-types";

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
  /** Run-level idempotency guard: true means this UTC date already finalized. */
  isRunFinalized?: (dateKey: string) => Promise<boolean>;
  /** Persist successful run finalization after all workspaces capture. */
  markRunFinalized?: (dateKey: string, finalizedAt: string) => Promise<void>;
  /** Real wall-clock ISO timestamp — the day's close. Never the demo pin. */
  now: string;
}

export interface DailyCaptureFailure {
  workspaceId: string;
  error: string;
}

export interface RunDailyCaptureResult {
  total: number;
  captured: number;
  failures: DailyCaptureFailure[];
  dateKey?: string;
  skipped?: boolean;
}

/**
 * Fleet daily snapshot capture (ADR 0037, PRD #528). Before any expensive
 * cross-tenant work, checks the run-level finalization guard for this UTC date;
 * redundant same-day triggers return without listing workspaces or fetching
 * prices. The first finalized run collects the fleet-wide union of market-price
 * provider symbols, fetches each unique pair once, persists those fresh prices
 * into every matching workspace cache, then captures the day's snapshot
 * **unconditionally** — latest-wins (ADR 0005) overrides any provisional
 * intraday point a render wrote earlier, finalizing the day at its close.
 * Per-workspace failures are isolated: one unreachable or broken tenant never
 * blocks the rest.
 *
 * Pure orchestration over injected seams — no control plane, no network, no
 * clock of its own (the cron route wires the real dependencies).
 */
export async function runDailyCapture(
  deps: RunDailyCaptureDeps,
): Promise<RunDailyCaptureResult> {
  const dateKey = dateKeyFromIso(deps.now);
  if (await deps.isRunFinalized?.(dateKey)) {
    return { total: 0, captured: 0, failures: [], dateKey, skipped: true };
  }

  const workspaces = await deps.listAllWorkspaces();
  const failures: DailyCaptureFailure[] = [];
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
      for (const asset of plan.assets) {
        if (!asset.providerSymbol) continue;
        const fetched = fetchedByPair.get(
          pricePairKey(asset.priceProvider, asset.providerSymbol),
        );
        if (!fetched || fetched.freshnessState === "failed") continue;
        await plan.store.operations.upsertPrice({
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
    await deps.markRunFinalized?.(dateKey, deps.now);
  }

  return { total: workspaces.length, captured, failures, dateKey };
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
