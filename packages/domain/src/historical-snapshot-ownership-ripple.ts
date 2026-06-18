/**
 * Ownership-split ripple recalculation (#172, ADR 0020, ADR 0028, #321).
 *
 * The amendment seam for the **ownership splits** trigger category — the odd one
 * out: it re-weights a holding along the SCOPE axis, not time. After one
 * holding's ownership split changed, it re-derives every per-scope snapshot's
 * row for that holding by re-weighting its (unchanged) global value with the new
 * split, preserving every other frozen row verbatim. The shared
 * snapshot/reconciliation math (`resolveFrozenIdentity` +
 * `assembleRippleSnapshot`) lives in the core (`./historical-snapshot`); this
 * module adds only the per-trigger row-shaping.
 *
 * Pure module: imports only sibling domain modules and the core seam. No `db`.
 */

import {
  isHousingAsset,
  rungForLiability,
  securesHousingAsset,
  tierOfAsset,
} from "./classification";
import { assembleRippleSnapshot, resolveFrozenIdentity } from "./historical-snapshot";
import type {
  FrozenIdentityCapture,
  ResolvedFrozenIdentity,
} from "./historical-snapshot";
import { resolveScopeMemberIds } from "./scope";
import { allocateScopedHolding } from "./scope-allocation";
import type { SnapshotHoldingRow } from "./snapshot-holdings";
import type { NetWorthSnapshot, ValuedNetWorthSnapshot } from "./snapshot-types";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";

/** The edited holding's identity, carrying its NEW ownership split (#172). */
export type OwnershipRippleHolding =
  | { kind: "asset"; asset: ManualAsset }
  | { kind: "liability"; liability: Liability; housingAssetIds: ReadonlySet<string> };

export interface RecalculateOwnershipSnapshotInput {
  /** The existing snapshot to recalculate (its id, scope, date, capturedAt are preserved). */
  snapshot: NetWorthSnapshot;
  /** The snapshot's currently frozen holding rows. */
  frozenHoldings: SnapshotHoldingRow[];
  /** The edited holding's identity with its NEW ownership split. */
  holding: OwnershipRippleHolding;
  /**
   * The holding's GLOBAL value (the whole holding, 100% of the split) on this
   * snapshot's date, re-derived losslessly from the holding's curve / operations /
   * stored basis (`globalHoldingValueAtDate`, #187) — NOT recovered by dividing
   * the rounded household row, which drifts ±1–2 minor units for a holding
   * co-owned with a non-member. Invariant under an ownership-split edit (the split
   * only re-weights it). Positive; for a liability it is the outstanding balance.
   * The new per-scope row is this value re-weighted by the new split
   * (`allocateScopedHolding`).
   */
  globalValueMinor: number;
  workspace: Workspace;
  /**
   * This holding's frozen classification captures across every snapshot (#242).
   * Lets a row newly generated in a scope that never carried one (a member who
   * gains a stake) recover the holding's CONTEMPORANEOUS frozen housing-ness /
   * tier instead of leaking the live (possibly reclassified) one. Omitted → the
   * seam falls back to live (no recovery basis), preserving old behaviour.
   */
  frozenIdentity?: readonly FrozenIdentityCapture[];
}

/**
 * Recalculate an existing snapshot after one holding's OWNERSHIP SPLIT changed
 * (#172 ripple). An ownership split has no date dimension — it weights the
 * holding's global value into each member's scope — so a correction re-derives
 * every per-scope snapshot's row for that holding by re-weighting its (unchanged)
 * global value with the new split. Only that holding's row is recomputed; every
 * other frozen row is preserved verbatim, exactly like the operation / housing /
 * debt ripples. The household scope is invariant (its split always sums to 100%),
 * so callers skip it; passing a household snapshot here is a genuine no-op
 * (delta 0). Figures are adjusted by the holding's value delta against the
 * snapshot's own frozen figures, on the same axes the value ripples use (an asset
 * moves gross + total, plus housing or liquid by its tier; a liability moves debts
 * + total, plus housing equity or liquid). No new snapshot dates are created.
 *
 * Returns null when no holdings remain (the caller drops the snapshot). The
 * holding is scope-weighted with the same allocation the headline figures use, so
 * the reconciliation invariant (ADR 0008) holds by construction.
 */
export function recalculateSnapshotForOwnership(
  input: RecalculateOwnershipSnapshotInput,
): ValuedNetWorthSnapshot | null {
  const currency = input.workspace.baseCurrency;
  const scopeMemberIds = new Set(
    resolveScopeMemberIds(input.workspace, input.snapshot.scopeId),
  );

  const { holding } = input;
  const holdingId = holding.kind === "asset" ? holding.asset.id : holding.liability.id;
  const ownership =
    holding.kind === "asset" ? holding.asset.ownership : holding.liability.ownership;

  const existingRow = input.frozenHoldings.find(
    (row) => row.holdingId === holdingId && row.kind === holding.kind,
  );
  const rows = input.frozenHoldings.filter((row) => row.holdingId !== holdingId);

  // Re-weight the holding's global value into THIS scope by the new split.
  const { ownedMinor, totalShareBps } = allocateScopedHolding(input.globalValueMinor, {
    ownership,
    scopeMemberIds,
  });

  // Keep the SAME existence rule the capture path applies (a row for any scope
  // stake) so every ripple and the capture produce the same row set for a date
  // (#181) — a re-weight to a zero value still keeps the row.
  if (totalShareBps > 0) {
    const assetRungById = new Map(
      rows
        .filter((row) => row.kind === "asset" && row.liquidityTier !== null)
        .map((row) => [row.holdingId, row.liquidityTier!] as const),
    );
    // The LIVE classification (the precedence-3 fallback): mirrors the capture
    // path — an asset's housing-ness/tier from its live identity, an associated
    // debt's rung from its asset's frozen rung (unassociated → null), a debt's
    // securesHousing from the live housing-asset set; assets never secure housing.
    const live: ResolvedFrozenIdentity =
      holding.kind === "asset"
        ? {
            countsAsHousing: isHousingAsset(holding.asset),
            liquidityTier: tierOfAsset(holding.asset),
            securesHousing: false,
          }
        : {
            countsAsHousing: false,
            liquidityTier: holding.liability.associatedAssetId
              ? rungForLiability(holding.liability, assetRungById)
              : null,
            securesHousing: securesHousingAsset(
              holding.liability,
              holding.housingAssetIds,
            ),
          };
    // Resolve through the one frozen-vs-live seam (#242): existing row, else the
    // contemporaneous frozen capture from other snapshots (a member gaining a
    // stake recovers the holding's frozen housing-ness/tier), else live.
    const identity = resolveFrozenIdentity({
      existingRow,
      frozenIdentity: input.frozenIdentity ?? [],
      live,
      targetDate: input.snapshot.dateKey,
    });
    rows.push({
      countsAsHousing: identity.countsAsHousing,
      holdingId,
      kind: holding.kind,
      label:
        existingRow?.label ??
        (holding.kind === "asset" ? holding.asset.name : holding.liability.name),
      liquidityTier: identity.liquidityTier,
      securesHousing: identity.securesHousing,
      valueMinor: ownedMinor,
      ...(existingRow?.units !== undefined ? { units: existingRow.units } : {}),
      ...(existingRow?.unitPrice !== undefined
        ? { unitPrice: existingRow.unitPrice }
        : {}),
    });
  }

  // housingEquity is now fully row-derived from the frozen countsAsHousing flags
  // on asset rows (#181 completion) — no live isHousingAsset call, no delta
  // parameter. A housing asset's re-weight carries its frozen flag onto the new
  // row; the helper reads it from there.
  return assembleRippleSnapshot({
    currency,
    frozenHoldings: input.frozenHoldings,
    rows,
    snapshot: input.snapshot,
  });
}
