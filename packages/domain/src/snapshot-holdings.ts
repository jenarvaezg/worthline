/**
 * Snapshot holding rows (ADR 0008).
 *
 * Every snapshot capture also records the valued portfolio behind its figures:
 * one row per holding, with the holding's stable id, its label and liquidity
 * tier copied (denormalized) at capture time, and its scope-weighted value in
 * integer minor units. Investments additionally carry units and unit price as
 * decimal strings.
 *
 * Per-tier aggregates are never stored — they are derived from these rows at
 * read time. At capture time the reconciliation invariant must hold: asset rows
 * sum exactly to the headline gross assets and liability rows to the headline
 * debts, or the capture fails loudly and persists nothing.
 */

import type { LiquidityTier } from "./classification";
import { tierOfAsset, tierOfLiability } from "./classification";
import type { DecimalString } from "./decimal";
import type { Liability, ManualAsset, Workspace } from "./index";
import { resolveScopeMemberIds } from "./scope";
import { allocateScopedHolding } from "./scope-allocation";

export type SnapshotHoldingKind = "asset" | "liability";

/**
 * One frozen holding row behind a snapshot's figures. Label and tier are
 * denormalized on purpose: later renames, re-tierings, or deletions of the
 * holding must never alter what a past snapshot captured — no live foreign
 * keys into holdings.
 */
export interface SnapshotHoldingRow {
  /** The holding's stable id (asset or liability id) — informational, not a live FK. */
  holdingId: string;
  kind: SnapshotHoldingKind;
  /** The holding's name, frozen at capture time. */
  label: string;
  /**
   * The liquidity tier frozen at capture time. For liabilities, the tier is
   * resolved via the asset securing them — null when no asset secures the debt.
   */
  liquidityTier: LiquidityTier | null;
  /** The scope-weighted value in integer minor units (same weighting as the headline figures). */
  valueMinor: number;
  /** Units held — investments only. */
  units?: DecimalString;
  /** Price per unit used that day — investments only, when a price was known. */
  unitPrice?: DecimalString;
}

/** Units and unit price of one investment at capture time, keyed by asset id. */
export interface InvestmentCaptureDetail {
  units: DecimalString;
  unitPrice?: DecimalString;
}

export interface BuildSnapshotHoldingRowsInput {
  workspace: Workspace;
  scopeId: string;
  assets: ManualAsset[];
  liabilities?: Liability[];
  /** Per-investment units and unit price, keyed by asset id. */
  investmentDetails?: ReadonlyMap<string, InvestmentCaptureDetail>;
}

/**
 * Produce the holding rows behind a scope's snapshot.
 *
 * Values are scope-weighted with the exact same per-holding allocation
 * (allocateScopedHolding) the headline figures use, so the reconciliation
 * invariant holds by construction. Holdings with no ownership stake in the
 * scope are omitted — they are not behind the scope's figures.
 */
export function buildSnapshotHoldingRows(
  input: BuildSnapshotHoldingRowsInput,
): SnapshotHoldingRow[] {
  const scopeMemberIds = new Set(resolveScopeMemberIds(input.workspace, input.scopeId));
  const assetTierById = new Map(
    input.assets.map((asset) => [asset.id, tierOfAsset(asset)]),
  );
  const rows: SnapshotHoldingRow[] = [];

  for (const asset of input.assets) {
    const { ownedMinor, totalShareBps } = allocateScopedHolding(
      asset.currentValue.amountMinor,
      { ownership: asset.ownership, scopeMemberIds },
    );

    if (totalShareBps === 0) {
      continue;
    }

    const detail =
      asset.type === "investment" ? input.investmentDetails?.get(asset.id) : undefined;

    rows.push({
      holdingId: asset.id,
      kind: "asset",
      label: asset.name,
      liquidityTier: tierOfAsset(asset),
      valueMinor: ownedMinor,
      ...(detail
        ? {
            units: detail.units,
            ...(detail.unitPrice !== undefined ? { unitPrice: detail.unitPrice } : {}),
          }
        : {}),
    });
  }

  for (const liability of input.liabilities ?? []) {
    const { ownedMinor, totalShareBps } = allocateScopedHolding(
      liability.currentBalance.amountMinor,
      { ownership: liability.ownership, scopeMemberIds },
    );

    if (totalShareBps === 0) {
      continue;
    }

    rows.push({
      holdingId: liability.id,
      kind: "liability",
      label: liability.name,
      liquidityTier: liability.associatedAssetId
        ? tierOfLiability(liability, assetTierById)
        : null,
      valueMinor: ownedMinor,
    });
  }

  return rows;
}

/** The headline figures the holding rows must reconcile against. */
export interface SnapshotReconciliationTotals {
  grossAssetsMinor: number;
  debtsMinor: number;
}

/**
 * The reconciliation invariant (ADR 0008): asset rows must sum EXACTLY to the
 * headline gross assets and liability rows to the headline debts. Throws a
 * loud, descriptive error on any mismatch so a capture never persists a
 * portfolio that contradicts its own figures.
 */
export function assertSnapshotHoldingsReconcile(
  rows: readonly SnapshotHoldingRow[],
  totals: SnapshotReconciliationTotals,
): void {
  let assetSumMinor = 0;
  let liabilitySumMinor = 0;

  for (const row of rows) {
    if (row.kind === "asset") {
      assetSumMinor += row.valueMinor;
    } else {
      liabilitySumMinor += row.valueMinor;
    }
  }

  if (assetSumMinor !== totals.grossAssetsMinor) {
    throw new Error(
      `Snapshot capture failed reconciliation: asset rows sum to ${assetSumMinor} ` +
        `but headline gross assets is ${totals.grossAssetsMinor} (minor units). ` +
        "Nothing was persisted.",
    );
  }

  if (liabilitySumMinor !== totals.debtsMinor) {
    throw new Error(
      `Snapshot capture failed reconciliation: liability rows sum to ${liabilitySumMinor} ` +
        `but headline debts is ${totals.debtsMinor} (minor units). ` +
        "Nothing was persisted.",
    );
  }
}
