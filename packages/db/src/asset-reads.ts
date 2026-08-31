/**
 * Shared asset-domain reads — the raw supporting reads for asset valuation, the
 * live-asset projection, its contribution-lot grouping, and the asset hard
 * delete. Split out of `store-context.ts` (#1701): whoever reads where a
 * `ManualAsset` comes from should land in a file that says so, not in the
 * connection/transaction/audit substrate every slice imports.
 */
import type {
  AssetProjectionContext,
  ContributionLot,
  DecimalString,
  ManualAsset,
  RawAssetRow,
  Workspace,
} from "@worthline/domain";
import { projectAssets } from "@worthline/domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  readAllOperations,
  readAllPriceCache,
  readInvestmentMeta,
} from "./operation-reads";
import { readAssetOwnerships } from "./ownership-reads";
import {
  agentViewPublicIds,
  assetOperations,
  assetOwnerships,
  assets,
  contributionLots,
  warningOverrides,
} from "./schema";
import type { StoreContext, StoreDb } from "./store-context";

/**
 * Build the shared supporting reads (ownership, operations, manual + cached prices)
 * that the domain projection needs to value investments. The store layer stays
 * shallow — it gathers raw rows and the domain owns the composition (PRD #120
 * candidate 3, R10). The investment-only reads are skipped entirely when there
 * are no investments to value.
 *
 * Shared by readAssets (R2) and readPositions (R1), so the raw-read shape never
 * drifts between them.
 */
export async function buildAssetProjectionContext(
  db: StoreDb,
  hasInvestments: boolean,
): Promise<AssetProjectionContext> {
  // All four reads are independent — fire them in parallel. The investment-only
  // reads resolve to empty maps immediately when there are no investments; the
  // ownership read is always needed and runs concurrently with the others.
  const emptyOperationsMap: Awaited<ReturnType<typeof readAllOperations>> = new Map();
  const emptyMetaMap: Awaited<ReturnType<typeof readInvestmentMeta>> = new Map();
  const emptyCacheMap: Awaited<ReturnType<typeof readAllPriceCache>> = new Map();

  const [operationsByAsset, metaByAsset, priceCacheByAsset, ownershipByAsset] =
    await Promise.all([
      hasInvestments ? readAllOperations(db) : Promise.resolve(emptyOperationsMap),
      hasInvestments ? readInvestmentMeta(db) : Promise.resolve(emptyMetaMap),
      hasInvestments ? readAllPriceCache(db) : Promise.resolve(emptyCacheMap),
      readAssetOwnerships(db),
    ]);

  const manualPriceByAsset = new Map<string, DecimalString | undefined>();
  const providerSymbolByAsset = new Map<string, string | undefined>();
  const isinByAsset = new Map<string, string | undefined>();
  for (const [assetId, meta] of metaByAsset) {
    manualPriceByAsset.set(assetId, meta.manualPricePerUnit);
    providerSymbolByAsset.set(assetId, meta.providerSymbol);
    isinByAsset.set(assetId, meta.isin);
  }

  const cachedPriceByAsset = new Map<string, DecimalString | undefined>();
  for (const [assetId, cached] of priceCacheByAsset) {
    cachedPriceByAsset.set(assetId, cached.price);
  }

  return {
    cachedPriceByAsset,
    isinByAsset,
    manualPriceByAsset,
    operationsByAsset,
    ownershipByAsset,
    providerSymbolByAsset,
  };
}

/**
 * Agrupar filas de `contribution_lots` por holding (#1676), conservando el orden en
 * que llegan. Vive aquí y se exporta porque el documento de workspace hace el MISMO
 * pliegue al exportar: dos copias de esta forma se separan en cuanto una se toca, y lo
 * que se separaría es qué lotes lleva un holding.
 */
export function groupContributionLotsByAsset(
  rows: readonly { assetId: string; availableFrom: string; amountMinor: number }[],
): Map<string, ContributionLot[]> {
  const byAssetId = new Map<string, ContributionLot[]>();
  for (const row of rows) {
    const entry = { amountMinor: row.amountMinor, availableFrom: row.availableFrom };
    const existing = byAssetId.get(row.assetId);
    if (existing) {
      existing.push(entry);
    } else {
      byAssetId.set(row.assetId, [entry]);
    }
  }
  return byAssetId;
}

/**
 * Read every live (non-trashed) asset as a domain ManualAsset. The store reads
 * raw rows and the raw supporting maps, then hands them to the domain projection
 * (projectAssets), which owns the units × price valuation (ADR 0006) and the
 * ManualAsset reconstitution. Shared by the AssetStore (R2) and the monolith's
 * historical-snapshot reconstruction, so it lives here — the one shared-concerns
 * home — rather than being duplicated across the slices.
 *
 * @param projectionContext - Optional pre-built projection context. When
 *   provided, the internal build (and the hasInvestments gate that drives it) is
 *   skipped entirely and the supplied context is used directly. The caller is
 *   responsible for ensuring the context was built after any writes to the four
 *   underlying tables (operations, investment meta, price cache, ownerships).
 *   Safety invariant for the dashboard load path: the only write to those tables
 *   in a cold load is `upsertPrice` in §1, which runs before both projection
 *   builds, so a single shared context is byte-identical to two separate builds
 *   (dedup #566).
 */
export async function readAssets(
  db: StoreDb,
  workspace: Workspace | null,
  projectionContext?: AssetProjectionContext,
): Promise<ManualAsset[]> {
  if (!workspace) {
    return [];
  }

  const rows = await db
    .select({
      availableFrom: assets.availableFrom,
      connectedSourceId: assets.connectedSourceId,
      currency: assets.currency,
      currentValueMinor: assets.currentValueMinor,
      id: assets.id,
      instrument: assets.instrument,
      isPrimaryResidence: assets.isPrimaryResidence,
      liquidityTier: assets.liquidityTier,
      name: assets.name,
      type: assets.type,
    })
    .from(assets)
    .where(isNull(assets.deletedAt))
    .orderBy(asc(assets.createdAt), asc(assets.id))
    .all();

  // Los lotes de aportación (#1676) en UNA consulta para todos los holdings, no una
  // por fila: la escalera de un plan es una lista corta, pero un `readAssets` puede
  // traer cientos de holdings y una consulta por cada uno es la forma de avería que
  // #1295 dejó en la navegación. Solo los tiene el escalón a plazo, así que para casi
  // toda cartera el mapa sale vacío.
  //
  // Y solo se lanza si el workspace TIENE algún holding a plazo, el mismo gate con el
  // que este módulo evita el contexto de inversiones más abajo: la escalera es una
  // superficie de nicho y casi ninguna cartera paga por preguntarlo.
  const hasTermLocked = rows.some((row) => row.liquidityTier === "term-locked");
  const lotRows = hasTermLocked
    ? await db
        .select({
          amountMinor: contributionLots.amountMinor,
          assetId: contributionLots.assetId,
          availableFrom: contributionLots.availableFrom,
        })
        .from(contributionLots)
        .orderBy(asc(contributionLots.assetId), asc(contributionLots.availableFrom))
        .all()
    : [];

  const lotsByAssetId = groupContributionLotsByAsset(lotRows);

  const rawRows: RawAssetRow[] = rows.map((row) => {
    const lots = lotsByAssetId.get(row.id);
    return {
      availableFrom: row.availableFrom,
      ...(lots === undefined ? {} : { contributionLots: lots }),
      connectedSourceId: row.connectedSourceId,
      currency: row.currency,
      currentValueMinor: row.currentValueMinor,
      id: row.id,
      instrument: row.instrument,
      isPrimaryResidence: row.isPrimaryResidence === 1,
      liquidityTier: row.liquidityTier,
      name: row.name,
      type: row.type,
    };
  });

  const ctx =
    projectionContext ??
    (await buildAssetProjectionContext(
      db,
      rawRows.some((row) => row.type === "investment"),
    ));

  return projectAssets(workspace, rawRows, ctx);
}

/**
 * Hard-delete one trashed asset in the caller's transaction. Captures the
 * entity's key data for the audit trail BEFORE destroying it; FK cascades take
 * ownerships, investment metadata, operations, and the price cache, and we clear
 * the warning overrides by hand (no FK points at them). Frozen snapshot_holdings
 * are intentionally never touched (ADR 0008): history stays intact, so the
 * holding keeps appearing in past captures. Returns the number of asset rows
 * removed (0 when the id is unknown or not in the trash).
 *
 * Shared here because both the AssetStore (R2, via hardDeleteAsset) and the
 * monolith's emptyTrash run it — so the trash-delete semantics can never drift.
 */
export async function hardDeleteAssetTx(
  ctx: StoreContext,
  assetId: string,
): Promise<number> {
  const { db } = ctx;
  const row = await db
    .select({ name: assets.name, type: assets.type, deletedAt: assets.deletedAt })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  // Hard delete is reachable only from the trash: refuse a live holding.
  if (!row || row.deletedAt === null) {
    return 0;
  }

  const ownership = await db
    .select({ memberId: assetOwnerships.memberId, shareBps: assetOwnerships.shareBps })
    .from(assetOwnerships)
    .where(eq(assetOwnerships.assetId, assetId))
    .all();
  const operations =
    row.type === "investment"
      ? await db
          .select({
            id: assetOperations.id,
            kind: assetOperations.kind,
            executedAt: assetOperations.executedAt,
            units: assetOperations.units,
            pricePerUnit: assetOperations.pricePerUnit,
            currency: assetOperations.currency,
            feesMinor: assetOperations.feesMinor,
            source: assetOperations.source,
          })
          .from(assetOperations)
          .where(eq(assetOperations.assetId, assetId))
          .all()
      : [];

  // No FK points at the warning overrides, so clear them by hand; the asset
  // row's FK cascades take ownerships, investment metadata, operations, and
  // the price cache. Frozen snapshot_holdings are intentionally never touched
  // (ADR 0008).
  await db.delete(warningOverrides).where(eq(warningOverrides.entityId, assetId)).run();
  // Drop the holding's agent-view public id on HARD delete only (#335); a
  // soft-delete/trash keeps it so a restore stays stable.
  await db
    .delete(agentViewPublicIds)
    .where(
      and(
        eq(agentViewPublicIds.entityType, "holding"),
        eq(agentViewPublicIds.entityId, assetId),
      ),
    )
    .run();
  const result = await db.delete(assets).where(eq(assets.id, assetId)).run();

  await ctx.writeAuditEntry("hard_delete_asset", "asset", assetId, {
    name: row.name,
    operations,
    ownership,
    type: row.type,
  });

  return result.rowsAffected;
}
