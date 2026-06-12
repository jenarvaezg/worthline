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

import type { DecimalString } from "./decimal";
import type { InvestmentOperation, Liability, ManualAsset, Workspace } from "./index";
import { captureValuedNetWorthSnapshot, type ValuedNetWorthSnapshot } from "./index";
import { money } from "./money";
import { derivePosition } from "./positions";
import type { InvestmentCaptureDetail } from "./snapshot-holdings";

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
      if (position.currentUnits === "0" || position.currentUnits === "0.0") continue;

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
