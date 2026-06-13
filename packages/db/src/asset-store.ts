import type {
  CreateManualAssetInput,
  DecimalString,
  HousingValuationAnchor,
  InvestmentPriceProvider,
  LiquidityTier,
  ManualAsset,
  OwnershipShare,
} from "@worthline/domain";
import {
  createManualAsset,
  defaultInvestmentPriceProvider,
  valueHousingAtDate,
} from "@worthline/domain";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { assetOwnerships, assets, assetValuations, investmentAssets } from "./schema";
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

/** Input for a single housing valuation anchor (PRD #108, slice 4). */
export interface AddValuationAnchorInput {
  id: string;
  assetId: string;
  /** Integer minor units. TOTAL when adjustsPriorCurve, INCREMENT otherwise. */
  valueMinor: number;
  /** YYYY-MM-DD. */
  valuationDate: string;
  /** True for a market appraisal (total truth), false for an improvement. */
  adjustsPriorCurve: boolean;
}

/** A stored housing valuation anchor as read back from the store. */
export interface ValuationAnchorRecord extends HousingValuationAnchor {
  id: string;
  assetId: string;
}

/** Fields that can be patched on an existing housing valuation anchor. */
export interface UpdateValuationAnchorInput {
  valueMinor?: number;
  valuationDate?: string;
  adjustsPriorCurve?: boolean;
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
  /** Add a housing valuation anchor (market appraisal or improvement). */
  addValuationAnchor: (input: AddValuationAnchorInput) => void;
  /** Read an asset's valuation anchors, ordered ascending by date. */
  readValuationAnchors: (assetId: string) => ValuationAnchorRecord[];
  /** Delete a valuation anchor by id. Returns 1 if removed, 0 if not found. */
  deleteValuationAnchor: (anchorId: string) => number;
  /**
   * Update an existing housing valuation anchor in place. Validates data types
   * and respects the (asset_id, valuation_date) unique index — changing the date
   * to one already occupied throws. Returns 1 if updated, 0 if not found.
   */
  updateValuationAnchor: (anchorId: string, input: UpdateValuationAnchorInput) => number;
  /** Set (or clear, with null) an asset's annual appreciation rate (decimal string). */
  setAnnualAppreciationRate: (assetId: string, rate: DecimalString | null) => void;
  /** Read an asset's annual appreciation rate, or null if unset. */
  readAnnualAppreciationRate: (assetId: string) => DecimalString | null;
  /**
   * Value a real-estate asset on `targetDate` (YYYY-MM-DD): reads its anchors +
   * rate + current value and delegates to the pure domain curve. `today` is a
   * parameter so the calculation stays deterministic.
   */
  valueHousingAtDate: (assetId: string, targetDate: string, today: string) => number;
}

export function createAssetStore(ctx: StoreContext): AssetStore {
  return {
    createManualAsset: (input) => createManualAssetRecord(ctx, input),
    createInvestmentAsset: (input) => createInvestmentAsset(ctx, input),
    readAssets: () => readAssets(ctx.db, ctx.getWorkspace()),
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
    addValuationAnchor: (input) => addValuationAnchor(ctx, input),
    readValuationAnchors: (assetId) => readValuationAnchors(ctx, assetId),
    deleteValuationAnchor: (anchorId) => deleteValuationAnchor(ctx, anchorId),
    updateValuationAnchor: (anchorId, input) => updateValuationAnchor(ctx, anchorId, input),
    setAnnualAppreciationRate: (assetId, rate) =>
      setAnnualAppreciationRate(ctx, assetId, rate),
    readAnnualAppreciationRate: (assetId) => readAnnualAppreciationRate(ctx, assetId),
    valueHousingAtDate: (assetId, targetDate, today) =>
      valueHousingAtDateFor(ctx, assetId, targetDate, today),
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertValuationDate(valuationDate: string): void {
  if (!ISO_DATE.test(valuationDate)) {
    throw new Error(
      `Valuation date must be in YYYY-MM-DD format, got "${valuationDate}".`,
    );
  }
}

function addValuationAnchor(ctx: StoreContext, input: AddValuationAnchorInput): void {
  if (!Number.isInteger(input.valueMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }
  assertValuationDate(input.valuationDate);

  ctx.db
    .insert(assetValuations)
    .values({
      adjustsPriorCurve: input.adjustsPriorCurve ? 1 : 0,
      assetId: input.assetId,
      id: input.id,
      valuationDate: input.valuationDate,
      valueMinor: input.valueMinor,
    })
    .run();

  ctx.writeAuditEntry("add_valuation_anchor", "asset", input.assetId, {
    adjustsPriorCurve: input.adjustsPriorCurve,
    anchorId: input.id,
    valuationDate: input.valuationDate,
    valueMinor: input.valueMinor,
  });
}

function readValuationAnchors(
  ctx: StoreContext,
  assetId: string,
): ValuationAnchorRecord[] {
  const rows = ctx.db
    .select()
    .from(assetValuations)
    .where(eq(assetValuations.assetId, assetId))
    .orderBy(asc(assetValuations.valuationDate), asc(assetValuations.id))
    .all();

  return rows.map((row) => ({
    adjustsPriorCurve: row.adjustsPriorCurve === 1,
    assetId: row.assetId,
    id: row.id,
    valuationDate: row.valuationDate,
    valueMinor: row.valueMinor,
  }));
}

function deleteValuationAnchor(ctx: StoreContext, anchorId: string): number {
  const row = ctx.db
    .select({ assetId: assetValuations.assetId })
    .from(assetValuations)
    .where(eq(assetValuations.id, anchorId))
    .get();

  if (!row) return 0;

  const result = ctx.db
    .delete(assetValuations)
    .where(eq(assetValuations.id, anchorId))
    .run();

  if (result.changes > 0) {
    ctx.writeAuditEntry("delete_valuation_anchor", "asset", row.assetId, { anchorId });
  }
  return result.changes;
}

function updateValuationAnchor(
  ctx: StoreContext,
  anchorId: string,
  input: UpdateValuationAnchorInput,
): number {
  if (input.valueMinor !== undefined && !Number.isInteger(input.valueMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }
  if (input.valuationDate !== undefined) {
    assertValuationDate(input.valuationDate);
  }

  const existing = ctx.db
    .select({ assetId: assetValuations.assetId })
    .from(assetValuations)
    .where(eq(assetValuations.id, anchorId))
    .get();

  if (!existing) return 0;

  const fields: Partial<typeof assetValuations.$inferInsert> = {};
  if (input.valueMinor !== undefined) fields.valueMinor = input.valueMinor;
  if (input.valuationDate !== undefined) fields.valuationDate = input.valuationDate;
  if (input.adjustsPriorCurve !== undefined) {
    fields.adjustsPriorCurve = input.adjustsPriorCurve ? 1 : 0;
  }

  const result = ctx.db
    .update(assetValuations)
    .set(fields)
    .where(eq(assetValuations.id, anchorId))
    .run();

  if (result.changes > 0) {
    ctx.writeAuditEntry("update_valuation_anchor", "asset", existing.assetId, {
      anchorId,
      ...input,
    });
  }
  return result.changes;
}

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

function setAnnualAppreciationRate(
  ctx: StoreContext,
  assetId: string,
  rate: DecimalString | null,
): void {
  if (rate !== null && !DECIMAL_STRING.test(rate)) {
    throw new Error(
      `Annual appreciation rate must be a decimal string (e.g. "0.03"), got "${rate}".`,
    );
  }

  ctx.db
    .update(assets)
    .set({ annualAppreciationRate: rate, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(assets.id, assetId))
    .run();

  ctx.writeAuditEntry("set_appreciation_rate", "asset", assetId, { rate });
}

function readAnnualAppreciationRate(
  ctx: StoreContext,
  assetId: string,
): DecimalString | null {
  const row = ctx.db
    .select({ annualAppreciationRate: assets.annualAppreciationRate })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  return row?.annualAppreciationRate ?? null;
}

function valueHousingAtDateFor(
  ctx: StoreContext,
  assetId: string,
  targetDate: string,
  today: string,
): number {
  const row = ctx.db
    .select({
      annualAppreciationRate: assets.annualAppreciationRate,
      currentValueMinor: assets.currentValueMinor,
    })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  if (!row) {
    throw new Error(`Asset "${assetId}" not found.`);
  }

  const anchors: HousingValuationAnchor[] = readValuationAnchors(ctx, assetId).map(
    (anchor) => ({
      adjustsPriorCurve: anchor.adjustsPriorCurve,
      valuationDate: anchor.valuationDate,
      valueMinor: anchor.valueMinor,
    }),
  );

  return valueHousingAtDate({
    anchors,
    annualAppreciationRate: row.annualAppreciationRate,
    currentValueMinor: row.currentValueMinor,
    targetDate,
    today,
  });
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
        instrument: asset.instrument,
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
        instrument: asset.instrument,
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
  const { db } = ctx;
  const assetFields: Partial<typeof assets.$inferInsert> = { name: input.name };

  if (input.liquidityTier) {
    assetFields.liquidityTier = input.liquidityTier;
  }

  ctx.transaction(() => {
    db.update(assets)
      .set({ ...assetFields, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(assets.id, input.id))
      .run();

    db.update(investmentAssets)
      .set({
        unitSymbol: input.unitSymbol ?? null,
        isin: input.isin ?? null,
        priceProvider: input.priceProvider ?? null,
        providerSymbol: input.providerSymbol ?? null,
        manualPricePerUnit: input.manualPricePerUnit ?? null,
      })
      .where(eq(investmentAssets.assetId, input.id))
      .run();
  });

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
