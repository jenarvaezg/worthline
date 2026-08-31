import type {
  AssetProjectionContext,
  CreateManualAssetInput,
  DecimalString,
  HoldingTrashRefusal,
  HousingValuationAnchor,
  Instrument,
  InstrumentIdentityPatch,
  InvestmentPriceProvider,
  LiquidityTier,
  ManualAsset,
  OwnershipShare,
  TrashExit,
  ValuationCadence,
} from "@worthline/domain";
import {
  createManualAsset,
  defaultInstrumentForAssetType,
  defaultInvestmentPriceProvider,
  defaultsFor,
  isRealCalendarDay,
  validIsinOrNull,
  valueHousingAtDate,
} from "@worthline/domain";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  ensureAgentViewPublicIds,
  publicIdTargetsForHolding,
} from "./agent-view-public-ids";
import { hardDeleteAssetTx, readAssets } from "./asset-reads";
import { chunk } from "./chunk";
import type { FactPersistenceProvenance } from "./fact-provenance";
import {
  assetOwnerships,
  assets,
  assetValuations,
  contributionLots,
  investmentAssets,
} from "./schema";
import type { StoreContext } from "./store-context";
import { checkAssetTrashGate } from "./trash-gate";
import { assertAssetAllowsStoredValuationWrite } from "./valuation-guard";

/**
 * What the Papelera's door answered (#1549). `refused` is a first-class outcome,
 * not an exception and not a `0`: the caller has a message to render and a fact to
 * render it from, and «no existe» must never read as «no puedes».
 */
export type SoftDeleteAssetOutcome =
  | { status: "deleted" }
  | { status: "not_found" }
  | { status: "refused"; refusal: HoldingTrashRefusal };

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
  /**
   * Correct what the investment IS (#1512, ADR 0098) — `fund` → `pension_plan` and
   * the like. Only the classification column moves: unlike the metadata columns
   * below, the instrument's default rung and price provider are NOT re-applied, so
   * a working symbol is never traded for a label fix.
   */
  instrument?: Instrument;
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
  /**
   * #1437: `'acquisition'` marks the anchor that starts the housing's history —
   * it may be edited by name but never deleted. Null for a plain appraisal or
   * improvement.
   */
  kind?: "acquisition";
}

/** A stored housing valuation anchor as read back from the store. */
export interface ValuationAnchorRecord extends HousingValuationAnchor {
  id: string;
  assetId: string;
  source: "manual" | "agent";
  /** #1437: `'acquisition'` when this anchor starts the housing's history. */
  kind: "acquisition" | null;
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
  /**
   * Correct what the holding IS (#1512, ADR 0098). Authoritative when present:
   * the legacy `type` is re-derived FROM it (`defaultsFor(...).assetType`) rather
   * than the other way round, so a `type` passed alongside is overridden instead
   * of racing it. Nothing else is re-applied — the declared rung, the valuation
   * and the price configuration the instrument merely *suggested* at the alta all
   * survive the correction.
   *
   * The caller is responsible for offering only a same-shape instrument
   * (`assignableInstruments`): moving a hand-valued asset onto a `derived`
   * instrument would promise an operations ledger this store never created.
   */
  instrument?: Instrument;
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
  /**
   * Fill an investment's identity columns (#1349) — ONLY the ones present in the
   * patch, like `backfillInvestmentIsin` above and unlike `updateInvestmentAsset`,
   * whose form-shaped input nulls every metadata column it is not given. The
   * assistant's correction never carries the whole metadata row, so a full replace
   * would silently drop the unit symbol or the manual price. Returns 1 if updated,
   * 0 if not found (or if the patch is empty).
   */
  patchInvestmentIdentity: (
    assetId: string,
    patch: InstrumentIdentityPatch & { priceProvider?: InvestmentPriceProvider },
  ) => Promise<number>;
  /**
   * Soft-delete an asset (moves it to the trash), through the Papelera's gate
   * (#1549): a position with units still inside is REFUSED unless the caller
   * declares the `mis_entry` exit, and a managed portfolio's cash sibling is
   * refused outright while the portfolio lives. The gate is here, not in the
   * Server Action, because the assistant writes below the web's guards.
   *
   * `exit` is also what the row remembers about how the holding left, so a
   * caller that has just recorded the sale or the traspaso passes `sold` /
   * `transferred` — those name the movement, they do not unlock anything.
   */
  softDeleteAsset: (
    assetId: string,
    deletedAt: string,
    exit?: TrashExit | null,
  ) => Promise<SoftDeleteAssetOutcome>;
  /** Restore a trashed asset. Returns 1 if restored, 0 if not found or not in trash. */
  restoreAsset: (assetId: string) => Promise<number>;
  /** Hard-delete a trashed asset (live data + overrides; snapshots untouched). Returns 1 if removed, 0 if not found or not in trash. */
  hardDeleteAsset: (assetId: string) => Promise<number>;
  /** Add a housing valuation anchor (market appraisal or improvement). */
  addValuationAnchor: (
    input: AddValuationAnchorInput,
    provenance?: FactPersistenceProvenance,
  ) => Promise<void>;
  /**
   * Add a whole BATCH of valuation anchors in batched writes (#1440) — the shape
   * a mixed-document import needs, where one round-trip per appraisal is dozens
   * of round-trips.
   */
  addValuationAnchors: (
    inputs: readonly AddValuationAnchorInput[],
    provenance?: FactPersistenceProvenance,
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
  /**
   * Set (or clear, with null) a property's acquisition cost in minor units
   * (#1441) — what was DISBURSED to acquire it, the twin of an investment's cost
   * basis. Refuses any holding that is not `real_estate`.
   *
   * Writes no dated fact and ripples NOTHING: the housing curve, equity and every
   * snapshot are derived from the VALUE anchors, and the cost is not one of them.
   * That is the whole reason it is a plain column on `assets` and not an anchor.
   */
  setAcquisitionCostMinor: (assetId: string, costMinor: number | null) => Promise<void>;
  /** Read a property's acquisition cost in minor units, or null if unset (#1441). */
  readAcquisitionCostMinor: (assetId: string) => Promise<number | null>;
  /**
   * Declarar (o borrar, con null) desde cuándo se puede tocar un holding a plazo
   * (`YYYY-MM-DD`, #1528, ADR 0100). Rechaza cualquier holding que no esté en el
   * escalón `term-locked`: es el único peldaño que ADR 0013 define con un plazo, y
   * una fecha en otro sitio sería un bloqueo que nadie ha reclamado.
   *
   * No escribe ningún hecho fechado y NO ripplea nada: lo único que la lee es el
   * reparto del gasto sostenible de agotamiento, que se recalcula en cada lectura.
   * Ningún snapshot ya capturado puede moverse por declarar una fecha.
   */
  setAvailableFrom: (assetId: string, availableFrom: string | null) => Promise<void>;
  /** Leer la fecha de disponibilidad declarada de un holding, o null (#1528). */
  readAvailableFrom: (assetId: string) => Promise<string | null>;
  /**
   * Reemplazar los lotes de aportación de un holding a plazo (#1676). La lista
   * ENTERA, nunca un `push`: la escalera de un plan es una declaración completa, y
   * mezclar altas sueltas con un borrado por id dejaría estados intermedios en los
   * que el holding dice tener menos capital fechado del que su dueño cree.
   *
   * Rechaza igual que `setAvailableFrom` —solo el escalón `term-locked`— y con la
   * misma regla de fecha real, porque este seam también está exportado. Un importe
   * que no sea un entero positivo se rechaza: un lote de cero no es una declaración
   * y uno negativo no es nada.
   *
   * No escribe ningún hecho fechado y no ripplea: lo único que lee los lotes es el
   * reparto del gasto sostenible, que se recalcula en cada lectura.
   */
  replaceContributionLots: (
    assetId: string,
    lots: readonly { availableFrom: string; amountMinor: number }[],
  ) => Promise<void>;
  /**
   * Añadir un lote a la escalera existente, leyendo y reescribiendo dentro de UNA
   * transacción (#1676). Existe para que la Server Action no tenga que hacer el
   * read-modify-write por su cuenta, donde dos pestañas se pisarían.
   */
  addContributionLot: (
    assetId: string,
    lot: { availableFrom: string; amountMinor: number },
  ) => Promise<void>;
  /** Quitar un lote por su id, con la misma atomicidad que el alta (#1676). */
  removeContributionLot: (assetId: string, lotId: string) => Promise<void>;
  /** Leer los lotes de aportación de un holding, de antes a después (#1676). */
  readContributionLots: (
    assetId: string,
  ) => Promise<{ id: string; availableFrom: string; amountMinor: number }[]>;
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
    patchInvestmentIdentity: (assetId, patch) =>
      patchInvestmentIdentity(ctx, assetId, patch),
    softDeleteAsset: (assetId, deletedAt, exit) =>
      softDeleteAsset(ctx, assetId, deletedAt, exit ?? null),
    restoreAsset: (assetId) => restoreAsset(ctx, assetId),
    hardDeleteAsset: (assetId) => ctx.transaction(() => hardDeleteAssetTx(ctx, assetId)),
    addValuationAnchor: (input, opts) => addValuationAnchors(ctx, [input], opts),
    addValuationAnchors: (inputs, opts) => addValuationAnchors(ctx, inputs, opts),
    readValuationAnchors: (assetId) => readValuationAnchors(ctx, assetId),
    readValuationAnchorById: (anchorId) => readValuationAnchorById(ctx, anchorId),
    deleteValuationAnchor: (anchorId) => deleteValuationAnchor(ctx, anchorId),
    updateValuationAnchor: (anchorId, input) =>
      updateValuationAnchor(ctx, anchorId, input),
    setAnnualAppreciationRate: (assetId, rate) =>
      setAnnualAppreciationRate(ctx, assetId, rate),
    readAnnualAppreciationRate: (assetId) => readAnnualAppreciationRate(ctx, assetId),
    setAcquisitionCostMinor: (assetId, costMinor) =>
      setAcquisitionCostMinor(ctx, assetId, costMinor),
    readAcquisitionCostMinor: (assetId) => readAcquisitionCostMinor(ctx, assetId),
    setAvailableFrom: (assetId, availableFrom) =>
      setAvailableFrom(ctx, assetId, availableFrom),
    readAvailableFrom: (assetId) => readAvailableFrom(ctx, assetId),
    replaceContributionLots: (assetId, lots) =>
      replaceContributionLots(ctx, assetId, lots),
    addContributionLot: (assetId, lot) => addContributionLot(ctx, assetId, lot),
    removeContributionLot: (assetId, lotId) => removeContributionLot(ctx, assetId, lotId),
    readContributionLots: (assetId) => readContributionLots(ctx, assetId),
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

/**
 * Valuation-anchor rows per batched INSERT. Seven columns each, so a group of
 * 50 stays well below the per-statement parameter cap (#1440).
 */
const VALUATIONS_PER_INSERT = 50;

function valuationRow(
  input: AddValuationAnchorInput,
  provenance?: FactPersistenceProvenance,
) {
  return {
    adjustsPriorCurve: input.adjustsPriorCurve ? 1 : 0,
    assetId: input.assetId,
    batchId: provenance?.batchId ?? null,
    id: input.id,
    kind: input.kind ?? null,
    source: input.source ?? "manual",
    valuationDate: input.valuationDate,
    valueMinor: input.valueMinor,
  };
}

/**
 * Persist a whole BATCH of housing valuation anchors (#1440). A mixed-document
 * import applies many appraisals at once; one `await` per appraisal is one
 * round-trip per appraisal against a remote Turso, so the rows — and their
 * audit trail, still one row per fact — go in batched.
 *
 * A batch longer than one chunk spans several statements, so the CALLER owns the
 * transaction (the statement import applies the batch inside `ctx.transaction`,
 * ADR 0020) — without it a long batch could land half-written.
 */
async function addValuationAnchors(
  ctx: StoreContext,
  inputs: readonly AddValuationAnchorInput[],
  provenance?: FactPersistenceProvenance,
): Promise<void> {
  if (inputs.length === 0) return;

  for (const input of inputs) {
    if (!Number.isInteger(input.valueMinor)) {
      throw new Error("Money must be stored as integer minor units.");
    }
    assertValuationDate(input.valuationDate);
  }

  for (const assetId of new Set(inputs.map((input) => input.assetId))) {
    await assertAssetAllowsStoredValuationWrite(ctx, assetId);
  }

  for (const group of chunk(inputs, VALUATIONS_PER_INSERT)) {
    await ctx.db
      .insert(assetValuations)
      .values(group.map((input) => valuationRow(input, provenance)))
      .run();
  }

  await ctx.writeAuditEntries(
    inputs.map((input) => ({
      action: "add_valuation_anchor",
      details: {
        adjustsPriorCurve: input.adjustsPriorCurve,
        anchorId: input.id,
        valuationDate: input.valuationDate,
        valueMinor: input.valueMinor,
      },
      entityId: input.assetId,
      entityType: "asset",
    })),
  );
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
    kind: row.kind ?? null,
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
    kind: row.kind ?? null,
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

/**
 * Persist what the owner DISBURSED to acquire a property (#1441): the escritura
 * price plus ITP/AJD, notaría, registro and gestoría. `null` clears it back to
 * «nobody has typed it yet» — the state every property on the book starts in,
 * because its acquisition anchor mixes value and cost and copying that figure
 * here would seal the confusion as data.
 *
 * No ripple, by construction. The curve, housing equity, the implied LTV and
 * every historical snapshot read the VALUE anchors; nothing in the engine reads
 * this column, so a cost edit cannot move a figure that was already captured.
 * Compare `setAnnualAppreciationRate` above, whose seam MUST re-derive history.
 */
async function setAcquisitionCostMinor(
  ctx: StoreContext,
  assetId: string,
  costMinor: number | null,
): Promise<void> {
  // Positive, not merely non-negative: `null` is how «todavía no lo sé» is said, so a
  // stored 0 would be a THIRD state — one that renders «Resultado frente al coste
  // +⟨el valor íntegro⟩», the invented figure this whole ticket exists to prevent
  // («sin coste, no se finge un 0 %»). The web parser already refuses it; the seam is
  // exported, so it refuses it too rather than trusting its callers.
  if (costMinor !== null && (!Number.isInteger(costMinor) || costMinor <= 0)) {
    throw new Error(
      `Acquisition cost must be a positive integer of minor units (null to clear), got "${costMinor}".`,
    );
  }

  // Only a property has an acquisition cost (the column is nullable for every
  // other type). The rule is enforced here rather than as a SQL CHECK, the same
  // choice `annual_appreciation_rate` makes (PRD #108, pattern R9).
  const row = await ctx.db
    .select({ type: assets.type })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  if (!row) {
    throw new Error(`Asset "${assetId}" not found.`);
  }

  if (row.type !== "real_estate") {
    throw new Error("Only a real-estate holding can carry an acquisition cost.");
  }

  await ctx.db
    .update(assets)
    .set({ acquisitionCostMinor: costMinor, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(assets.id, assetId))
    .run();

  await ctx.writeAuditEntry("set_acquisition_cost", "asset", assetId, { costMinor });
}

async function readAcquisitionCostMinor(
  ctx: StoreContext,
  assetId: string,
): Promise<number | null> {
  const row = await ctx.db
    .select({ acquisitionCostMinor: assets.acquisitionCostMinor })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  return row?.acquisitionCostMinor ?? null;
}

/**
 * Persistir desde cuándo se puede tocar un holding a plazo (#1528, ADR 0100).
 * `null` lo devuelve a «nadie lo ha dicho», el estado en el que empiezan todos.
 *
 * Lo que se declara es una FECHA y nunca un importe: un «disponible hoy: 4.979 €»
 * caduca cada año y nadie lo revalida (la avería de #1415, prohibida por ADR 0074).
 * El importe disponible se deriva en lectura, contra el día de quien lee.
 *
 * Sin ripple, por construcción: nada del histórico lee esta columna — solo el reparto
 * del gasto sostenible de agotamiento, que se recalcula entero cada vez. Compárese con
 * `setAnnualAppreciationRate`, cuyo seam SÍ tiene que re-derivar historia.
 */
async function setAvailableFrom(
  ctx: StoreContext,
  assetId: string,
  availableFrom: string | null,
): Promise<void> {
  // `isRealCalendarDay` y no solo la forma: `2035-02-30` pasa el patrón AAAA-MM-DD y
  // `Date` lo desplaza en silencio al 1 de marzo, así que guardarlo sería un bloqueo
  // que nadie ha declarado. El parser de la web ya lo rechaza; el seam está exportado
  // (el import de un workspace escribe la columna sin pasar por él), así que lo
  // comprueba con la MISMA regla en vez de con una más laxa.
  if (availableFrom !== null && !isRealCalendarDay(availableFrom)) {
    throw new Error(
      `Available-from must be a YYYY-MM-DD date (null to clear), got "${availableFrom}".`,
    );
  }

  // Solo el escalón a plazo reclama un plazo (ADR 0013). La regla se aplica aquí y no
  // como CHECK de SQL, la misma elección que `acquisition_cost_minor`. El seam está
  // exportado, así que la comprueba él en vez de fiarse de sus llamadores.
  const row = await ctx.db
    .select({ liquidityTier: assets.liquidityTier })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  if (!row) {
    throw new Error(`Asset "${assetId}" not found.`);
  }

  if (row.liquidityTier !== "term-locked") {
    throw new Error("Only a term-locked holding can declare an availability date.");
  }

  await ctx.db
    .update(assets)
    .set({ availableFrom, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(assets.id, assetId))
    .run();

  await ctx.writeAuditEntry("set_available_from", "asset", assetId, { availableFrom });
}

async function readAvailableFrom(
  ctx: StoreContext,
  assetId: string,
): Promise<string | null> {
  const row = await ctx.db
    .select({ availableFrom: assets.availableFrom })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  return row?.availableFrom ?? null;
}

/**
 * La escalera de un holding a plazo, escrita entera (#1676).
 *
 * Borrar y volver a insertar, y no un diff: la lista que llega ES la declaración, así
 * que el estado final no puede depender de qué había antes. Un `id` nuevo por fila en
 * cada escritura es deliberado — un lote no es una entidad que el usuario siga entre
 * ediciones, es una línea de una declaración que se reemplaza de una pieza.
 */
async function replaceContributionLots(
  ctx: StoreContext,
  assetId: string,
  lots: readonly { availableFrom: string; amountMinor: number }[],
): Promise<void> {
  const row = await ctx.db
    .select({ liquidityTier: assets.liquidityTier })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  if (!row) {
    throw new Error(`Asset "${assetId}" not found.`);
  }

  // La misma puerta que `setAvailableFrom`: el peldaño es el dueño de la pregunta.
  if (row.liquidityTier !== "term-locked") {
    throw new Error("Only a term-locked holding can declare contribution lots.");
  }

  for (const lot of lots) {
    // `isRealCalendarDay` y no solo el patrón, por lo mismo que la fecha única: el
    // 30 de febrero pasa la forma y `Date` lo desplaza en silencio.
    if (!isRealCalendarDay(lot.availableFrom)) {
      throw new Error(
        `Contribution lot date must be a real YYYY-MM-DD day, got "${lot.availableFrom}".`,
      );
    }
    if (!Number.isSafeInteger(lot.amountMinor) || lot.amountMinor <= 0) {
      throw new Error(
        `Contribution lot amount must be a positive integer of minor units, got "${lot.amountMinor}".`,
      );
    }
  }

  // Borrado e inserción en UNA transacción: la escalera se reemplaza de una pieza, y
  // sin esto un insert que falle dejaría al holding sin ningún lote — un plan entero
  // leyéndose como capital sin fechar por un error a mitad de escritura.
  await ctx.transaction(async () => {
    await ctx.db
      .delete(contributionLots)
      .where(eq(contributionLots.assetId, assetId))
      .run();

    if (lots.length > 0) {
      await ctx.db
        .insert(contributionLots)
        .values(
          lots.map((lot) => ({
            amountMinor: lot.amountMinor,
            assetId,
            availableFrom: lot.availableFrom,
            id: ctx.newId(),
          })),
        )
        .run();
    }

    await ctx.writeAuditEntry("replace_contribution_lots", "asset", assetId, {
      lots: lots.length,
    });
  });
}

/**
 * Añadir un lote a la escalera, leyendo y reescribiendo DENTRO de una transacción
 * (#1676). El read-modify-write no puede vivir en la Server Action: dos pestañas
 * declarando lotes a la vez leerían la misma escalera y la segunda escritura borraría
 * el lote de la primera sin que nadie se entere.
 */
async function addContributionLot(
  ctx: StoreContext,
  assetId: string,
  lot: { availableFrom: string; amountMinor: number },
): Promise<void> {
  await ctx.transaction(async () => {
    const existing = await readContributionLots(ctx, assetId);
    await replaceContributionLots(ctx, assetId, [
      ...existing.map((row) => ({
        amountMinor: row.amountMinor,
        availableFrom: row.availableFrom,
      })),
      lot,
    ]);
  });
}

/**
 * Quitar un lote de la escalera por su id, con la misma atomicidad que el alta. Un id
 * que ya no está no es un error: la escalera ya no lo tiene, que es lo que se pedía.
 */
async function removeContributionLot(
  ctx: StoreContext,
  assetId: string,
  lotId: string,
): Promise<void> {
  await ctx.transaction(async () => {
    const existing = await readContributionLots(ctx, assetId);
    const remaining = existing.filter((row) => row.id !== lotId);
    if (remaining.length === existing.length) {
      return;
    }
    await replaceContributionLots(
      ctx,
      assetId,
      remaining.map((row) => ({
        amountMinor: row.amountMinor,
        availableFrom: row.availableFrom,
      })),
    );
  });
}

async function readContributionLots(
  ctx: StoreContext,
  assetId: string,
): Promise<{ id: string; availableFrom: string; amountMinor: number }[]> {
  return ctx.db
    .select({
      amountMinor: contributionLots.amountMinor,
      availableFrom: contributionLots.availableFrom,
      id: contributionLots.id,
    })
    .from(contributionLots)
    .where(eq(contributionLots.assetId, assetId))
    .orderBy(contributionLots.availableFrom)
    .all();
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
        isin: normalizedIsinColumnValue(input.isin),
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

  // #1512: an EXPLICIT instrument is the correction itself, so it wins over the
  // derivation below and drags the legacy AssetType behind it (ADR 0098). An
  // investment instrument declares no AssetType — it persists through the
  // investment path — so `type` is left as it stands for those.
  //
  // The primary-residence flag is force-cleared off any non-`property`
  // instrument: leaving it set would let the very next type edit re-derive
  // `property` (the rule right below) and silently undo the correction.
  if (input.instrument !== undefined) {
    fields.instrument = input.instrument;
    const assetType = defaultsFor(input.instrument).assetType;
    if (assetType) {
      fields.type = assetType;
    }
    if (input.instrument !== "property") {
      fields.isPrimaryResidence = 0;
    }
  }

  // Housing-ness is sourced from the instrument (#149), and the stored column
  // wins in instrumentOfAsset — so a type / primary-residence edit must re-derive
  // it from the EFFECTIVE values (current row merged with the input). Otherwise
  // the instrument goes stale and isHousingAsset silently diverges from the edit.
  if (
    input.instrument === undefined &&
    (input.type !== undefined || input.isPrimaryResidence !== undefined)
  ) {
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

/**
 * The isin column stores an ISIN or nothing (#1453). Every interactive identity
 * write funnels through here: a non-ISIN in the column makes the exposure catalog
 * register the row under the provider key while the look-through searches under
 * the raw value, so the holding turns «sin clasificar» with nothing warning about
 * it. The UI and assistant boundaries refuse earlier with friendly messages —
 * this is the backstop under all of them. The one exempt write is the
 * workspace-document import (`workspace-store.ts`), which preserves the document
 * as-is (#1416: a restore must not fail on legacy data); the validated
 * look-through key still classifies such a row correctly.
 */
function normalizedIsinColumnValue(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const normalized = validIsinOrNull(trimmed);
  if (normalized === null) {
    throw new Error(
      `"${trimmed}" is not a valid ISIN (12 characters, ISO 6166 check digit) — refuse it or leave the column empty.`,
    );
  }
  return normalized;
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

  // #1512: the classification, and nothing that hangs off it. An investment
  // instrument declares no legacy AssetType (it persists through the investment
  // path), so `assets.type` stays as it is.
  if (input.instrument) {
    assetFields.instrument = input.instrument;
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
        isin: normalizedIsinColumnValue(input.isin),
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
  const normalized = normalizedIsinColumnValue(isin);
  const result = await ctx.db
    .update(investmentAssets)
    .set({ isin: normalized })
    .where(eq(investmentAssets.assetId, assetId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("backfill_investment_isin", "asset", assetId, {
      isin: normalized,
    });
  }

  return result.rowsAffected;
}

async function patchInvestmentIdentity(
  ctx: StoreContext,
  assetId: string,
  patch: InstrumentIdentityPatch & { priceProvider?: InvestmentPriceProvider },
): Promise<number> {
  const fields: Partial<typeof investmentAssets.$inferInsert> = {
    ...(patch.isin === undefined ? {} : { isin: normalizedIsinColumnValue(patch.isin) }),
    ...(patch.providerSymbol === undefined
      ? {}
      : { providerSymbol: patch.providerSymbol }),
    ...(patch.priceProvider === undefined ? {} : { priceProvider: patch.priceProvider }),
  };
  if (Object.keys(fields).length === 0) return 0;

  const result = await ctx.db
    .update(investmentAssets)
    .set(fields)
    .where(eq(investmentAssets.assetId, assetId))
    .run();

  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("patch_investment_identity", "asset", assetId, fields);
  }

  return result.rowsAffected;
}

async function softDeleteAsset(
  ctx: StoreContext,
  assetId: string,
  deletedAt: string,
  exit: TrashExit | null,
): Promise<SoftDeleteAssetOutcome> {
  const refusal = await checkAssetTrashGate(ctx, assetId, exit);
  if (refusal) {
    return { refusal, status: "refused" };
  }

  const result = await ctx.db
    .update(assets)
    .set({ deletedAt, trashExit: exit })
    .where(eq(assets.id, assetId))
    .run();
  if (result.rowsAffected === 0) {
    return { status: "not_found" };
  }

  await ctx.writeAuditEntry("delete_asset", "asset", assetId, { deletedAt, exit });
  return { status: "deleted" };
}

async function restoreAsset(ctx: StoreContext, assetId: string): Promise<number> {
  const result = await ctx.db
    .update(assets)
    // The exit goes with the deletion it explained: a live row left by nothing.
    .set({ deletedAt: null, trashExit: null })
    .where(and(eq(assets.id, assetId), isNotNull(assets.deletedAt)))
    .run();
  if (result.rowsAffected > 0) {
    await ctx.writeAuditEntry("restore_asset", "asset", assetId);
  }
  return result.rowsAffected;
}
