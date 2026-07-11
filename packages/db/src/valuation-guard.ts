import {
  assertManualValuationAllowed,
  assertNotConnectedValuation,
  type CurrencyCode,
  type LiquidityTier,
  type ManualAsset,
} from "@worthline/domain";
import { eq } from "drizzle-orm";

import { assets } from "./schema";
import type { StoreContext } from "./store-context";

async function loadAssetForValuationGuard(
  ctx: StoreContext,
  assetId: string,
): Promise<ManualAsset> {
  const row = await ctx.db
    .select({
      connectedSourceId: assets.connectedSourceId,
      currency: assets.currency,
      currentValueMinor: assets.currentValueMinor,
      id: assets.id,
      liquidityTier: assets.liquidityTier,
      name: assets.name,
      type: assets.type,
    })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  if (!row) {
    throw new Error(`Asset not found: ${assetId}`);
  }

  return {
    currency: row.currency as CurrencyCode,
    currentValue: {
      amountMinor: row.currentValueMinor,
      currency: row.currency as CurrencyCode,
    },
    id: row.id,
    isPrimaryResidence: false,
    liquidityTier: row.liquidityTier as LiquidityTier,
    name: row.name,
    ownership: [],
    type: row.type as ManualAsset["type"],
    ...(row.connectedSourceId ? { connectedSourceId: row.connectedSourceId } : {}),
  };
}

/**
 * Guard hand-set stored valuation facts (current value, housing anchors, cadence).
 * Rejects investments (ADR 0006) and connected holdings (#883/#945).
 */
export async function assertAssetAllowsStoredValuationWrite(
  ctx: StoreContext,
  assetId: string,
): Promise<void> {
  assertManualValuationAllowed(await loadAssetForValuationGuard(ctx, assetId));
}

/**
 * Guard operation writes that would manually alter a connected holding's derived
 * position. Investments remain allowed — operations are their valuation path.
 */
export async function assertAssetAllowsOperationWrite(
  ctx: StoreContext,
  assetId: string,
): Promise<void> {
  assertNotConnectedValuation(await loadAssetForValuationGuard(ctx, assetId));
}
