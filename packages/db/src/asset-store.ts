import type {
  CreateManualAssetInput,
  DecimalString,
  InvestmentPriceProvider,
  LiquidityTier,
  ManualAsset,
  OwnershipShare,
} from "@worthline/domain";
import {
  assertNotInvestmentAsset,
  createManualAsset,
  defaultInvestmentPriceProvider,
} from "@worthline/domain";
import type { AssetType } from "@worthline/domain";
import { asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

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
    readInvestmentAssetById: (assetId) => readInvestmentAssetById(ctx.sqlite, assetId),
    readInvestmentAssetsWithMeta: () => readInvestmentAssetsWithMeta(ctx.sqlite),
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
  const { sqlite } = ctx;
  const workspace = ctx.getWorkspace();

  if (!workspace) {
    throw new Error("Workspace must be initialized before creating assets.");
  }

  const asset = createManualAsset(workspace, input);
  const insert = sqlite.transaction(() => {
    sqlite
      .prepare(
        `
        INSERT INTO assets (
          id,
          name,
          type,
          currency,
          current_value_minor,
          liquidity_tier,
          is_primary_residence
        )
        VALUES (
          @id,
          @name,
          @type,
          @currency,
          @currentValueMinor,
          @liquidityTier,
          @isPrimaryResidence
        )
      `,
      )
      .run({
        currency: asset.currency,
        currentValueMinor: asset.currentValue.amountMinor,
        id: asset.id,
        isPrimaryResidence: asset.isPrimaryResidence ? 1 : 0,
        liquidityTier: asset.liquidityTier,
        name: asset.name,
        type: asset.type,
      });

    const insertOwnership = sqlite.prepare(`
      INSERT INTO asset_ownerships (asset_id, member_id, share_bps)
      VALUES (@assetId, @memberId, @shareBps)
    `);

    for (const share of asset.ownership) {
      insertOwnership.run({
        assetId: asset.id,
        memberId: share.memberId,
        shareBps: share.shareBps,
      });
    }
  });

  insert();
  ctx.writeAuditEntry("create_asset", "asset", asset.id);
}

function createInvestmentAsset(ctx: StoreContext, input: CreateInvestmentAssetInput): void {
  const { sqlite } = ctx;
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

  const insert = sqlite.transaction(() => {
    sqlite
      .prepare(
        `
        INSERT INTO assets (
          id,
          name,
          type,
          currency,
          current_value_minor,
          liquidity_tier,
          is_primary_residence
        )
        VALUES (
          @id,
          @name,
          @type,
          @currency,
          @currentValueMinor,
          @liquidityTier,
          @isPrimaryResidence
        )
      `,
      )
      .run({
        currency: asset.currency,
        currentValueMinor: 0,
        id: asset.id,
        isPrimaryResidence: 0,
        liquidityTier: asset.liquidityTier,
        name: asset.name,
        type: asset.type,
      });

    const insertOwnership = sqlite.prepare(`
      INSERT INTO asset_ownerships (asset_id, member_id, share_bps)
      VALUES (@assetId, @memberId, @shareBps)
    `);

    for (const share of asset.ownership) {
      insertOwnership.run({
        assetId: asset.id,
        memberId: share.memberId,
        shareBps: share.shareBps,
      });
    }

    sqlite
      .prepare(
        `
        INSERT INTO investment_assets (
          asset_id,
          unit_symbol,
          isin,
          price_provider,
          provider_symbol,
          manual_price_per_unit,
          manual_priced_at
        )
        VALUES (
          @assetId,
          @unitSymbol,
          @isin,
          @priceProvider,
          @providerSymbol,
          @manualPricePerUnit,
          @manualPricedAt
        )
      `,
      )
      .run({
        assetId: asset.id,
        isin: input.isin ?? null,
        manualPricePerUnit: input.manualPricePerUnit ?? null,
        manualPricedAt: pricedAt,
        priceProvider: input.priceProvider ?? null,
        providerSymbol: input.providerSymbol ?? null,
        unitSymbol: input.unitSymbol ?? null,
      });
  });

  insert();
}

function readInvestmentAssetById(
  sqlite: StoreContext["sqlite"],
  assetId: string,
): InvestmentAssetFull | null {
  const db = drizzle(sqlite);
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

function readInvestmentAssetsWithMeta(
  sqlite: StoreContext["sqlite"],
): InvestmentAssetMeta[] {
  const db = drizzle(sqlite);
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
  const { sqlite } = ctx;
  const updates: string[] = [];
  const params: unknown[] = [];

  if (input.name !== undefined) {
    updates.push("name = ?");
    params.push(input.name);
  }

  if (input.type !== undefined) {
    updates.push("type = ?");
    params.push(input.type);
  }

  if (input.liquidityTier !== undefined) {
    updates.push("liquidity_tier = ?");
    params.push(input.liquidityTier);
  }

  if (input.isPrimaryResidence !== undefined) {
    updates.push("is_primary_residence = ?");
    params.push(input.isPrimaryResidence ? 1 : 0);
  }

  const editAsset = sqlite.transaction(() => {
    if (updates.length > 0) {
      updates.push("updated_at = CURRENT_TIMESTAMP");
      params.push(assetId);
      sqlite
        .prepare(`UPDATE assets SET ${updates.join(", ")} WHERE id = ?`)
        .run(...params);
    }

    if (input.ownership !== undefined) {
      sqlite.prepare(`DELETE FROM asset_ownerships WHERE asset_id = ?`).run(assetId);

      const insertOwnership = sqlite.prepare(`
        INSERT INTO asset_ownerships (asset_id, member_id, share_bps)
        VALUES (@assetId, @memberId, @shareBps)
      `);

      for (const share of input.ownership) {
        insertOwnership.run({
          assetId,
          memberId: share.memberId,
          shareBps: share.shareBps,
        });
      }
    }
  });

  editAsset();
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
  const { sqlite } = ctx;

  if (!Number.isInteger(currentValueMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }

  // Domain guard: investment assets have a derived value (units × price)
  // and must never be valued by hand (ADR 0006).
  const assetRow = sqlite
    .prepare(`SELECT type FROM assets WHERE id = ?`)
    .get(assetId) as { type: string } | undefined;

  if (assetRow) {
    assertNotInvestmentAsset({
      id: assetId,
      type: assetRow.type as AssetType,
      name: assetId,
      currency: "EUR",
      currentValue: { amountMinor: 0, currency: "EUR" },
      liquidityTier: "market",
      ownership: [],
      isPrimaryResidence: false,
    });
  }

  sqlite
    .prepare(
      `
      UPDATE assets
      SET current_value_minor = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    )
    .run(currentValueMinor, assetId);
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
  const { sqlite } = ctx;
  const result = sqlite
    .prepare(`UPDATE assets SET deleted_at = ? WHERE id = ?`)
    .run(deletedAt, assetId);
  if (result.changes > 0) {
    ctx.writeAuditEntry("delete_asset", "asset", assetId, { deletedAt });
  }
  return result.changes;
}

function restoreAsset(ctx: StoreContext, assetId: string): number {
  const { sqlite } = ctx;
  const result = sqlite
    .prepare(
      `UPDATE assets SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`,
    )
    .run(assetId);
  if (result.changes > 0) {
    ctx.writeAuditEntry("restore_asset", "asset", assetId);
  }
  return result.changes;
}
