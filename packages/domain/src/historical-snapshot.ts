/**
 * Historical snapshot reconstruction (ADR 0012, PRD #107).
 *
 * Pure module: given the current holdings' identities, the full operation
 * ledger, the audit history of manual values, and a target past date, it
 * reconstructs the valued portfolio *as it was* on that date and produces a
 * snapshot for it.
 *
 * Resolution rules (PRD #107):
 * - Investment with an operation on or before the date: position folded to
 *   that date (units), valued at the last known unit price ≤ date. An
 *   investment with no operation on or before the date did not exist yet and
 *   is omitted. A position fully sold by the date (zero units) is also omitted.
 * - Manual holdings (cash, housing, debts): the last known value ≤ date from
 *   the audit history, falling back to the holding's current value when no
 *   history reaches that far back (an accepted approximation).
 *
 * The actual snapshot + holding rows are produced by the existing
 * `captureValuedNetWorthSnapshot`, so the reconciliation invariant (ADR 0008)
 * and the five headline figures stay identical to the daily-capture path.
 */

import { isHousing, isLiquid, tierOfAsset } from "./classification";
import type { DecimalString } from "./decimal";
import { compareUnits } from "./decimal";
import type {
  InvestmentOperation,
  Liability,
  ManualAsset,
  NetWorthSnapshot,
  Workspace,
} from "./index";
import {
  assertSnapshotHoldingsReconcile,
  captureValuedNetWorthSnapshot,
  createNetWorthSnapshot,
  type ValuedNetWorthSnapshot,
} from "./index";
import { money } from "./money";
import { derivePosition } from "./positions";
import { resolveScopeMemberIds } from "./scope";
import { allocateScopedHolding } from "./scope-allocation";
import type { InvestmentCaptureDetail, SnapshotHoldingRow } from "./snapshot-holdings";

/** One declared value of a manual holding on a date, from the audit history. */
export interface ManualValuePoint {
  /** YYYY-MM-DD the value applies from. */
  dateKey: string;
  valueMinor: number;
}

export interface BuildSnapshotAtDateInput {
  workspace: Workspace;
  scopeId: string;
  scopeLabel: string;
  /** Current asset identities (type, ownership, tier, currency, name). */
  assets: ManualAsset[];
  /** Current liability identities. */
  liabilities: Liability[];
  /** Every operation, keyed by asset id. */
  operationsByAsset: ReadonlyMap<string, InvestmentOperation[]>;
  /** Audit history of manual values/balances, keyed by holding id (sorted asc by date). */
  manualValueHistory: ReadonlyMap<string, ManualValuePoint[]>;
  /** Target date as YYYY-MM-DD. */
  targetDate: string;
  /** ISO timestamp to stamp the snapshot's capturedAt (its dateKey must equal targetDate). */
  capturedAt: string;
  /** The snapshot id to assign. */
  id: string;
  /**
   * Unit prices already captured per asset id in an existing snapshot for this
   * date. Provided on ripple recalculation so an existing snapshot keeps the
   * best price it knew that day (ADR 0012); omitted when generating fresh.
   */
  capturedUnitPrices?: ReadonlyMap<string, DecimalString>;
}

/** The most recent value with dateKey ≤ target, or undefined if none reaches back. */
export function lastKnownValueAtDate(
  points: readonly ManualValuePoint[] | undefined,
  targetDate: string,
): number | undefined {
  if (!points || points.length === 0) return undefined;

  let resolved: number | undefined;
  for (const point of points) {
    if (point.dateKey <= targetDate) {
      resolved = point.valueMinor;
    }
  }
  return resolved;
}

/** The unit price of the latest operation on or before the date. */
function latestOperationPrice(
  operations: readonly InvestmentOperation[],
): DecimalString | undefined {
  let latest: InvestmentOperation | undefined;
  for (const operation of operations) {
    if (
      !latest ||
      operation.executedAt > latest.executedAt ||
      (operation.executedAt === latest.executedAt && operation.id > latest.id)
    ) {
      latest = operation;
    }
  }
  return latest?.pricePerUnit;
}

/** Operations whose executedAt date falls on or before the target date. */
function operationsUpTo(
  operations: readonly InvestmentOperation[] | undefined,
  targetDate: string,
): InvestmentOperation[] {
  if (!operations) return [];
  return operations.filter((operation) => operation.executedAt.slice(0, 10) <= targetDate);
}

/**
 * Reconstruct and capture the snapshot for one scope on a past date.
 *
 * Returns null when the portfolio had no holdings at all on that date (nothing
 * to capture) — callers skip persisting in that case.
 */
export function buildSnapshotAtDate(
  input: BuildSnapshotAtDateInput,
): ValuedNetWorthSnapshot | null {
  if (input.capturedAt.slice(0, 10) !== input.targetDate) {
    throw new Error(
      `Historical snapshot capturedAt (${input.capturedAt}) must fall on its ` +
        `target date (${input.targetDate}).`,
    );
  }

  const historicalAssets: ManualAsset[] = [];
  const investmentDetails = new Map<string, InvestmentCaptureDetail>();

  for (const asset of input.assets) {
    if (asset.type === "investment") {
      const ops = operationsUpTo(input.operationsByAsset.get(asset.id), input.targetDate);
      if (ops.length === 0) continue; // did not exist yet

      const price =
        input.capturedUnitPrices?.get(asset.id) ?? latestOperationPrice(ops);

      const position = derivePosition(ops, {
        assetId: asset.id,
        currency: asset.currency,
        ...(price !== undefined ? { currentPricePerUnit: price } : {}),
      });

      // Fully sold (or never accumulated) by this date — not held, omit.
      if (compareUnits(position.currentUnits, "0") === 0) continue;

      const value = position.marketValue ?? position.costBasis;
      historicalAssets.push({ ...asset, currentValue: value });
      investmentDetails.set(asset.id, {
        units: position.currentUnits,
        ...(price !== undefined ? { unitPrice: price } : {}),
      });
      continue;
    }

    const known = lastKnownValueAtDate(
      input.manualValueHistory.get(asset.id),
      input.targetDate,
    );
    historicalAssets.push(
      known !== undefined
        ? { ...asset, currentValue: money(known, asset.currency) }
        : asset,
    );
  }

  const historicalLiabilities: Liability[] = input.liabilities.map((liability) => {
    const known = lastKnownValueAtDate(
      input.manualValueHistory.get(liability.id),
      input.targetDate,
    );
    return known !== undefined
      ? { ...liability, currentBalance: money(known, liability.currency) }
      : liability;
  });

  if (historicalAssets.length === 0 && historicalLiabilities.length === 0) {
    return null;
  }

  return captureValuedNetWorthSnapshot({
    assets: historicalAssets,
    capturedAt: input.capturedAt,
    id: input.id,
    investmentDetails,
    liabilities: historicalLiabilities,
    scopeId: input.scopeId,
    scopeLabel: input.scopeLabel,
    workspace: input.workspace,
  });
}

/** A YYYY-MM-DD ISO timestamp at noon UTC — stamps a generated snapshot's capturedAt. */
export function historicalCapturedAt(dateKey: string): string {
  return `${dateKey}T12:00:00.000Z`;
}

export interface RecalculateSnapshotInput {
  /** The existing snapshot to recalculate (its id, scope, date, capturedAt are preserved). */
  snapshot: NetWorthSnapshot;
  /** The snapshot's currently frozen holding rows. */
  frozenHoldings: SnapshotHoldingRow[];
  /** The identity of the single investment whose operations changed. */
  asset: ManualAsset;
  workspace: Workspace;
  /** Every operation for that asset. */
  operations: InvestmentOperation[];
}

/**
 * Recalculate an existing snapshot after one investment's operations changed
 * (ADR 0012 ripple). Only that asset's row is recomputed — every other frozen
 * row (manual holdings, liabilities, other investments, and holdings later
 * renamed, re-valued, or trashed) is preserved verbatim, so a ripple never
 * rewrites history it should not touch. The asset keeps the unit price the
 * snapshot already captured; a newly-appearing asset uses the last operation
 * price ≤ the snapshot's date. Its label and tier stay frozen if the asset was
 * already in the snapshot.
 *
 * Returns null when no holdings remain (the caller deletes the snapshot rather
 * than leaving it showing values derived from a now-deleted operation).
 */
export function recalculateSnapshotForAsset(
  input: RecalculateSnapshotInput,
): ValuedNetWorthSnapshot | null {
  const targetDate = input.snapshot.dateKey;
  const currency = input.workspace.baseCurrency;
  const scopeMemberIds = new Set(
    resolveScopeMemberIds(input.workspace, input.snapshot.scopeId),
  );

  const existingRow = input.frozenHoldings.find(
    (row) => row.holdingId === input.asset.id && row.kind === "asset",
  );
  const rows = input.frozenHoldings.filter((row) => row.holdingId !== input.asset.id);

  const ops = operationsUpTo(input.operations, targetDate);
  if (ops.length > 0) {
    const price = existingRow?.unitPrice ?? latestOperationPrice(ops);
    const position = derivePosition(ops, {
      assetId: input.asset.id,
      currency: input.asset.currency,
      ...(price !== undefined ? { currentPricePerUnit: price } : {}),
    });

    if (compareUnits(position.currentUnits, "0") !== 0) {
      const fullValueMinor = (position.marketValue ?? position.costBasis).amountMinor;
      const { ownedMinor, totalShareBps } = allocateScopedHolding(fullValueMinor, {
        ownership: input.asset.ownership,
        scopeMemberIds,
      });

      if (totalShareBps > 0) {
        rows.push({
          holdingId: input.asset.id,
          kind: "asset",
          label: existingRow?.label ?? input.asset.name,
          liquidityTier: existingRow?.liquidityTier ?? tierOfAsset(input.asset),
          units: position.currentUnits,
          valueMinor: ownedMinor,
          ...(price !== undefined ? { unitPrice: price } : {}),
        });
      }
    }
  }

  if (rows.length === 0) return null;

  const summary = summarizeHoldingRows(rows, currency);
  const snapshot = createNetWorthSnapshot({
    capturedAt: input.snapshot.capturedAt,
    id: input.snapshot.id,
    isMonthlyClose: input.snapshot.isMonthlyClose,
    scopeId: input.snapshot.scopeId,
    scopeLabel: input.snapshot.scopeLabel,
    summary,
    warnings: input.snapshot.warnings,
  });

  assertSnapshotHoldingsReconcile(rows, {
    debtsMinor: summary.debts.amountMinor,
    grossAssetsMinor: summary.grossAssets.amountMinor,
  });

  return { holdings: rows, snapshot };
}

/**
 * The five headline figures derived from already-scope-weighted holding rows,
 * mirroring `calculateNetWorth` exactly (gross/debts, liquid = cash+market net
 * of liquid debts, housing equity = housing assets net of housing debts).
 */
function summarizeHoldingRows(
  rows: readonly SnapshotHoldingRow[],
  currency: string,
) {
  let grossAssets = 0;
  let liquidAssets = 0;
  let housingAssets = 0;
  let debts = 0;
  let liquidDebts = 0;
  let housingDebts = 0;

  for (const row of rows) {
    if (row.kind === "asset") {
      grossAssets += row.valueMinor;
      if (row.liquidityTier && isLiquid(row.liquidityTier)) liquidAssets += row.valueMinor;
      if (row.liquidityTier === "housing") housingAssets += row.valueMinor;
    } else {
      debts += row.valueMinor;
      if (row.liquidityTier && isHousing(row.liquidityTier)) {
        housingDebts += row.valueMinor;
      } else if (row.liquidityTier && isLiquid(row.liquidityTier)) {
        liquidDebts += row.valueMinor;
      }
    }
  }

  return {
    debts: money(debts, currency),
    grossAssets: money(grossAssets, currency),
    housingEquity: money(housingAssets - housingDebts, currency),
    liquidNetWorth: money(liquidAssets - liquidDebts, currency),
    scopeId: "",
    totalNetWorth: money(grossAssets - debts, currency),
  };
}
