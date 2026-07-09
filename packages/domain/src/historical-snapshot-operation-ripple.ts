/**
 * Operation-ripple recalculation (ADR 0012, ADR 0028, #320).
 *
 * The amendment seam for the **operations** trigger category: after one
 * investment's operations changed, swap that asset's row on an already-frozen
 * snapshot and re-derive the five headline figures, preserving every other
 * frozen row verbatim. The shared snapshot/reconciliation math
 * (`resolveFrozenIdentity` + `assembleRippleSnapshot`) lives in the core
 * (`./historical-snapshot`); this module adds only the per-trigger row-shaping.
 *
 * Pure module: imports only sibling domain modules and the core seam. No `db`.
 */

import { tierOfAsset } from "./classification";
import type { DecimalString } from "./decimal";
import type { FrozenIdentityCapture } from "./historical-snapshot";
import { assembleRippleSnapshot, resolveFrozenIdentity } from "./historical-snapshot";
import { valueAt } from "./holding-valuation";
import type { InvestmentOperation } from "./investment-types";
import { resolveScopeMemberIds } from "./scope";
import { allocateScopedHolding } from "./scope-allocation";
import type { SnapshotHoldingRow } from "./snapshot-holdings";
import type { NetWorthSnapshot, ValuedNetWorthSnapshot } from "./snapshot-types";
import type { ManualAsset, Workspace } from "./workspace-types";

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
  /**
   * This asset's frozen classification captures across every snapshot (#242).
   * Lets a row newly generated at a date this snapshot never carried recover the
   * asset's CONTEMPORANEOUS frozen tier instead of leaking the live one. Omitted
   * → the seam falls back to live (no recovery basis), preserving old behaviour.
   */
  frozenIdentity?: readonly FrozenIdentityCapture[];
  /**
   * A historical unit price to FREEZE onto the operated asset's row for this date
   * (#380, ADR 0033 — the explicit price-backfill action). When present it wins
   * over both the snapshot's existing captured price AND the cost-basis fallback,
   * so a row previously valued at cost (units, no price) becomes units × this
   * price. This is the ONLY override of the "keep the price the snapshot already
   * captured" rule, and only the explicit backfill seam supplies it — the daily
   * refresh and the operation ripple never do, so history stays untouched unless
   * the user runs the backfill.
   */
  overrideUnitPrice?: DecimalString;
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

  // Recompute the operated asset's row at the snapshot's date via the same
  // dispatcher the fresh capture uses (#150 carry-over): `derived` folds the
  // ledger to the date, keeping the unit price the snapshot already captured
  // (else the last operation price ≤ the date), and yields null when the asset
  // was not held then — byte-identical to the positions math this used to inline.
  //
  // A derived row frozen with units but NO unitPrice was captured at cost basis
  // (ADR 0006 fallback — no provider/manual price that day). Flag it so the
  // ripple preserves cost basis instead of falling back to the latest operation
  // price, which would shift a figure whose portfolio state never changed (#183).
  // The price-backfill override (#380, ADR 0033) wins over both the captured
  // price and the cost-basis fallback: the explicit action is freezing a real
  // historical price onto a row that had none. Absent it, behaviour is unchanged.
  const capturedUnitPrice = input.overrideUnitPrice ?? existingRow?.unitPrice;
  const wasCapturedAtCostBasis =
    capturedUnitPrice === undefined &&
    existingRow?.units !== undefined &&
    existingRow.unitPrice === undefined;
  const valuation = valueAt(
    {
      assetId: input.asset.id,
      currency: input.asset.currency,
      method: "derived",
      operations: input.operations,
      ...(capturedUnitPrice !== undefined ? { capturedUnitPrice } : {}),
      ...(wasCapturedAtCostBasis ? { atCostBasis: true } : {}),
    },
    targetDate,
  );

  if (valuation.valueMinor !== null) {
    const { ownedMinor, totalShareBps } = allocateScopedHolding(valuation.valueMinor, {
      ownership: input.asset.ownership,
      scopeMemberIds,
    });

    if (totalShareBps > 0) {
      // Resolve the FROZEN classification through the one seam (#242): existing
      // row, else the contemporaneous frozen capture from other snapshots, else
      // live. An investment is never housing / never secures housing.
      const identity = resolveFrozenIdentity({
        existingRow,
        frozenIdentity: input.frozenIdentity ?? [],
        live: {
          countsAsHousing: false,
          liquidityTier: tierOfAsset(input.asset),
          securesHousing: false,
        },
        targetDate,
      });
      rows.push({
        countsAsHousing: identity.countsAsHousing,
        holdingId: input.asset.id,
        kind: "asset",
        label: existingRow?.label ?? input.asset.name,
        liquidityTier: identity.liquidityTier,
        securesHousing: identity.securesHousing,
        valueMinor: ownedMinor,
        ...(valuation.units !== undefined ? { units: valuation.units } : {}),
        ...(valuation.unitPrice !== undefined ? { unitPrice: valuation.unitPrice } : {}),
      });
    }
  }

  return assembleRippleSnapshot({
    currency,
    frozenHoldings: input.frozenHoldings,
    rows,
    snapshot: input.snapshot,
  });
}
