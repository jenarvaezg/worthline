import type { LiquidityTier } from "./classification";
import type { DecimalString } from "./decimal";
import type { Instrument } from "./instrument-catalog";
import type { InvestmentOperation, PositionSummary } from "./investment-types";
import type {
  AssetType,
  ManualAsset,
  OwnershipShare,
  Workspace,
} from "./workspace-types";
import { createManualAsset } from "./workspace-types";
import { deriveInvestmentValuation, selectInvestmentPrice } from "./investment-valuation";
import { derivePosition } from "./positions";
import { resolveScopeMemberIds } from "./scope";

/**
 * Domain projection of raw asset reads (PRD #120 candidate 3, R10).
 *
 * The store layer stays shallow: it reads raw rows and the supporting raw maps
 * (operations, investment metadata, price cache, ownership) and hands them here.
 * This module owns the "raw row → domain object" composition — the investment
 * valuation math (units × price, ADR 0006) and the ManualAsset reconstitution —
 * so the projection is testable without a database and lives in exactly one place
 * rather than being duplicated across the store's callers.
 */

/** A raw live-asset row as read from storage, before any domain projection. */
export interface RawAssetRow {
  id: string;
  name: string;
  type: AssetType;
  currency: string;
  /** Stored value for hand-valued kinds; ignored for investments (derived). */
  currentValueMinor: number;
  liquidityTier: LiquidityTier;
  isPrimaryResidence: boolean;
  /** The stored instrument (ADR 0014, #149); null/absent for not-yet-backfilled rows. */
  instrument?: Instrument | null;
}

/** A raw investment-asset row with only the fields a position view needs. */
export interface RawInvestmentRow {
  id: string;
  name: string;
  currency: string;
}

/** The supporting raw reads needed to value investments and attach ownership. */
export interface AssetProjectionContext {
  ownershipByAsset: Map<string, OwnershipShare[]>;
  operationsByAsset: Map<string, InvestmentOperation[]>;
  manualPriceByAsset: Map<string, DecimalString | undefined>;
  cachedPriceByAsset: Map<string, DecimalString | undefined>;
}

/** A derived position plus the asset name, for the dashboard positions table. */
export interface PositionProjection extends PositionSummary {
  name: string;
}

/** The derived current value of an investment asset: market value if a price is
 *  known, otherwise its remaining cost basis (book value). */
function investmentValueMinor(
  row: { id: string; currency: string },
  ctx: AssetProjectionContext,
): number {
  return deriveInvestmentValuation({
    assetId: row.id,
    cachedPrice: ctx.cachedPriceByAsset.get(row.id),
    currency: row.currency,
    manualPrice: ctx.manualPriceByAsset.get(row.id),
    operations: ctx.operationsByAsset.get(row.id) ?? [],
  }).valueMinor;
}

/**
 * Project raw asset rows into domain ManualAssets. Investment assets get their
 * value derived from operations + price on read (ADR 0006); hand-valued kinds
 * carry their stored value.
 */
export function projectAssets(
  workspace: Workspace,
  rows: RawAssetRow[],
  ctx: AssetProjectionContext,
): ManualAsset[] {
  return rows.map((row) =>
    createManualAsset(workspace, {
      currency: row.currency,
      currentValueMinor:
        row.type === "investment"
          ? investmentValueMinor(row, ctx)
          : row.currentValueMinor,
      id: row.id,
      isPrimaryResidence: row.isPrimaryResidence,
      liquidityTier: row.liquidityTier,
      name: row.name,
      ownership: ctx.ownershipByAsset.get(row.id) ?? [],
      type: row.type,
      ...(row.instrument ? { instrument: row.instrument } : {}),
    }),
  );
}

/**
 * Project raw investment rows into full position views for the dashboard, scoped
 * to a set of member ids when a scope is given. Applies the price-selection rule
 * (cached beats manual, ADR 0006) and folds operations through derivePosition via
 * deriveInvestmentValuation's shared seam — here we need the full PositionSummary,
 * so we call derivePosition with the selected price directly.
 */
export function projectPositions(
  workspace: Workspace,
  rows: RawInvestmentRow[],
  ctx: AssetProjectionContext,
  scopeId?: string,
): PositionProjection[] {
  const scopeMemberIds = scopeId
    ? new Set(resolveScopeMemberIds(workspace, scopeId))
    : null;

  const views: PositionProjection[] = [];

  for (const row of rows) {
    const ownership = ctx.ownershipByAsset.get(row.id) ?? [];

    if (
      scopeMemberIds &&
      !ownership.some((share) => scopeMemberIds.has(share.memberId))
    ) {
      continue;
    }

    // Price-selection rule is owned by selectInvestmentPrice (ADR 0006). We need
    // the full PositionSummary for the positions table view, so we call
    // derivePosition with the price that selectInvestmentPrice picks.
    const selected = selectInvestmentPrice({
      cachedPrice: ctx.cachedPriceByAsset.get(row.id),
      manualPrice: ctx.manualPriceByAsset.get(row.id),
    });
    const position = derivePosition(ctx.operationsByAsset.get(row.id) ?? [], {
      assetId: row.id,
      currency: row.currency,
      ...(selected ? { currentPricePerUnit: selected.pricePerUnit } : {}),
    });

    views.push({ ...position, name: row.name });
  }

  return views;
}
