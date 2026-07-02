import type { LiquidityTier } from "./classification";
import type { DecimalString } from "./decimal";
import type { Instrument } from "./instrument-catalog";
import type { InvestmentOperation, PositionSummary } from "./investment-types";
import type { InvestmentCaptureDetail } from "./snapshot-holdings";
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
  /**
   * The connected source this asset materializes a rung of (ADR 0016/0021, #248);
   * null for a hand-maintained holding. Read straight off `assets` — never a
   * figure the math reads, only warnings metadata.
   */
  connectedSourceId?: string | null;
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
  /**
   * The investment's provider-symbol metadata (ADR 0055), for the
   * `MISSING_PROVIDER_SYMBOL` warning. Optional so the many fixtures/contexts
   * that predate it keep compiling; absent is read the same as "no symbol".
   */
  providerSymbolByAsset?: Map<string, string | undefined>;
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
  return rows.map((row) => {
    const providerSymbol = ctx.providerSymbolByAsset?.get(row.id);

    return createManualAsset(workspace, {
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
      ...(providerSymbol ? { providerSymbol } : {}),
      ...(row.connectedSourceId ? { connectedSourceId: row.connectedSourceId } : {}),
    });
  });
}

/**
 * Project raw investment rows into full position views for the dashboard, scoped
 * to a set of member ids when a scope is given. Applies the price-selection rule
 * (cached beats manual, ADR 0006) and folds operations through derivePosition via
 * deriveInvestmentValuation's shared seam — here we need the full PositionSummary,
 * so we call derivePosition with the selected price directly.
 */
/**
 * The per-investment units + unit price a snapshot freezes (ADR 0008), keyed by
 * asset id. Derived from the UNSCOPED positions: capture details cover every
 * investment regardless of scope, since the scope only filters which positions a
 * scope's frozen rows include, never the per-asset units/price math.
 */
export function investmentCaptureDetailsFrom(
  positions: readonly PositionProjection[],
): Map<string, InvestmentCaptureDetail> {
  return new Map(
    positions.map((position) => [
      position.assetId,
      {
        units: position.currentUnits,
        ...(position.currentPricePerUnit
          ? { unitPrice: position.currentPricePerUnit }
          : {}),
      },
    ]),
  );
}

/**
 * Project raw investment rows into BOTH the unscoped capture details (every
 * investment's units + unit price, ADR 0008) and the selected scope's positions,
 * from ONE shared projection context — the dashboard load needs both off the same
 * raw operation read (#208). The unscoped positions feed the capture details; the
 * scoped positions are the dashboard's positions table. Building both from the
 * same `ctx` means a dashboard load reads every operation once, not twice.
 *
 * The result is byte-identical to deriving the details from `projectPositions(…)`
 * (unscoped) and reading `projectPositions(…, scopeId)` separately — only the
 * single shared raw read changes, never the computed figures.
 */
export function projectScopedPositionsWithDetails(
  workspace: Workspace,
  rows: RawInvestmentRow[],
  ctx: AssetProjectionContext,
  scopeId?: string,
): {
  positions: PositionProjection[];
  details: Map<string, InvestmentCaptureDetail>;
} {
  const unscoped = projectPositions(workspace, rows, ctx);
  const details = investmentCaptureDetailsFrom(unscoped);
  // When no scope narrows the view, the scoped positions ARE the unscoped ones —
  // reuse them rather than re-folding the operations a second time.
  const positions =
    scopeId === undefined ? unscoped : projectPositions(workspace, rows, ctx, scopeId);
  return { details, positions };
}

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
