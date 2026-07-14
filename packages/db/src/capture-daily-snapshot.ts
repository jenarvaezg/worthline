/**
 * Daily snapshot capture orchestration — capture every scope in one call.
 *
 * Extracted from the load-dashboard inline path (issue #529, PRD #528 S1):
 * reads everything it needs from the store and walks every scope so the
 * render path and the future cron share one capture path.
 */
import type {
  AssetProjectionContext,
  CaptureSnapshotOutput,
  CoinPosition,
  InvestmentCaptureDetail,
  Liability,
  LiquidityTier,
  ManualAsset,
  NetWorthSnapshot,
  ScopeOption,
  SnapshotPositionInput,
  TokenPosition,
  Workspace,
} from "@worthline/domain";
import {
  captureSnapshotForScope,
  coinPositionSnapshotInput,
  listScopeOptions,
  tokenSymbolSnapshotInputs,
} from "@worthline/domain";

import type { WorthlineStore } from "./store-types";

/**
 * The scope-agnostic inputs a snapshot capture needs, read once from the store:
 * the workspace and its scopes, the curve-valued holdings at the capture date,
 * and the per-holding investment/position detail maps that freeze into every
 * scope's rows. Shared by the fleet cron (which walks all scopes and saves) and
 * the dashboard GET (which synthesizes ONE scope's live today-point in memory,
 * never saving — #895). `null` when no workspace exists.
 */
export interface SharedSnapshotInputs {
  workspace: Workspace;
  assets: ManualAsset[];
  liabilities: Liability[];
  scopes: ScopeOption[];
  investmentDetails: ReadonlyMap<string, InvestmentCaptureDetail>;
  positionDetails: ReadonlyMap<string, SnapshotPositionInput[]>;
}

/**
 * Capture a daily snapshot for every scope in the workspace.
 *
 * Reads the store once for shared inputs, then walks every scope returned by
 * `listScopeOptions` and captures a valued snapshot per scope. Idempotent:
 * `captureSnapshotForScope` returns `replace: true` when today's snapshot
 * already exists, and the save overwrites the same-day point (latest wins,
 * ADR 0005). The workspace must exist — no-op when absent.
 *
 * Pure orchestration: no return value. Callers verify state through the store.
 *
 * @param projectionContext - Optional pre-built projection context (dedup #566).
 *   The render path already builds it once after §1 writes and passes it in, so
 *   `readAssets` and `readScopedPositionsWithDetails` reuse it instead of each
 *   rebuilding `buildAssetProjectionContext`. The cron calls without it and
 *   builds on its own — capture only writes snapshot tables, never the four
 *   projection tables, so a context built before capture stays valid through it.
 */
export async function captureDailySnapshotForWorkspace(
  store: WorthlineStore,
  now: string,
  projectionContext?: AssetProjectionContext,
): Promise<void> {
  const shared = await buildSharedSnapshotInputs(store, now, projectionContext);
  if (!shared) return;

  // ── Walk every scope and capture ─────────────────────────────────────────
  for (const scope of shared.scopes) {
    const capture = captureSnapshotForScope({
      assets: shared.assets,
      capturedAt: now,
      existingSnapshots: await store.snapshots.readSnapshots(scope.id),
      investmentDetails: shared.investmentDetails,
      liabilities: shared.liabilities,
      positionDetails: shared.positionDetails,
      scope,
      workspace: shared.workspace,
    });

    await store.snapshots.saveSnapshot({
      holdings: capture.holdings,
      replace: capture.replace,
      snapshot: capture.snapshot,
    });
  }
}

/**
 * Read the scope-agnostic snapshot inputs once from the store (#529, #895).
 * Returns `null` when the workspace is absent (no-op capture / no live point).
 *
 * @param projectionContext - Optional pre-built projection context (dedup #566);
 *   capture only writes snapshot tables, never the four projection tables, so a
 *   context built before capture stays valid through it.
 */
export async function buildSharedSnapshotInputs(
  store: WorthlineStore,
  now: string,
  projectionContext?: AssetProjectionContext,
): Promise<SharedSnapshotInputs | null> {
  const workspace = await store.workspace.readWorkspace();
  if (!workspace) return null;

  const dateKey = now.slice(0, 10);
  const { assets, liabilities } = await store.snapshots.readCurveValuedHoldingsAtDate(
    dateKey,
    projectionContext,
  );
  const scopes = listScopeOptions(workspace);

  // ── Shared investment details (one per asset, scope-agnostic) ────────────
  // Uses the first scope's projection since investment details are the same
  // across scopes (what differs is the scope-weighted allocation downstream).
  const scopedProjection = await store.snapshots.readScopedPositionsWithDetails(
    scopes[0]?.id,
    projectionContext,
  );
  const investmentDetails: ReadonlyMap<string, InvestmentCaptureDetail> =
    scopedProjection.details;

  // ── Connected-source position breakdown (ADR 0035) ───────────────────────
  // Freezes each connected holding's per-position values into the snapshot.
  // Shared across scopes like `investmentDetails`.
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
      const tokens = (await store.connectedSources.readPositions(source.id)).filter(
        (position): position is TokenPosition => position.kind === "token",
      );
      if (tokens.length === 0) continue;

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
          // Freeze one position per SYMBOL (folding spot/funding/earn wallets of
          // the same token together), so a wallet move never re-keys the drilldown
          // into a phantom sell+buy (#247 lens; PRD #459 S2).
          positionDetails.set(assetId, tokenSymbolSnapshotInputs(group));
        }
      }
    }
  }

  return { assets, investmentDetails, liabilities, positionDetails, scopes, workspace };
}

/**
 * Build ONE scope's snapshot capture in memory without persisting it (#895).
 *
 * The dashboard GET is cache-only — it never writes — but the histórico chart
 * must still show today's live point (snapshots persisted ∪ today live, #485).
 * This reuses the exact capture path the cron uses so the in-memory today-point
 * is byte-identical to the snapshot the evening cron will later persist. Returns
 * `null` when the workspace is absent.
 */
export async function buildTodaySnapshotForScope(
  store: WorthlineStore,
  now: string,
  scope: ScopeOption,
  existingSnapshots: NetWorthSnapshot[],
  projectionContext?: AssetProjectionContext,
): Promise<CaptureSnapshotOutput | null> {
  const shared = await buildSharedSnapshotInputs(store, now, projectionContext);
  if (!shared) return null;

  return captureSnapshotForScope({
    assets: shared.assets,
    capturedAt: now,
    existingSnapshots,
    investmentDetails: shared.investmentDetails,
    liabilities: shared.liabilities,
    positionDetails: shared.positionDetails,
    scope,
    workspace: shared.workspace,
  });
}
