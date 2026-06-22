import type {
  CoinPosition,
  DebtBalanceCurveInputs,
  DebtModel,
  DecimalString,
  EarlyRepaymentMode,
  FrozenIdentityCapture,
  HousingCurveInputs,
  InvestmentOperation,
  Liability,
  ManualAsset,
  ManualValuePoint,
  SnapshotHoldingKind,
  ValuationCadence,
  Workspace,
} from "@worthline/domain";
import {
  isHousingAsset,
  listScopeOptions,
  selectInvestmentPrice,
} from "@worthline/domain";
import { asc, eq } from "drizzle-orm";

import { mapPositionRow } from "./connected-source-store";
import {
  amortizationPlans,
  assetOwnerships,
  assets,
  assetValuations,
  auditLog,
  connectedSources,
  earlyRepayments,
  interestRateRevisions,
  liabilities,
  liabilityBalanceAnchors,
  positions,
} from "./schema";
import { readSnapshotHoldings, type SnapshotHoldingRecord } from "./snapshot-store";
import {
  type StoreDb,
  readAllOperations,
  readAllPriceCache,
  readAssets,
  readInvestmentMeta,
  readLiabilities,
} from "./store-context";

// ── Historical snapshots (ADR 0012, PRD #107) ────────────────────────────────
//
// The shared historical-snapshot reconstruction substrate: the reader primitives
// that mine the live tables (assets, liabilities, operations, valuation/debt
// curves, coin positions, manual-value audit history, frozen identity captures)
// plus the `buildHistoricalSnapshotDeps` aggregator. The db-layer ripple/seam
// modules import from here rather than from `index.ts`, keeping the dependency
// graph acyclic (no sub-module ever imports runtime code from the monolith).

/**
 * A snapshot id minted by the historical backfill (ADR 0012) carries this
 * prefix (`histsnap_${scope}_${dateKey}`); a real daily capture is
 * `snapshot_${slug}_${seed}` (domain `buildSnapshotId`). A backfilled snapshot
 * exists on a date ONLY because a dated fact made it an event date, so it may be
 * pruned when nothing justifies its date any more (#305). A daily capture
 * records a day the app was opened — it must NEVER be pruned, even on an op-less
 * date — so the prune is gated strictly on this prefix.
 */
export const BACKFILL_SNAPSHOT_ID_PREFIX = "histsnap_";

/** Inputs shared by every historical-snapshot reconstruction for a workspace. */
export interface HistoricalSnapshotDeps {
  scopes: ReturnType<typeof listScopeOptions>;
  assets: ManualAsset[];
  liabilities: Liability[];
  operationsByAsset: Map<string, InvestmentOperation[]>;
  manualValueHistory: Map<string, ManualValuePoint[]>;
  /** Curve inputs (anchors + rate + current value) of every real-estate asset (PRD #108). */
  housingValuationByAsset: Map<string, HousingCurveInputs>;
  /** Debt-balance curve inputs of every liability with a debt model (PRD #109). */
  debtBalanceByLiability: Map<string, DebtBalanceCurveInputs>;
  /**
   * Positions of every connected coin-collection asset, keyed by the materialized
   * asset id (ADR 0017, #167). Lets fresh generation value a coin collection by
   * purchase-date accretion instead of its full current value.
   */
  coinPositionsByAsset: Map<string, CoinPosition[]>;
  /**
   * Investment asset ids with no provider/manual price — valued at COST BASIS in
   * fresh generation, mirroring live capture's ADR-0006 fallback, so a generated
   * snapshot never shows a units × last-operation-price figure it could not have
   * shown that day (#183).
   */
  costBasisAssetIds: Set<string>;
}

/**
 * The investment asset ids that currently have no provider/manual price — the
 * ones live capture values at cost basis (ADR 0006). Used so fresh historical
 * generation values them at cost basis too, not at the latest operation price
 * (#183). A priced investment is absent from the set and keeps its price-based
 * valuation. Historical reconstruction has no contemporaneous price store, so
 * "has a price today" is the only signal available — the same one live capture
 * reads through `selectInvestmentPrice`.
 */
async function readCostBasisAssetIds(
  db: StoreDb,
  assets: readonly ManualAsset[],
): Promise<Set<string>> {
  const ids = new Set<string>();
  const hasInvestments = assets.some((asset) => asset.type === "investment");
  if (!hasInvestments) return ids;

  const metaByAsset = await readInvestmentMeta(db);
  const priceCacheByAsset = await readAllPriceCache(db);

  for (const asset of assets) {
    if (asset.type !== "investment") continue;
    const selected = selectInvestmentPrice({
      cachedPrice: priceCacheByAsset.get(asset.id)?.price,
      manualPrice: metaByAsset.get(asset.id)?.manualPricePerUnit,
    });
    if (selected === undefined) ids.add(asset.id);
  }

  return ids;
}

export async function buildHistoricalSnapshotDeps(
  db: StoreDb,
  workspace: Workspace,
): Promise<HistoricalSnapshotDeps> {
  const reconstructedAssets = await readAssets(db, workspace);
  const reconstructedLiabilities = await readLiabilities(db, workspace);
  return {
    assets: reconstructedAssets,
    coinPositionsByAsset: await readCoinPositionsByAsset(db),
    costBasisAssetIds: await readCostBasisAssetIds(db, reconstructedAssets),
    debtBalanceByLiability: await readDebtBalanceInputs(db, reconstructedLiabilities),
    housingValuationByAsset: await readHousingCurveInputs(db, reconstructedAssets),
    liabilities: reconstructedLiabilities,
    manualValueHistory: await readManualValueHistory(db),
    operationsByAsset: await readAllOperations(db),
    scopes: listScopeOptions(workspace),
  };
}

/**
 * Positions of every connected coin-collection asset, keyed by the materialized
 * asset id (ADR 0017, #167). Used so fresh historical generation values a coin
 * collection by purchase-date accretion (Σ coinValue of coins acquired ≤ date)
 * rather than its full current value. Reads positions including those whose
 * source's asset was later trashed — the asset existed on the snapshot dates.
 */
async function readCoinPositionsByAsset(
  db: StoreDb,
): Promise<Map<string, CoinPosition[]>> {
  const byAsset = new Map<string, CoinPosition[]>();
  const assetBySource = new Map<string, string>();
  const sourceRows = await db
    .select({ id: connectedSources.id, assetId: connectedSources.assetId })
    .from(connectedSources)
    .all();
  for (const source of sourceRows) {
    assetBySource.set(source.id, source.assetId);
  }
  if (assetBySource.size === 0) return byAsset;

  const positionRows = await db.select().from(positions).all();
  for (const row of positionRows) {
    const assetId = assetBySource.get(row.sourceId);
    if (assetId === undefined) continue;
    // Purchase-date accretion is a coin-only history path (ADR 0017); a Binance
    // token's history is the monthly builder (ADR 0021, S5), not this map.
    const position = mapPositionRow(row);
    if (position.kind !== "coin") continue;
    const list = byAsset.get(assetId) ?? [];
    list.push(position);
    byAsset.set(assetId, list);
  }
  return byAsset;
}

/**
 * Read the housing valuation curve inputs for every live real-estate asset
 * (PRD #108): its anchors, its annual appreciation rate, and its current value.
 * Keyed by asset id; only housing assets are included, and the domain decides
 * (via the anchors/rate presence) whether to value from the curve or fall back
 * to the last-known-value basis. `currentValue` comes from the already-read
 * assets so the curve uses the same value the live read derived.
 */
async function readHousingCurveInputs(
  db: StoreDb,
  liveAssets: readonly ManualAsset[],
): Promise<Map<string, HousingCurveInputs>> {
  const housingAssets = liveAssets.filter((asset) => isHousingAsset(asset));
  const inputs = new Map<string, HousingCurveInputs>();
  if (housingAssets.length === 0) return inputs;

  const valuationRows = await db.select().from(assetValuations).all();
  const anchorsByAsset = new Map<string, HousingCurveInputs["anchors"][number][]>();
  for (const row of valuationRows) {
    const list = anchorsByAsset.get(row.assetId) ?? [];
    list.push({
      adjustsPriorCurve: row.adjustsPriorCurve === 1,
      valuationDate: row.valuationDate,
      valueMinor: row.valueMinor,
    });
    anchorsByAsset.set(row.assetId, list);
  }

  const rateRows = await db
    .select({
      id: assets.id,
      rate: assets.annualAppreciationRate,
      valuationCadence: assets.valuationCadence,
    })
    .from(assets)
    .all();
  const rateByAsset = new Map<string, DecimalString | null>();
  const cadenceByAsset = new Map<string, ValuationCadence | null>();
  for (const row of rateRows) {
    rateByAsset.set(row.id, row.rate);
    cadenceByAsset.set(row.id, row.valuationCadence ?? null);
  }

  for (const asset of housingAssets) {
    // The stored cadence (ADR 0031, #394); null reads as the default `step` in
    // the engine. Threaded into the appreciating curve input.
    const cadence = cadenceByAsset.get(asset.id) ?? undefined;
    inputs.set(asset.id, {
      anchors: anchorsByAsset.get(asset.id) ?? [],
      annualAppreciationRate: rateByAsset.get(asset.id) ?? null,
      currentValueMinor: asset.currentValue.amountMinor,
      ...(cadence != null ? { cadence } : {}),
    });
  }

  return inputs;
}

/**
 * Read the debt-balance curve inputs for every live liability that carries a
 * debt model (PRD #109): its model, its balance anchors (revolving/informal),
 * its amortization plan + rate revisions (amortizable), and its current balance.
 * Keyed by liability id; only liabilities with a non-null model are included, so
 * a liability without a model keeps the last-known-value basis (no regression).
 * `currentBalance` comes from the already-read liabilities so the curve uses the
 * same fallback the live read derived.
 */
async function readDebtBalanceInputs(
  db: StoreDb,
  liveLiabilities: readonly Liability[],
): Promise<Map<string, DebtBalanceCurveInputs>> {
  const inputs = new Map<string, DebtBalanceCurveInputs>();
  if (liveLiabilities.length === 0) return inputs;

  const modelRows = await db
    .select({
      id: liabilities.id,
      debtModel: liabilities.debtModel,
      valuationCadence: liabilities.valuationCadence,
    })
    .from(liabilities)
    .all();
  const modelById = new Map<string, DebtModel | null>();
  const cadenceById = new Map<string, ValuationCadence | null>();
  for (const row of modelRows) {
    modelById.set(row.id, row.debtModel ?? null);
    cadenceById.set(row.id, row.valuationCadence ?? null);
  }

  // Anchors (revolving/informal), grouped by liability.
  const anchorRows = await db.select().from(liabilityBalanceAnchors).all();
  const anchorsByLiability = new Map<
    string,
    { anchorDate: string; balanceMinor: number }[]
  >();
  for (const row of anchorRows) {
    const list = anchorsByLiability.get(row.liabilityId) ?? [];
    list.push({ anchorDate: row.anchorDate, balanceMinor: row.balanceMinor });
    anchorsByLiability.set(row.liabilityId, list);
  }

  // Amortization plans, keyed by liability, plus revisions keyed by plan id.
  const planRows = await db.select().from(amortizationPlans).all();
  const planByLiability = new Map<string, (typeof planRows)[number]>();
  for (const row of planRows) planByLiability.set(row.liabilityId, row);

  const revisionRows = await db.select().from(interestRateRevisions).all();
  const revisionsByPlan = new Map<
    string,
    { revisionDate: string; newAnnualInterestRate: DecimalString }[]
  >();
  for (const row of revisionRows) {
    const list = revisionsByPlan.get(row.planId) ?? [];
    list.push({
      newAnnualInterestRate: row.newAnnualInterestRate,
      revisionDate: row.revisionDate,
    });
    revisionsByPlan.set(row.planId, list);
  }

  const repaymentRows = await db.select().from(earlyRepayments).all();
  const repaymentsByPlan = new Map<
    string,
    { repaymentDate: string; amountMinor: number; mode: EarlyRepaymentMode }[]
  >();
  for (const row of repaymentRows) {
    const list = repaymentsByPlan.get(row.planId) ?? [];
    list.push({
      amountMinor: row.amountMinor,
      mode: row.mode,
      repaymentDate: row.repaymentDate,
    });
    repaymentsByPlan.set(row.planId, list);
  }

  for (const liability of liveLiabilities) {
    const debtModel = modelById.get(liability.id) ?? null;
    if (debtModel === null) continue; // no model → last-known-value basis

    const currentBalanceMinor = liability.currentBalance.amountMinor;
    // The stored cadence (ADR 0031, #393); null reads as the default `step` in
    // the engine. Threaded into both the amortizable and anchored curve inputs.
    const cadence = cadenceById.get(liability.id) ?? undefined;

    if (debtModel === "amortizable") {
      const plan = planByLiability.get(liability.id);
      inputs.set(liability.id, {
        currentBalanceMinor,
        debtModel,
        ...(cadence != null ? { cadence } : {}),
        ...(plan
          ? {
              earlyRepayments: repaymentsByPlan.get(plan.id) ?? [],
              plan: {
                annualInterestRate: plan.annualInterestRate,
                disbursementDate: plan.disbursementDate,
                firstPaymentDate: plan.firstPaymentDate,
                initialCapitalMinor: plan.initialCapitalMinor,
                termMonths: plan.termMonths,
              },
              revisions: revisionsByPlan.get(plan.id) ?? [],
            }
          : {}),
      });
      continue;
    }

    inputs.set(liability.id, {
      anchors: anchorsByLiability.get(liability.id) ?? [],
      currentBalanceMinor,
      ...(cadence != null ? { cadence } : {}),
      debtModel,
    });
  }

  return inputs;
}

/**
 * Reconstruct the audit history of manual values/balances, keyed by holding id.
 *
 * The "last known value" basis for cash/housing/debts in a historical snapshot
 * (PRD #107): each `update_valuation` / `update_balance` audit entry is a dated
 * value point. The entry's `created_at` date is when the value became known.
 */
async function readManualValueHistory(
  db: StoreDb,
): Promise<Map<string, ManualValuePoint[]>> {
  const rows = await db.select().from(auditLog).orderBy(asc(auditLog.createdAt)).all();

  const history = new Map<string, ManualValuePoint[]>();

  for (const row of rows) {
    if (row.action !== "update_valuation" && row.action !== "update_balance") {
      continue;
    }

    let details: Record<string, unknown>;
    try {
      details = JSON.parse(row.detailsJson) as Record<string, unknown>;
    } catch {
      continue; // a single malformed audit row must not abort the whole ripple
    }
    const value =
      row.action === "update_valuation"
        ? details["currentValueMinor"]
        : details["balanceMinor"];

    if (typeof value !== "number") continue;

    const dateKey = (row.createdAt ?? "").slice(0, 10);
    if (!dateKey) continue;

    const points = history.get(row.entityId) ?? [];
    points.push({ dateKey, valueMinor: value });
    history.set(row.entityId, points);
  }

  return history;
}

/**
 * Group a scope's batched frozen-holding read by snapshot date (#205). The input
 * is the result of a single `readSnapshotHoldings({ scopeId, from })` call —
 * already ordered (dateKey, scopeId, kind, label, holdingId) — so iterating it in
 * order and appending into each date's bucket preserves, per date, the exact row
 * order the old one-query-per-snapshot read produced. The ripple then looks each
 * snapshot's rows up by date instead of re-querying the store for every snapshot.
 */
export function groupFrozenHoldingsByDate(
  records: readonly SnapshotHoldingRecord[],
): Map<string, SnapshotHoldingRecord[]> {
  const byDate = new Map<string, SnapshotHoldingRecord[]>();
  for (const record of records) {
    const bucket = byDate.get(record.dateKey);
    if (bucket) {
      bucket.push(record);
    } else {
      byDate.set(record.dateKey, [record]);
    }
  }
  return byDate;
}

/**
 * Read ONE holding's frozen classification captures across every existing
 * snapshot (#242) — the basis the domain's frozen-vs-live seam recovers a
 * holding's CONTEMPORANEOUS tier / housing-ness from when a ripple must generate
 * a brand-new row at a date/scope that never carried one. Uses the targeted
 * `(holding_id, kind)` index read (#207) so it never scans the whole table, and
 * collapses to one capture per dateKey (a holding's classification is frozen
 * identically across the scopes captured on a date until a reclassification, so
 * the first row seen for a date is representative). Empty when the holding has
 * never been captured — the seam then falls back to live (no recovery basis).
 */
export async function readFrozenIdentityCaptures(
  db: StoreDb,
  holdingId: string,
  kind: SnapshotHoldingKind,
): Promise<FrozenIdentityCapture[]> {
  const byDate = new Map<string, FrozenIdentityCapture>();
  for (const record of await readSnapshotHoldings(db, { holdingId, kind })) {
    if (byDate.has(record.dateKey)) continue;
    byDate.set(record.dateKey, {
      countsAsHousing: record.countsAsHousing,
      dateKey: record.dateKey,
      liquidityTier: record.liquidityTier,
      securesHousing: record.securesHousing,
    });
  }
  return [...byDate.values()];
}

/**
 * Read one investment asset's identity (ownership, currency, tier, name),
 * including trashed assets — historical reconstruction needs the identity of
 * holdings that existed on past dates even if they were trashed since.
 */
export async function readInvestmentIdentity(
  db: StoreDb,
  assetId: string,
): Promise<ManualAsset | null> {
  const row = await db
    .select({
      id: assets.id,
      name: assets.name,
      type: assets.type,
      currency: assets.currency,
      liquidityTier: assets.liquidityTier,
      isPrimaryResidence: assets.isPrimaryResidence,
      instrument: assets.instrument,
    })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();

  if (!row) return null;

  const ownership = await db
    .select({ memberId: assetOwnerships.memberId, shareBps: assetOwnerships.shareBps })
    .from(assetOwnerships)
    .where(eq(assetOwnerships.assetId, assetId))
    .all();

  return {
    currency: row.currency,
    currentValue: { amountMinor: 0, currency: row.currency },
    id: row.id,
    isPrimaryResidence: row.isPrimaryResidence === 1,
    liquidityTier: row.liquidityTier,
    name: row.name,
    ownership,
    type: row.type,
    ...(row.instrument ? { instrument: row.instrument } : {}),
  };
}
