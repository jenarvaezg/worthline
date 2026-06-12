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

import { isHousing, isHousingAsset, isLiquid, tierOfAsset } from "./classification";
import type { DecimalString } from "./decimal";
import { compareUnits } from "./decimal";
import type { HousingValuationAnchor } from "./housing-valuation";
import { valueHousingAtDate } from "./housing-valuation";
import type { InvestmentOperation } from "./investment-types";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";
import type { NetWorthSnapshot, ValuedNetWorthSnapshot } from "./snapshot-types";
import {
  captureValuedNetWorthSnapshot,
  createNetWorthSnapshot,
} from "./snapshot-types";
import { assertSnapshotHoldingsReconcile } from "./snapshot-holdings";
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

/**
 * The curve inputs of one real-estate asset (PRD #108): its valuation anchors,
 * its annual appreciation rate, and its current stored value. When an asset has
 * an entry here AND at least an anchor or a rate, historical reconstruction
 * values it on the snapshot's date via the pure housing curve instead of the
 * manual last-known-value basis.
 */
export interface HousingCurveInputs {
  anchors: readonly HousingValuationAnchor[];
  annualAppreciationRate?: DecimalString | null;
  currentValueMinor: number;
}

/**
 * True when an asset is a housing holding (real_estate / primary residence /
 * housing tier) AND carries a curve worth evaluating — at least one anchor or a
 * declared rate. A housing asset with neither falls back to the last-known-value
 * basis (no regression for assets without anchors, PRD #108).
 */
function hasHousingCurve(
  asset: ManualAsset,
  curve: HousingCurveInputs | undefined,
): curve is HousingCurveInputs {
  if (!curve || !isHousingAsset(asset)) return false;
  return (
    curve.anchors.length > 0 ||
    (curve.annualAppreciationRate != null && curve.annualAppreciationRate !== "")
  );
}

/** Resolve a housing asset's curve value on the target date, in minor units. */
function housingCurveValueMinor(
  curve: HousingCurveInputs,
  targetDate: string,
  today: string,
): number {
  return valueHousingAtDate({
    anchors: curve.anchors,
    annualAppreciationRate: curve.annualAppreciationRate ?? null,
    currentValueMinor: curve.currentValueMinor,
    targetDate,
    today,
  });
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
  /**
   * Curve inputs of every real-estate asset, keyed by asset id (PRD #108). A
   * housing asset present here with an anchor or a rate is valued via the pure
   * housing curve on the target date; one absent (or with neither) keeps the
   * manual last-known-value basis (no regression).
   */
  housingValuationByAsset?: ReadonlyMap<string, HousingCurveInputs>;
  /**
   * "Today" as YYYY-MM-DD — forwarded to the housing curve for forward
   * extrapolation. Defaults to the target date when omitted (a target ≤ today
   * never extrapolates forward past it, so the default is harmless).
   */
  today?: string;
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

    // Housing valued from its curve (PRD #108): a real-estate asset with anchors
    // or a rate is worth its curve value on the target date, not the last manual
    // value. Without a curve it falls through to the manual last-known basis.
    const curve = input.housingValuationByAsset?.get(asset.id);
    if (hasHousingCurve(asset, curve)) {
      const valueMinor = housingCurveValueMinor(
        curve,
        input.targetDate,
        input.today ?? input.targetDate,
      );
      historicalAssets.push({ ...asset, currentValue: money(valueMinor, asset.currency) });
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
 * (ADR 0012 ripple). Only that asset's row is recomputed; every other frozen
 * row — manual holdings, liabilities (including ones frozen with a null tier),
 * other investments, and holdings later renamed, re-valued, or trashed — is
 * preserved verbatim. The five headline figures are adjusted by the operated
 * asset's value delta against the snapshot's own frozen figures, NOT re-derived
 * from rows, so the tier classification of every untouched holding survives
 * exactly as captured (rows alone cannot reproduce it — a null-tier debt could
 * be a mortgage or a loan). The asset keeps the unit price the snapshot already
 * captured; a newly-appearing asset uses the last operation price ≤ the date.
 *
 * Returns null when no holdings remain (the caller deletes the snapshot rather
 * than leaving it showing values derived from a now-deleted operation). Callers
 * must NOT invoke this for a snapshot with no frozen holding rows — a legacy
 * capture predating holdings (ADR 0008) has nothing to recompute against and
 * must be left frozen.
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

  // Recompute the operated asset's row at the snapshot's date.
  let newRow: SnapshotHoldingRow | undefined;
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
        newRow = {
          holdingId: input.asset.id,
          kind: "asset",
          label: existingRow?.label ?? input.asset.name,
          liquidityTier: existingRow?.liquidityTier ?? tierOfAsset(input.asset),
          units: position.currentUnits,
          valueMinor: ownedMinor,
          ...(price !== undefined ? { unitPrice: price } : {}),
        };
        rows.push(newRow);
      }
    }
  }

  if (rows.length === 0) return null;

  // Apply only the operated asset's delta to the frozen figures. The asset is
  // always an investment (an asset, never a liability), so debts never move.
  const deltaMinor = (newRow?.valueMinor ?? 0) - (existingRow?.valueMinor ?? 0);
  const tier = existingRow?.liquidityTier ?? newRow?.liquidityTier ?? null;

  const summary = {
    debts: { amountMinor: input.snapshot.debts.amountMinor, currency },
    grossAssets: {
      amountMinor: input.snapshot.grossAssets.amountMinor + deltaMinor,
      currency,
    },
    housingEquity: {
      amountMinor:
        input.snapshot.housingEquity.amountMinor +
        (tier && isHousing(tier) ? deltaMinor : 0),
      currency,
    },
    liquidNetWorth: {
      amountMinor:
        input.snapshot.liquidNetWorth.amountMinor +
        (tier && isLiquid(tier) ? deltaMinor : 0),
      currency,
    },
    scopeId: input.snapshot.scopeId,
    totalNetWorth: {
      amountMinor: input.snapshot.totalNetWorth.amountMinor + deltaMinor,
      currency,
    },
  };

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

export interface RecalculateHousingSnapshotInput {
  /** The existing snapshot to recalculate (its id, scope, date, capturedAt are preserved). */
  snapshot: NetWorthSnapshot;
  /** The snapshot's currently frozen holding rows. */
  frozenHoldings: SnapshotHoldingRow[];
  /** The identity of the single real-estate asset whose curve changed. */
  asset: ManualAsset;
  /**
   * That asset's curve inputs (anchors + rate + current value). When the curve
   * has neither anchors nor a rate (e.g. the last anchor was deleted), the
   * housing row falls back to the last-known-value / currentValue basis from
   * `manualValueHistory` — matching the `buildSnapshotAtDate` manual-holding
   * path so both paths stay consistent.
   */
  curve: HousingCurveInputs;
  /**
   * Audit history of manual values for this asset, keyed by asset id. Used
   * when the curve is empty (no anchors, no rate) to resolve the last-known
   * value at the snapshot date via the same basis as `buildSnapshotAtDate`.
   * Omit (or pass an empty map) when the curve is guaranteed non-empty.
   */
  manualValueHistory?: ReadonlyMap<string, ManualValuePoint[]>;
  workspace: Workspace;
  /** "Today" as YYYY-MM-DD — forwarded to the curve for forward extrapolation. */
  today: string;
}

/**
 * Recalculate an existing snapshot after one real-estate asset's valuation
 * curve changed (PRD #108 ripple) — a declared/edited/deleted anchor or a
 * changed rate. The housing asset's row is recomputed from the curve at the
 * snapshot's date; every other frozen row is preserved verbatim, exactly like
 * the operation ripple. Figures are adjusted by the housing asset's value delta
 * against the snapshot's own frozen figures (a housing tier, so gross + housing
 * equity + total move; liquid does not), so the frozen tier classification of
 * every untouched holding survives.
 *
 * Returns null when no holdings remain (the caller drops the snapshot). The
 * housing asset is scope-weighted with the same allocation the headline figures
 * use, so the reconciliation invariant holds by construction.
 */
export function recalculateSnapshotForHousing(
  input: RecalculateHousingSnapshotInput,
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

  // When the curve is empty (last anchor deleted, no rate) use the same
  // last-known-value / currentValue basis that buildSnapshotAtDate uses for
  // manual holdings — so both paths stay consistent (fix 1, PRD #108).
  // We cannot reuse hasHousingCurve here because input.curve is always a
  // HousingCurveInputs (not undefined), so the type guard would narrow the
  // else-branch to never. Instead check the curve's content directly.
  const curveIsActive =
    input.curve.anchors.length > 0 ||
    (input.curve.annualAppreciationRate != null &&
      input.curve.annualAppreciationRate !== "");
  let fullValueMinor: number;
  if (curveIsActive) {
    fullValueMinor = housingCurveValueMinor(input.curve, targetDate, input.today);
  } else {
    const points = input.manualValueHistory?.get(input.asset.id);
    const known = lastKnownValueAtDate(points, targetDate);
    fullValueMinor = known !== undefined ? known : input.curve.currentValueMinor;
  }

  const { ownedMinor, totalShareBps } = allocateScopedHolding(fullValueMinor, {
    ownership: input.asset.ownership,
    scopeMemberIds,
  });

  let newRow: SnapshotHoldingRow | undefined;
  if (totalShareBps > 0) {
    newRow = {
      holdingId: input.asset.id,
      kind: "asset",
      label: existingRow?.label ?? input.asset.name,
      liquidityTier: existingRow?.liquidityTier ?? tierOfAsset(input.asset),
      valueMinor: ownedMinor,
    };
    rows.push(newRow);
  }

  if (rows.length === 0) return null;

  const deltaMinor = (newRow?.valueMinor ?? 0) - (existingRow?.valueMinor ?? 0);
  const tier = existingRow?.liquidityTier ?? newRow?.liquidityTier ?? null;

  const summary = {
    debts: { amountMinor: input.snapshot.debts.amountMinor, currency },
    grossAssets: {
      amountMinor: input.snapshot.grossAssets.amountMinor + deltaMinor,
      currency,
    },
    housingEquity: {
      amountMinor:
        input.snapshot.housingEquity.amountMinor +
        (tier && isHousing(tier) ? deltaMinor : 0),
      currency,
    },
    liquidNetWorth: {
      amountMinor:
        input.snapshot.liquidNetWorth.amountMinor +
        (tier && isLiquid(tier) ? deltaMinor : 0),
      currency,
    },
    scopeId: input.snapshot.scopeId,
    totalNetWorth: {
      amountMinor: input.snapshot.totalNetWorth.amountMinor + deltaMinor,
      currency,
    },
  };

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
