import type {
  AssetProjectionContext,
  CreateManualAssetInput,
  DecimalString,
  HousingValuationAnchor,
  Instrument,
  InvestmentPriceProvider,
  LiquidityTier,
  ManualAsset,
  OwnershipShare,
  ValuationCadence,
} from "@worthline/domain";
import {
  createManualAsset,
  defaultInstrumentForAssetType,
  defaultInvestmentPriceProvider,
  valueHousingAtDate,
} from "@worthline/domain";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import {
  ensureAgentViewPublicIds,
  publicIdTargetsForHolding,
} from "./agent-view-public-ids";
import { assetOwnerships, assets, assetValuations, investmentAssets } from "./schema";
import { hardDeleteAssetTx, readAssets, type StoreContext } from "./store-context";
import { assertAssetAllowsStoredValuationWrite } from "./valuation-guard";

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
  /**
   * What the investment is (ADR 0014, #149). The instrument-first add flow passes
   * the chosen instrument (etf/stock/index/crypto/pension_plan/fund); when absent
   * we fall back to the legacy provider-based guess so existing callers are
   * unchanged.
   */
  instrument?: Instrument;
}

export interface InvestmentAssetMeta {
  id: string;
  name: string;
  currency: string;
  liquidityTier: LiquidityTier;
  priceProvider: InvestmentPriceProvider;
  isin?: string;
  providerSymbol?: string;
  /** Compare vs price index when true (ADR 0060, #625). */
  benchmarkDistributing: boolean;
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
  benchmarkDistributing?: boolean;
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
  benchmarkDistributing?: boolean;
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
  source?: "manual" | "agent";
}

/** A stored housing valuation anchor as read back from the store. */
export interface ValuationAnchorRecord extends HousingValuationAnchor {
  id: string;
  assetId: string;
  source: "manual" | "agent";
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
  createManualAsset: (input: CreateManualAssetInput) => Promise<void>;
  createInvestmentAsset: (input: CreateInvestmentAssetInput) => Promise<void>;
  /**
   * @param projectionContext - Optional pre-built projection context (dedup
   *   #566). When provided, the internal `buildAssetProjectionContext` build is
   *   skipped. Build once via `store.snapshots.buildProjectionContext()` and pass
   *   to both this method and `readScopedPositionsWithDetails` to avoid reading
   *   the four underlying tables twice per cold dashboard load.
   */
  readAssets: (projectionContext?: AssetProjectionContext) => Promise<ManualAsset[]>;
  readInvestmentAssetById: (assetId: string) => Promise<InvestmentAssetFull | null>;
  readInvestmentAssetsWithMeta: () => Promise<InvestmentAssetMeta[]>;
  updateAsset: (assetId: string, input: UpdateAssetInput) => Promise<void>;
  updateAssetValuation: (assetId: string, currentValueMinor: number) => Promise<void>;
  updateInvestmentAsset: (input: UpdateInvestmentAssetInput) => Promise<void>;
  /**
   * Backfill an investment's ISIN when it has none (statement ISIN guard,
   * ADR 0018 S4). Sets ONLY the isin column, leaving other metadata intact, so a
   * later upload to the same asset is guarded. Returns 1 if updated, 0 if not found.
   */
  backfillInvestmentIsin: (assetId: string, isin: string) => Promise<number>;
  /** Soft-delete an asset (moves it to the trash). Returns 1 if moved, 0 if not found. */
  softDeleteAsset: (assetId: string, deletedAt: string) => Promise<number>;
  /** Restore a trashed asset. Returns 1 if restored, 0 if not found or not in trash. */
  restoreAsset: (assetId: string) => Promise<number>;
  /** Hard-delete a trashed asset (live data + overrides; snapshots untouched). Returns 1 if removed, 0 if not found or not in trash. */
  hardDeleteAsset: (assetId: string) => Promise<number>;
  /** Add a housing valuation anchor (market appraisal or improvement). */
  addValuationAnchor: (
    input: AddValuationAnchorInput,
    opts?: { batchId?: string },
  ) => Promise<void>;
  /** Read an asset's valuation anchors, ordered ascending by date. */
  readValuationAnchors: (assetId: string) => Promise<ValuationAnchorRecord[]>;
  /** Read ONE valuation anchor by its id, or null. Used by the dated-fact seam. */
  readValuationAnchorById: (anchorId: string) => Promise<ValuationAnchorRecord | null>;
  /** Delete a valuation anchor by id. Returns 1 if removed, 0 if not found. */
  deleteValuationAnchor: (anchorId: string) => Promise<number>;
  /**
   * Update an existing housing valuation anchor in place. Validates data types
   * and respects the (asset_id, valuation_date) unique index — changing the date
   * to one already occupied throws. Returns 1 if updated, 0 if not found.
   */
  updateValuationAnchor: (
    anchorId: string,
    input: UpdateValuationAnchorInput,
  ) => Promise<number>;
  /** Set (or clear, with null) an asset's annual appreciation rate (decimal string). */
  setAnnualAppreciationRate: (
    assetId: string,
    rate: DecimalString | null,
  ) => Promise<void>;
  /** Read an asset's annual appreciation rate, or null if unset. */
  readAnnualAppreciationRate: (assetId: string) => Promise<DecimalString | null>;
  /** Set (or clear, with null) an asset's valuation cadence (ADR 0031). */
  setValuationCadence: (
    assetId: string,
    cadence: ValuationCadence | null,
  ) => Promise<void>;
  /** Read an asset's valuation cadence, or null (reads as `step`) if unset. */
  readValuationCadence: (assetId: string) => Promise<ValuationCadence | null>;
  /**
   * Value a real-estate asset on `targetDate` (YYYY-MM-DD): reads its anchors +
   * rate + current value and delegates to the pure domain curve. `today` is a
   * parameter so the calculation stays deterministic.
   */
  valueHousingAtDate: (
    assetId: string,
    targetDate: string,
    today: string,
  ) => Promise<number>;
}

export function createAssetStore(ctx: StoreContext): AssetStore {
  return {
    createManualAsset: (input) => createManualAssetRecord(ctx, input),
    createInvestmentAsset: (input) => createInvestmentAsset(ctx, input),
    readAssets: async (projectionContext) =>
      readAssets(ctx.db, await ctx.getWorkspace(), projectionContext),
    readInvestmentAssetById: (assetId) => readInvestmentAssetById(ctx, assetId),
    readInvestmentAssetsWithMeta: () => readInvestmentAssetsWithMeta(ctx),
    updateAsset: (assetId, input) => updateAsset(ctx, assetId, input),
    updateAssetValuation: (assetId, currentValueMinor) =>
      updateAssetValuation(ctx, assetId, currentValueMinor),
    updateInvestmentAsset: (input) => updateInvestmentAsset(ctx, input),
    backfillInvestmentIsin: (assetId, isin) => backfillInvestmentIsin(ctx, assetId, isin),
    softDeleteAsset: (assetId, deletedAt) => softDeleteAsset(ctx, assetId, deletedAt),
    restoreAsset: (assetId) => restoreAsset(ctx, assetId),
    hardDeleteAsset: (assetId) => ctx.transaction(() => hardDeleteAssetTx(ctx, assetId)),
    addValuationAnchor: (input, opts) => addValuationAnchor(ctx, input, opts),
    readValuationAnchors: (assetId) => readValuationAnchors(ctx, assetId),
    readValuationAnchorById: (anchorId) => readValuationAnchorById(ctx, anchorId),
    deleteValuationAnchor: (anchorId) => deleteValuationAnchor(ctx, anchorId),
    updateValuationAnchor: (anchorId, input) =>
      updateValuationAnchor(ctx, anchorId, input),
    setAnnualAppreciationRate: (assetId, rate) =>
      setAnnualAppreciationRate(ctx, assetId, rate),
    readAnnualAppreciationRate: (assetId) => readAnnualAppreciationRate(ctx, assetId),
    setValuationCadence: (assetId, cadence) => setValuationCadence(ctx, assetId, cadence),
    readValuationCadence: (assetId) => readValuationCadence(ctx, assetId),
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

async function addValuationAnchor(
  ctx: StoreContext,
  input: AddValuationAnchorInput,
  opts?: { batchId?: string },
): Promise<void> {
  if (!Number.isInteger(input.valueMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }
  assertValuationDate(input.valuationDate);

  await assertAssetAllowsStoredValuationWrite(ctx, input.assetId);

  await ctx.db
    .insert(assetValuations)
    .values({
      adjustsPriorCurve: input.adjustsPriorCurve ? 1 : 0,
      assetId: input.assetId,
      batchId: opts?.batchId ?? null,
      id: input.id,
      source: input.source ?? "manual",
      valuationDate: input.valuationDate,
      valueMinor: input.valueMinor,
    })
    .run();

  await ctx.writeAuditEntry("add_valuation_anchor", "asset", input.assetId, {
    adjustsPriorCurve: input.adjustsPriorCurve,
    anchorId: input.id,
    valuationDate: input.valuationDate,
    valueMinor: input.valueMinor,
  });
}

async function readValuationAnchors(
  ctx: StoreContext,
  assetId: string,
): Promise<ValuationAnchorRecord[]> {
  const rows = await ctx.db
    .select()
    .from(assetValuations)
    .where(eq(assetValuations.assetId, assetId))
    .orderBy(asc(assetValuations.valuationDate), asc(assetValuations.id))
    .all();

  return rows.map((row) => ({
    adjustsPriorCurve: row.adjustsPriorCurve === 1,
    assetId: row.assetId,
    id: row.id,
    source: row.source,
    valuationDate: row.valuationDate,
    valueMinor: row.valueMinor,
  }));
}

async function readValuationAnchorById(
  ctx: StoreContext,
  anchorId: string,
): Promise<ValuationAnchorRecord | null> {
  const row = await ctx.db
    .select()
    .from(assetValuations)
    .where(eq(assetValuations.id, anchorId))
    .get();

  if (!row) return null;

  return {
    adjustsPriorCurve: row.adjustsPriorCurve === 1,
    assetId: row.assetId,
    id: row.id,
    source: row.source,
    valuationDate: row.valuationDate,
    valueMinor: row.valueMinor,
  };
}

async function deleteValuationAnchor(
  ctx: StoreContext,
  anchorId: string,
): Promise<number> {
  const row = await ctx.db
    .select({ assetId: assetValuations.assetId })
    .from(assetValuations)
    .where(eq(assetValuations.id, anchorId))
    .get();

  if (!row) return 0;

  const result = await ctx.db
    .delete(assetValuations)
    .where(eq(assetValuations.id, anchorId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("delete_valuation_anchor", "asset", row.assetId, {
      anchorId,
    });
  }
  return result.rowsAffected;
}

async function updateValuationAnchor(
  ctx: StoreContext,
  anchorId: string,
  input: UpdateValuationAnchorInput,
): Promise<number> {
  if (input.valueMinor !== undefined && !Number.isInteger(input.valueMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }
  if (input.valuationDate !== undefined) {
    assertValuationDate(input.valuationDate);
  }

  const existing = await ctx.db
    .select({ assetId: assetValuations.assetId })
    .from(assetValuations)
    .where(eq(assetValuations.id, anchorId))
    .get();

  if (!existing) return 0;

  await assertAssetAllowsStoredValuationWrite(ctx, existing.assetId);

  const fields: Partial<typeof assetValuations.$inferInsert> = {};
  if (input.valueMinor !== undefined) fields.valueMinor = input.valueMinor;
  if (input.valuationDate !== undefined) fields.valuationDate = input.valuationDate;
  if (input.adjustsPriorCurve !== undefined) {
    fields.adjustsPriorCurve = input.adjustsPriorCurve ? 1 : 0;
  }

  const result = await ctx.db
    .update(assetValuations)
    .set(fields)
    .where(eq(assetValuations.id, anchorId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("update_valuation_anchor", "asset", existing.assetId, {
      anchorId,
      ...input,
    });
  }
  return result.rowsAffected;
}

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

async function setAnnualAppreciationRate(
  ctx: StoreContext,
  assetId: string,
  rate: DecimalString | null,
): Promise<void> {
  if (rate !== null && !DECIMAL_STRING.test(rate)) {
    throw new Error(
      `Annual appreciation rate must be a decimal string (e.g. "0.03"), got "${rate}".`,
    );
  }

  await assertAssetAllowsStoredValuationWrite(ctx, assetId);

  await ctx.db
    .update(assets)
    .set({ annualAppreciationRate: rate, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(assets.id, assetId))
    .run();

  await ctx.writeAuditEntry("set_appreciation_rate", "asset", assetId, { rate });
}

async function readAnnualAppreciationRate(
  ctx: StoreContext,
  assetId: string,
): Promise<DecimalString | null> {
  const row = await ctx.db
    .select({ annualAppreciationRate: assets.annualAppreciationRate })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  return row?.annualAppreciationRate ?? null;
}

async function setValuationCadence(
  ctx: StoreContext,
  assetId: string,
  cadence: ValuationCadence | null,
): Promise<void> {
  await assertAssetAllowsStoredValuationWrite(ctx, assetId);

  await ctx.db
    .update(assets)
    .set({ valuationCadence: cadence, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(assets.id, assetId))
    .run();

  await ctx.writeAuditEntry("set_valuation_cadence", "asset", assetId, { cadence });
}

async function readValuationCadence(
  ctx: StoreContext,
  assetId: string,
): Promise<ValuationCadence | null> {
  const row = await ctx.db
    .select({ valuationCadence: assets.valuationCadence })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  return row?.valuationCadence ?? null;
}

async function valueHousingAtDateFor(
  ctx: StoreContext,
  assetId: string,
  targetDate: string,
  today: string,
): Promise<number> {
  const row = await ctx.db
    .select({
      annualAppreciationRate: assets.annualAppreciationRate,
      currentValueMinor: assets.currentValueMinor,
      valuationCadence: assets.valuationCadence,
    })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  if (!row) {
    throw new Error(`Asset "${assetId}" not found.`);
  }

  const anchors: HousingValuationAnchor[] = (
    await readValuationAnchors(ctx, assetId)
  ).map((anchor) => ({
    adjustsPriorCurve: anchor.adjustsPriorCurve,
    valuationDate: anchor.valuationDate,
    valueMinor: anchor.valueMinor,
  }));

  // The stored cadence (ADR 0031, #394); null reads as the default `step`.
  const cadence = row.valuationCadence ?? null;

  return valueHousingAtDate({
    anchors,
    annualAppreciationRate: row.annualAppreciationRate,
    currentValueMinor: row.currentValueMinor,
    targetDate,
    today,
    ...(cadence != null ? { cadence } : {}),
  });
}

async function createManualAssetRecord(
  ctx: StoreContext,
  input: CreateManualAssetInput,
): Promise<void> {
  const { db } = ctx;
  const workspace = await ctx.getWorkspace();

  if (!workspace) {
    throw new Error("Workspace must be initialized before creating assets.");
  }

  const asset = createManualAsset(workspace, input);
  await ctx.transaction(async () => {
    await db
      .insert(assets)
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
      await db
        .insert(assetOwnerships)
        .values(
          asset.ownership.map((share) => ({
            assetId: asset.id,
            memberId: share.memberId,
            shareBps: share.shareBps,
          })),
        )
        .run();
    }

    // Register the holding's agent-view public id on creation (#335) so the
    // non-lazy read path never 500s on a missing id — mirrors createMember.
    await ensureAgentViewPublicIds(ctx, publicIdTargetsForHolding(asset.id));
  });

  await ctx.writeAuditEntry("create_asset", "asset", asset.id);
}

async function createInvestmentAsset(
  ctx: StoreContext,
  input: CreateInvestmentAssetInput,
): Promise<void> {
  const { db } = ctx;
  const workspace = await ctx.getWorkspace();

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
    // The instrument-first add flow (#151) passes the chosen instrument. Older
    // callers don't, so mirror the v14 backfill: a Finect-priced investment is a
    // pension plan, anything else a fund.
    instrument:
      input.instrument ?? (input.priceProvider === "finect" ? "pension_plan" : "fund"),
    isPrimaryResidence: false,
    liquidityTier: input.liquidityTier ?? "market",
    name: input.name,
    ownership: input.ownership,
    type: "investment",
  });
  const pricedAt = input.manualPricePerUnit ? new Date().toISOString() : null;

  await ctx.transaction(async () => {
    await db
      .insert(assets)
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
      await db
        .insert(assetOwnerships)
        .values(
          asset.ownership.map((share) => ({
            assetId: asset.id,
            memberId: share.memberId,
            shareBps: share.shareBps,
          })),
        )
        .run();
    }

    await db
      .insert(investmentAssets)
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

    // An investment is a holding too — register its agent-view public id on
    // creation (#335) so the non-lazy read path never 500s on a missing id.
    await ensureAgentViewPublicIds(ctx, publicIdTargetsForHolding(asset.id));
  });
}

async function readInvestmentAssetById(
  ctx: StoreContext,
  assetId: string,
): Promise<InvestmentAssetFull | null> {
  const { db } = ctx;
  const row = await db
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

  const investRow = await db
    .select({
      unitSymbol: investmentAssets.unitSymbol,
      isin: investmentAssets.isin,
      priceProvider: investmentAssets.priceProvider,
      providerSymbol: investmentAssets.providerSymbol,
      manualPricePerUnit: investmentAssets.manualPricePerUnit,
      benchmarkDistributing: investmentAssets.benchmarkDistributing,
    })
    .from(investmentAssets)
    .where(eq(investmentAssets.assetId, assetId))
    .get();

  if (!investRow) return null;

  const ownershipRows = await db
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
    benchmarkDistributing: investRow.benchmarkDistributing === 1,
  };
}

async function readInvestmentAssetsWithMeta(
  ctx: StoreContext,
): Promise<InvestmentAssetMeta[]> {
  const { db } = ctx;
  const rows = await db
    .select({
      id: assets.id,
      name: assets.name,
      currency: assets.currency,
      liquidityTier: assets.liquidityTier,
      priceProvider: investmentAssets.priceProvider,
      isin: investmentAssets.isin,
      providerSymbol: investmentAssets.providerSymbol,
      benchmarkDistributing: investmentAssets.benchmarkDistributing,
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
    priceProvider: row.priceProvider ?? defaultInvestmentPriceProvider(row.liquidityTier),
    benchmarkDistributing: row.benchmarkDistributing === 1,
    ...(row.isin ? { isin: row.isin } : {}),
    ...(row.providerSymbol ? { providerSymbol: row.providerSymbol } : {}),
  }));
}

async function updateAsset(
  ctx: StoreContext,
  assetId: string,
  input: UpdateAssetInput,
): Promise<void> {
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

  // Housing-ness is sourced from the instrument (#149), and the stored column
  // wins in instrumentOfAsset — so a type / primary-residence edit must re-derive
  // it from the EFFECTIVE values (current row merged with the input). Otherwise
  // the instrument goes stale and isHousingAsset silently diverges from the edit.
  if (input.type !== undefined || input.isPrimaryResidence !== undefined) {
    const current = await db
      .select({ type: assets.type, isPrimaryResidence: assets.isPrimaryResidence })
      .from(assets)
      .where(eq(assets.id, assetId))
      .get();
    if (current) {
      const effectiveType = input.type ?? current.type;
      const effectiveIsPrimary =
        input.isPrimaryResidence ?? current.isPrimaryResidence === 1;
      fields.instrument = defaultInstrumentForAssetType(
        effectiveType,
        effectiveIsPrimary,
      );
    }
  }

  await ctx.transaction(async () => {
    if (Object.keys(fields).length > 0) {
      await db
        .update(assets)
        .set({ ...fields, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(assets.id, assetId))
        .run();
    }

    if (input.ownership !== undefined) {
      await db.delete(assetOwnerships).where(eq(assetOwnerships.assetId, assetId)).run();

      if (input.ownership.length > 0) {
        await db
          .insert(assetOwnerships)
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

  await ctx.writeAuditEntry("update_asset", "asset", assetId, {
    ...input,
    ownership: undefined,
  });
}

async function updateAssetValuation(
  ctx: StoreContext,
  assetId: string,
  currentValueMinor: number,
): Promise<void> {
  const { db } = ctx;

  if (!Number.isInteger(currentValueMinor)) {
    throw new Error("Money must be stored as integer minor units.");
  }

  await assertAssetAllowsStoredValuationWrite(ctx, assetId);

  await db
    .update(assets)
    .set({ currentValueMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(assets.id, assetId))
    .run();
  await ctx.writeAuditEntry("update_valuation", "asset", assetId, { currentValueMinor });
}

async function updateInvestmentAsset(
  ctx: StoreContext,
  input: UpdateInvestmentAssetInput,
): Promise<void> {
  const { db } = ctx;
  const assetFields: Partial<typeof assets.$inferInsert> = { name: input.name };

  if (input.liquidityTier) {
    assetFields.liquidityTier = input.liquidityTier;
  }

  await ctx.transaction(async () => {
    await db
      .update(assets)
      .set({ ...assetFields, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(assets.id, input.id))
      .run();

    await db
      .update(investmentAssets)
      .set({
        unitSymbol: input.unitSymbol ?? null,
        isin: input.isin ?? null,
        priceProvider: input.priceProvider ?? null,
        providerSymbol: input.providerSymbol ?? null,
        manualPricePerUnit: input.manualPricePerUnit ?? null,
        ...(input.benchmarkDistributing === undefined
          ? {}
          : { benchmarkDistributing: input.benchmarkDistributing ? 1 : 0 }),
      })
      .where(eq(investmentAssets.assetId, input.id))
      .run();
  });

  await ctx.writeAuditEntry("update_investment_asset", "asset", input.id, {
    name: input.name,
  });
}

async function backfillInvestmentIsin(
  ctx: StoreContext,
  assetId: string,
  isin: string,
): Promise<number> {
  const result = await ctx.db
    .update(investmentAssets)
    .set({ isin })
    .where(eq(investmentAssets.assetId, assetId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("backfill_investment_isin", "asset", assetId, { isin });
  }

  return result.rowsAffected;
}

async function softDeleteAsset(
  ctx: StoreContext,
  assetId: string,
  deletedAt: string,
): Promise<number> {
  const result = await ctx.db
    .update(assets)
    .set({ deletedAt })
    .where(eq(assets.id, assetId))
    .run();
  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("delete_asset", "asset", assetId, { deletedAt });
  }
  return result.rowsAffected;
}

async function restoreAsset(ctx: StoreContext, assetId: string): Promise<number> {
  const result = await ctx.db
    .update(assets)
    .set({ deletedAt: null })
    .where(and(eq(assets.id, assetId), isNotNull(assets.deletedAt)))
    .run();
  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("restore_asset", "asset", assetId);
  }
  return result.rowsAffected;
}
