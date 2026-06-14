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
import {
  housingAssetIdsOf,
  isLiquid,
  rungForLiability,
  securesHousingAsset,
  tierOfAsset,
} from "./classification";
import type { DecimalString } from "./decimal";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";
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
  /**
   * Whether this holding secures a housing asset, frozen at capture time from the
   * ALL-ASSETS classification (#180). Set only for liabilities — true when the
   * liability is associated to a housing asset present at capture, false
   * otherwise; always false for assets. Frozen on purpose: it makes the derived
   * housing-equity axis self-classifying, so historical figures never re-derive
   * the relationship from live holding identity (a live foreign key into frozen
   * history, which ADR 0008 forbids).
   */
  securesHousing: boolean;
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
  // The ALL-ASSETS housing classification at capture time (#180) — the same basis
  // calculateNetWorth uses to net debts against housing. Frozen onto each row so
  // historical figures never re-derive it from live holding identity (ADR 0008).
  const housingAssetIds = housingAssetIdsOf(input.assets);
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
      securesHousing: false,
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
        ? rungForLiability(liability, assetTierById)
        : null,
      securesHousing: securesHousingAsset(liability, housingAssetIds),
      valueMinor: ownedMinor,
    });
  }

  return rows;
}

/**
 * The headline figures the holding rows must reconcile against. The first two
 * are the original ADR 0008 invariant (asset/liability row sums). The optional
 * three derived figures extend it (#181): when supplied, the reconcile also
 * proves the breakdown axes are self-consistent with the frozen rows, so a
 * ripple can never silently impute a value delta to the wrong axis.
 */
export interface SnapshotReconciliationTotals {
  grossAssetsMinor: number;
  debtsMinor: number;
  /** The housing-asset row sum behind housing equity — assets are not self-flagged. */
  housingAssetsMinor?: number;
  /** totalNetWorth, asserted to equal grossAssets − debts (#181). */
  totalNetWorthMinor?: number;
  /** liquidNetWorth, asserted to equal liquid asset rows − liquid non-housing debt rows (#181). */
  liquidNetWorthMinor?: number;
  /** housingEquity, asserted to equal housingAssets − securesHousing debt rows (#181). */
  housingEquityMinor?: number;
}

/**
 * The breakdown axes derived purely from the frozen holding rows (#181) — the
 * single place the ripple/capture summary is reconciled against. Mirrors
 * `calculateNetWorth`'s definitions exactly: liquid = top-two-rung asset rows
 * less liquid non-housing-securing debt rows; housing debts = the frozen
 * `securesHousing` debt rows. Housing assets are NOT self-flagged on a row
 * (assets always freeze `securesHousing=false`), so the housing-asset sum is
 * supplied by the caller and only the housing-DEBT term is row-derived here.
 */
export interface DerivedRowAxes {
  grossAssetsMinor: number;
  debtsMinor: number;
  /** Sum of asset rows on a liquid rung (cash + market). */
  liquidAssetsMinor: number;
  /** Sum of liability rows that are liquid AND do not secure housing. */
  liquidDebtsMinor: number;
  /** Sum of liability rows with frozen `securesHousing` true. */
  housingDebtsMinor: number;
}

/**
 * Fold the frozen rows into the breakdown axes (#181). A liability's rung is its
 * own frozen tier when present, else `cash` — the same fallback `rungForLiability`
 * applies to an unassociated/non-housing debt, so a null-tier non-housing debt
 * (frozen with a null rung) lands on the liquid axis exactly as the live
 * `calculateNetWorth` path resolves it.
 */
export function deriveRowAxes(rows: readonly SnapshotHoldingRow[]): DerivedRowAxes {
  let grossAssetsMinor = 0;
  let debtsMinor = 0;
  let liquidAssetsMinor = 0;
  let liquidDebtsMinor = 0;
  let housingDebtsMinor = 0;

  for (const row of rows) {
    if (row.kind === "asset") {
      grossAssetsMinor += row.valueMinor;
      if (row.liquidityTier !== null && isLiquid(row.liquidityTier)) {
        liquidAssetsMinor += row.valueMinor;
      }
    } else {
      debtsMinor += row.valueMinor;
      if (row.securesHousing) {
        housingDebtsMinor += row.valueMinor;
      } else if (isLiquid(row.liquidityTier ?? "cash")) {
        liquidDebtsMinor += row.valueMinor;
      }
    }
  }

  return {
    debtsMinor,
    grossAssetsMinor,
    housingDebtsMinor,
    liquidAssetsMinor,
    liquidDebtsMinor,
  };
}

/**
 * The reconciliation invariant (ADR 0008, extended in #181): asset rows must sum
 * EXACTLY to the headline gross assets and liability rows to the headline debts;
 * and — when the derived figures are supplied — the headline total / liquid /
 * housing figures must equal what the frozen rows derive (`deriveRowAxes` +
 * the caller's housing-asset sum). Throws a loud, descriptive error on any
 * mismatch so a capture never persists a portfolio that contradicts its own
 * figures, and a ripple can never impute a value delta to the wrong axis.
 */
export function assertSnapshotHoldingsReconcile(
  rows: readonly SnapshotHoldingRow[],
  totals: SnapshotReconciliationTotals,
): void {
  const axes = deriveRowAxes(rows);

  if (axes.grossAssetsMinor !== totals.grossAssetsMinor) {
    throw new Error(
      `Snapshot capture failed reconciliation: asset rows sum to ${axes.grossAssetsMinor} ` +
        `but headline gross assets is ${totals.grossAssetsMinor} (minor units). ` +
        "Nothing was persisted.",
    );
  }

  if (axes.debtsMinor !== totals.debtsMinor) {
    throw new Error(
      `Snapshot capture failed reconciliation: liability rows sum to ${axes.debtsMinor} ` +
        `but headline debts is ${totals.debtsMinor} (minor units). ` +
        "Nothing was persisted.",
    );
  }

  if (totals.totalNetWorthMinor !== undefined) {
    const expected = totals.grossAssetsMinor - totals.debtsMinor;
    if (totals.totalNetWorthMinor !== expected) {
      throw new Error(
        `Snapshot capture failed reconciliation: total net worth is ` +
          `${totals.totalNetWorthMinor} but grossAssets − debts is ${expected} ` +
          "(minor units). Nothing was persisted.",
      );
    }
  }

  if (totals.liquidNetWorthMinor !== undefined) {
    const expected = axes.liquidAssetsMinor - axes.liquidDebtsMinor;
    if (totals.liquidNetWorthMinor !== expected) {
      throw new Error(
        `Snapshot capture failed reconciliation: liquid net worth is ` +
          `${totals.liquidNetWorthMinor} but liquid asset rows − liquid non-housing ` +
          `debt rows is ${expected} (minor units). Nothing was persisted.`,
      );
    }
  }

  if (totals.housingEquityMinor !== undefined) {
    if (totals.housingAssetsMinor === undefined) {
      throw new Error(
        "Snapshot capture failed reconciliation: housingEquityMinor was supplied " +
          "without housingAssetsMinor (the row-side housing-asset sum). " +
          "Nothing was persisted.",
      );
    }
    const expected = totals.housingAssetsMinor - axes.housingDebtsMinor;
    if (totals.housingEquityMinor !== expected) {
      throw new Error(
        `Snapshot capture failed reconciliation: housing equity is ` +
          `${totals.housingEquityMinor} but housing assets − securesHousing debt rows ` +
          `is ${expected} (minor units). Nothing was persisted.`,
      );
    }
  }
}
