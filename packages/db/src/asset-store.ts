import type {
  CreateManualAssetInput,
  DecimalString,
  InvestmentPriceProvider,
  LiquidityTier,
  ManualAsset,
  OwnershipShare,
} from "@worthline/domain";
import {
  createManualAsset,
  defaultInvestmentPriceProvider,
} from "@worthline/domain";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { assetOwnerships, assets, investmentAssets } from "./schema";
import {
  hardDeleteAssetTx,
  readAssets,
  type StoreContext,
} from "./store-context";

export interface CreateInvestmentAssetInput {
  id: string;
  name: string;
  currency: string;
  ownership: OwnershipShare[];
  liquidityTier?: LiquidityTier;
  unitSymbol?: string;
  isin?: string;
  priceProvider?: InvestmentPriceProvider;
  providerSymbol?: string;
  manualPricePerUnit?: DecimalString;
}

export interface InvestmentAssetMeta {
  id: string;
  name: string;
  currency: string;
  liquidityTier: LiquidityTier;
  priceProvider: InvestmentPriceProvider;
  providerSymbol?: string;
}

/** Full investment asset record for edit/detail pages. */
export interface InvestmentAssetFull {
  id: string;
  name: string;
  currency: string;
  liquidityTier: LiquidityTier;
  ownership: OwnershipShare[];
  unitSymbol?: string;
  isin?: string;
  priceProvider: InvestmentPriceProvider;
  providerSymbol?: string;
  manualPricePerUnit?: DecimalString;
}

export interface UpdateInvestmentAssetInput {
  id: string;
  name: string;
  liquidityTier?: LiquidityTier;
  unitSymbol?: string;
  isin?: string;
  priceProvider?: InvestmentPriceProvider;
  providerSymbol?: string;
  manualPricePerUnit?: DecimalString;
}

/** Fields that can be changed when editing an existing manual asset. */
export interface UpdateAssetInput {
  name?: string;
  type?: ManualAsset["type"];
  liquidityTier?: LiquidityTier;
  isPrimaryResidence?: boolean;
  ownership?: OwnershipShare[];
}

/**
 * Asset persistence (Slice R2 of the architectural refactor, PRD #120 / #122).
 * Owns the live asset rows — manual and investment — their ownership, the
 * investment metadata row, the trash (soft delete / restore / hard delete), and
 * the manual valuation. Reads derive an investment's value on the fly (ADR 0006);
 * see readAssets.
 */
export interface AssetStore {
  createManualAsset: (input: CreateManualAssetInput) => void;
  createInvestmentAsset: (input: CreateInvestmentAssetInput) => void;
  readAssets: () => ManualAsset[];
  readInvestmentAssetById: (assetId: string) => InvestmentAssetFull | null;
  readInvestmentAssetsWithMeta: () => InvestmentAssetMeta[];
  updateAsset: (assetId: string, input: UpdateAssetInput) => void;
  updateAssetValuation: (assetId: string, currentValueMinor: number) => void;
  updateInvestmentAsset: (input: UpdateInvestmentAssetInput) => void;
  /** Soft-delete an asset (moves it to the trash). Returns 1 if moved, 0 if not found. */
  softDeleteAsset: (assetId: string, deletedAt: string) => number;
  /** Restore a trashed asset. Returns 1 if restored, 0 if not found or not in trash. */
  restoreAsset: (assetId: string) => number;
  /** Hard-delete a trashed asset (live data + overrides; snapshots untouched). Returns 1 if removed, 0 if not found or not in trash. */
  hardDeleteAsset: (assetId: string) => number;
}

export function createAssetStore(ctx: StoreContext): AssetStore {
  return {
    createManualAsset: (input) => createManualAssetRecord(ctx, input),
    createInvestmentAsset: (input) => createInvestmentAsset(ctx, input),
    readAssets: () => readAssets(ctx.sqlite, ctx.getWorkspace()),
    readInvestmentAssetById: (assetId) => readInvestmentAssetById(ctx, assetId),
    readInvestmentAssetsWithMeta: () => readInvestmentAssetsWithMeta(ctx),
    updateAsset: (assetId, input) => updateAsset(ctx, assetId, input),
    updateAssetValuation: (assetId, currentValueMinor) =>
      updateAssetValuation(ctx, assetId, currentValueMinor),
    updateInvestmentAsset: (input) => updateInvestmentAsset(ctx, input),
    softDeleteAsset: (assetId, deletedAt) => softDeleteAsset(ctx, assetId, deletedAt),
    restoreAsset: (assetId) => restoreAsset(ctx, assetId),
    hardDeleteAsset: (assetId) =>
      ctx.sqlite.transaction(() => hardDeleteAssetTx(ctx, assetId))(),
  };
}

function createManualAssetRecord(ctx: StoreContext, input: CreateManualAssetInput): void {
  const { db } = ctx;
  const workspace = ctx.getWorkspace();

  if (!workspace) {
    throw new Error("Workspace must be initialized before creating assets.");
  }

  const asset = createManualAsset(workspace, input);
  ctx.transaction(() => {
    db.insert(assets)
      .values({
        currency: asset.currency,
        currentValueMinor: asset.currentValue.amountMinor,
        id: asset.id,
        isPrimaryResidence: asset.isPrimaryResidence ? 1 : 0,
        liquidityTier: asset.liquidityTier,
        name: asset.name,
        type: asset.type,
      })
      .run();

    if (asset.ownership.length > 0) {
      db.insert(assetOwnerships)
        .values(
          asset.ownership.map((share) => ({
            assetId: asset.id,
            memberId: share.memberId,
            shareBps: share.shareBps,
          })),
        )
        .run();
    }
  });

  ctx.writeAuditEntry("create_asset", "asset", asset.id);
}

function createInvestmentAsset(ctx: StoreContext, input: CreateInvestmentAssetInput): void {
  const { db } = ctx;
  const workspace = ctx.getWorkspace();

  if (!workspace) {
    throw new Error("Workspace must be initialized before creating assets.");
  }

  // Reuse the manual-asset constructor for ownership/currency validation. A
  // unit-based asset starts at zero value; its real value is derived from
  // operations + price on read.
  const asset = createManualAsset(workspace, {
    currency: input.currency,
    currentValueMinor: 0,
    id: input.id,
    isPrimaryResidence: false,
    liquidityTier: input.liquidityTier ?? "market",
    name: input.name,
    ownership: input.ownership,
    type: "investment",
  });
  const pricedAt = input.manualPricePerUnit ? new Date().toISOString() : null;

  ctx.transaction(() => {
    db.insert(assets)
      .values({
        currency: asset.currency,
        currentValueMinor: 0,
        id: asset.id,
        isPrimaryResidence: 0,
        liquidityTier: asset.liquidityTier,
        name: asset.name,
        type: asset.type,
      })
      .run();

    if (asset.ownership.length > 0) {
      db.insert(assetOwnerships)
        .values(
          asset.ownership.map((share) => ({
            assetId: asset.id,
            memberId: share.memberId,
            shareBps: share.shareBps,
          })),
        )
        .run();
    }

    db.insert(investmentAssets)
      .values({
        assetId: asset.id,
        isin: input.isin ?? null,
        manualPricePerUnit: input.manualPricePerUnit ?? null,
        manualPricedAt: pricedAt,
        priceProvider: input.priceProvider ?? null,
        providerSymbol: input.providerSymbol ?? null,
        unitSymbol: input.unitSymbol ?? null,
      })
      .run();
  });
}

function readInvestmentAssetById(
  ctx: StoreContext,
  assetId: string,
): InvestmentAssetFull | null {
  const { db } = ctx;
  const row = db
    .select({
      id: assets.id,
      name: assets.name,
      currency: assets.currency,
      liquidityTier: assets.liquidityTier,
    })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  if (!row) return null;

  const investRow = db
    .select({
      unitSymbol: investmentAssets.unitSymbol,
      isin: investmentAssets.isin,
      priceProvider: investmentAssets.priceProvider,
      providerSymbol: investmentAssets.providerSymbol,
      manualPricePerUnit: investmentAssets.manualPricePerUnit,
    })
    .from(investmentAssets)
    .where(eq(investmentAssets.assetId, assetId))
    .get();

  if (!investRow) return null;

  const ownershipRows = db
    .select({
      memberId: assetOwnerships.memberId,
      shareBps: assetOwnerships.shareBps,
    })
    .from(assetOwnerships)
    .where(eq(assetOwnerships.assetId, assetId))
    .orderBy(asc(assetOwnerships.memberId))
    .all();

  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    liquidityTier: row.liquidityTier,
    ownership: ownershipRows,
    priceProvider:
      investRow.priceProvider ?? defaultInvestmentPriceProvider(row.liquidityTier),
    ...(investRow.unitSymbol ? { unitSymbol: investRow.unitSymbol } : {}),
    ...(investRow.isin ? { isin: investRow.isin } : {}),
    ...(investRow.providerSymbol ? { providerSymbol: investRow.providerSymbol } : {}),
    ...(investRow.manualPricePerUnit
      ? { manualPricePerUnit: investRow.manualPricePerUnit }
      : {}),
  };
}

function readInvestmentAssetsWithMeta(ctx: StoreContext): InvestmentAssetMeta[] {
  const { db } = ctx;
  const rows = db
    .select({
      id: assets.id,
      name: assets.name,
      currency: assets.currency,
      liquidityTier: assets.liquidityTier,
      priceProvider: investmentAssets.priceProvider,
      providerSymbol: investmentAssets.providerSymbol,
    })
    .from(assets)
    .innerJoin(investmentAssets, eq(investmentAssets.assetId, assets.id))
    .where(isNull(assets.deletedAt))
    .orderBy(asc(assets.createdAt), asc(assets.id))
    .all();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    currency: row.currency,
    liquidityTier: row.liquidityTier,
    priceProvider:
      row.priceProvider ?? defaultInvestmentPriceProvider(row.liquidityTier),
    ...(row.providerSymbol ? { providerSymbol: row.providerSymbol } : {}),
  }));
}

function updateAsset(ctx: StoreContext, assetId: string, input: UpdateAssetInput): void {
  const { db } = ctx;
  const fields: Partial<typeof assets.$inferInsert> = {};

  if (input.name !== undefined) {
    fields.name = input.name;
  }

  if (input.type !== undefined) {
    fields.type = input.type;
  }

  if (input.liquidityTier !== undefined) {
    fields.liquidityTier = input.liquidityTier;
  }

  if (input.isPrimaryResidence !== undefined) {
    fields.isPrimaryResidence = input.isPrimaryResidence ? 1 : 0;
  }

  ctx.transaction(() => {
    if (Object.keys(fields).length > 0) {
      db.update(assets)
        .set({ ...fields, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(assets.id, assetId))
        .run();
    }

    if (input.ownership !== undefined) {
      db.delete(assetOwnerships).where(eq(assetOwnerships.assetId, assetId)).run();

      if (input.ownership.length > 0) {
        db.insert(assetOwnerships)
          .values(
            input.ownership.map((share) => ({
              assetId,
              memberId: share.memberId,
              shareBps: share.shareBps,
            })),
          )
          .run();
      }
    }
  });

  ctx.writeAuditEntry("update_asset", "asset", assetId, {
    ...input,
    ownership: undefined,
  });
}

function updateAssetValuation(
  ctx: StoreContext,
  assetId: string,
  currentValueMinor: number,
): void {
  const { db } = ctx;

  if (!Number.isInteger(currentValueMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }

  // The "investments are never valued by hand" invariant (ADR 0006) is enforced
  // by the caller via assertNotInvestmentAsset before it reaches the store
  // (PRD #120 candidate 3 — domain invariants live outside the store layer).
  db.update(assets)
    .set({ currentValueMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(assets.id, assetId))
    .run();
  ctx.writeAuditEntry("update_valuation", "asset", assetId, { currentValueMinor });
}

function updateInvestmentAsset(ctx: StoreContext, input: UpdateInvestmentAssetInput): void {
  const { sqlite } = ctx;
  const update = sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE assets SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(input.name, input.id);

    if (input.liquidityTier) {
      sqlite
        .prepare(
          `UPDATE assets SET liquidity_tier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        )
        .run(input.liquidityTier, input.id);
    }

    sqlite
      .prepare(
        `UPDATE investment_assets
         SET unit_symbol = ?, isin = ?, price_provider = ?, provider_symbol = ?,
             manual_price_per_unit = ?
         WHERE asset_id = ?`,
      )
      .run(
        input.unitSymbol ?? null,
        input.isin ?? null,
        input.priceProvider ?? null,
        input.providerSymbol ?? null,
        input.manualPricePerUnit ?? null,
        input.id,
      );
  });

  update();
  ctx.writeAuditEntry("update_investment_asset", "asset", input.id, {
    name: input.name,
  });
}

function softDeleteAsset(ctx: StoreContext, assetId: string, deletedAt: string): number {
  const result = ctx.db
    .update(assets)
    .set({ deletedAt })
    .where(eq(assets.id, assetId))
    .run();
  if (result.changes > 0) {
    ctx.writeAuditEntry("delete_asset", "asset", assetId, { deletedAt });
  }
  return result.changes;
}

function restoreAsset(ctx: StoreContext, assetId: string): number {
  const result = ctx.db
    .update(assets)
    .set({ deletedAt: null })
    .where(and(eq(assets.id, assetId), isNotNull(assets.deletedAt)))
    .run();
  if (result.changes > 0) {
    ctx.writeAuditEntry("restore_asset", "asset", assetId);
  }
  return result.changes;
}
