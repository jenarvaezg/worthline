/**
 * Position-revalue ripple recalculation (ADR 0017/0021, ADR 0028, #320).
 *
 * The amendment seam for the **position revalues** trigger category: a Numista
 * coin acquisition (additive) and a Binance/connected-value reconstruction
 * (set/replace). Each swaps the connected holding's row on an already-frozen
 * snapshot and re-derives the five headline figures, preserving every other
 * frozen row verbatim. The shared snapshot/reconciliation math
 * (`resolveFrozenIdentity` + `assembleRippleSnapshot`) lives in the core
 * (`./historical-snapshot`); this module adds only the per-trigger row-shaping.
 *
 * Pure module: imports only sibling domain modules and the core seam. No `db`.
 */

import { tierOfAsset } from "./classification";
import { assembleRippleSnapshot, resolveFrozenIdentity } from "./historical-snapshot";
import type { FrozenIdentityCapture } from "./historical-snapshot";
import { resolveScopeMemberIds } from "./scope";
import { allocateScopedHolding } from "./scope-allocation";
import type { SnapshotHoldingRow } from "./snapshot-holdings";
import type { NetWorthSnapshot, ValuedNetWorthSnapshot } from "./snapshot-types";
import type { ManualAsset, Workspace } from "./workspace-types";

export interface RecalculateCoinAcquisitionSnapshotInput {
  /** The existing snapshot to recalculate (its id, scope, date, capturedAt are preserved). */
  snapshot: NetWorthSnapshot;
  /** The snapshot's currently frozen holding rows. */
  frozenHoldings: SnapshotHoldingRow[];
  /** The materialized coin-collection asset the source projects into (ADR 0016). */
  asset: ManualAsset;
  /**
   * The newly-acquired coin's GLOBAL (100%, un-allocated) value, minor units,
   * captured AT RIPPLE TIME and frozen (ADR 0017): worthline never fetches a
   * coin's historical price, so a later price move never rewrites this. The new
   * per-scope contribution is this value re-weighted by the collection's split.
   */
  globalDeltaMinor: number;
  workspace: Workspace;
  /**
   * This coin collection's frozen classification captures across every snapshot
   * (#242). Routes the (re)created coin row through the same frozen-vs-live seam
   * the other ripples use, for uniformity (a coin collection is constant illiquid
   * / never housing, so this is not independently triggerable). Omitted → live.
   */
  frozenIdentity?: readonly FrozenIdentityCapture[];
}

/**
 * Recalculate an existing snapshot after a coin's PURCHASE DATE places it on the
 * timeline (ADR 0017 ripple, S6/#167). Unlike the operation/curve ripples — which
 * re-derive one holding's whole value from its ledger — a coin acquisition is
 * ADDITIVE: the coin's frozen owned value is added to the coin-collection holding's
 * row (created if the snapshot had none), never recomputed from current positions.
 * This is what keeps history frozen (a later price move adds nothing) and lets a
 * sold coin stay in past snapshots (it is never subtracted): the orchestration
 * ripples a coin exactly once, when its trade is first seen on sync.
 *
 * Every other frozen row is preserved verbatim, like the sibling ripples. The
 * coin collection is illiquid and never housing, so only gross + total move; the
 * coin is scope-weighted with the same allocation the headline figures use, so the
 * reconciliation invariant (ADR 0008) holds by construction. Returns null when no
 * holdings remain (the caller drops the snapshot) — never expected here, since the
 * acquisition only ever adds value.
 */
export function recalculateSnapshotForCoinAcquisition(
  input: RecalculateCoinAcquisitionSnapshotInput,
): ValuedNetWorthSnapshot | null {
  const currency = input.workspace.baseCurrency;
  const scopeMemberIds = new Set(
    resolveScopeMemberIds(input.workspace, input.snapshot.scopeId),
  );

  const existingRow = input.frozenHoldings.find(
    (row) => row.holdingId === input.asset.id && row.kind === "asset",
  );
  const rows = input.frozenHoldings.filter((row) => row.holdingId !== input.asset.id);

  const { ownedMinor, totalShareBps } = allocateScopedHolding(input.globalDeltaMinor, {
    ownership: input.asset.ownership,
    scopeMemberIds,
  });

  // Append the coin-collection row with its frozen value INCREMENTED by this
  // scope's share of the new coin. Keep an existing row even when this scope gains
  // no stake (totalShareBps 0), so a re-weight to zero never silently drops it.
  if (existingRow !== undefined || totalShareBps > 0) {
    // Resolve through the one frozen-vs-live seam (#242): existing row, else the
    // contemporaneous frozen capture, else live. A coin collection is constant
    // illiquid, never a housing asset, never secures housing.
    const identity = resolveFrozenIdentity({
      existingRow,
      frozenIdentity: input.frozenIdentity ?? [],
      live: {
        countsAsHousing: false,
        liquidityTier: tierOfAsset(input.asset),
        securesHousing: false,
      },
      targetDate: input.snapshot.dateKey,
    });
    rows.push({
      countsAsHousing: identity.countsAsHousing,
      holdingId: input.asset.id,
      kind: "asset",
      label: existingRow?.label ?? input.asset.name,
      liquidityTier: identity.liquidityTier,
      securesHousing: identity.securesHousing,
      valueMinor: (existingRow?.valueMinor ?? 0) + (totalShareBps > 0 ? ownedMinor : 0),
    });
  }

  return assembleRippleSnapshot({
    currency,
    frozenHoldings: input.frozenHoldings,
    rows,
    snapshot: input.snapshot,
  });
}

export interface RecalculateConnectedValueSnapshotInput {
  /** The existing snapshot to recalculate (its id, scope, date, capturedAt are preserved). */
  snapshot: NetWorthSnapshot;
  /** The snapshot's currently frozen holding rows. */
  frozenHoldings: SnapshotHoldingRow[];
  /** The materialized connected market holding the source projects into (ADR 0021). */
  asset: ManualAsset;
  /**
   * The connected holding's GLOBAL (100%, un-allocated) value on this snapshot's
   * date, minor units — the reconstructed monthly history (Σ balance × that-day
   * price, ADR 0021). The per-scope frozen row is SET to this value re-weighted by
   * the holding's ownership split; a value of 0 still records the row (the holding
   * existed at 0 that day — unpriceable, not absent). Frozen at backfill time.
   */
  globalValueMinor: number;
  workspace: Workspace;
  /**
   * This holding's frozen classification captures across every snapshot (#242).
   * Routes the (re)created market row through the same frozen-vs-live seam the
   * other ripples use, for uniformity (a connected crypto holding is constant
   * market / never housing, so this is not independently triggerable). Omitted →
   * the seam falls back to live (no recovery basis), preserving old behaviour.
   */
  frozenIdentity?: readonly FrozenIdentityCapture[];
}

/**
 * Recalculate an existing snapshot after a connected market source (Binance, ADR
 * 0021) reconstructs its value on a past date. Unlike the coin-acquisition ripple
 * — which is ADDITIVE (a coin's frozen value is added once) — this SETS the
 * holding's row to the date's reconstructed value: the source carries a single
 * frozen monthly-history figure per date, not an accreting ledger of trades. The
 * row is created if the snapshot had none, REPLACED (never accumulated) if it had
 * one — so re-running with the same history is a no-op and a new month only sets
 * the dates it covers.
 *
 * Every other frozen row is preserved verbatim, like the sibling ripples. A crypto
 * holding is on the `market` rung — liquid, never housing, never secures housing —
 * so gross + total + liquid move; the holding is scope-weighted with the same
 * allocation the headline figures use, so the reconciliation invariant (ADR 0008)
 * holds by construction. Returns null when no holdings remain (the caller drops the
 * snapshot) — not expected here, since a market value is only ever set, never
 * removed.
 */
export function recalculateSnapshotForConnectedValue(
  input: RecalculateConnectedValueSnapshotInput,
): ValuedNetWorthSnapshot | null {
  const currency = input.workspace.baseCurrency;
  const scopeMemberIds = new Set(
    resolveScopeMemberIds(input.workspace, input.snapshot.scopeId),
  );

  const existingRow = input.frozenHoldings.find(
    (row) => row.holdingId === input.asset.id && row.kind === "asset",
  );
  const rows = input.frozenHoldings.filter((row) => row.holdingId !== input.asset.id);

  const { ownedMinor, totalShareBps } = allocateScopedHolding(input.globalValueMinor, {
    ownership: input.asset.ownership,
    scopeMemberIds,
  });

  // SET (replace) the market holding's row to this scope's share of the date's
  // reconstructed value — never added onto the existing value (that is the
  // coin-acquisition path's contract, not this one). Keep an existing row even
  // when this scope gains no stake (totalShareBps 0), so a re-weight to zero never
  // silently drops it; a zero value with a stake still records the row (the holding
  // existed at 0 — unpriceable, ADR 0021).
  if (existingRow !== undefined || totalShareBps > 0) {
    // Resolve through the one frozen-vs-live seam (#242): existing row, else the
    // contemporaneous frozen capture, else live. A connected crypto holding is
    // constant market rung, never a housing asset, never secures housing.
    const identity = resolveFrozenIdentity({
      existingRow,
      frozenIdentity: input.frozenIdentity ?? [],
      live: {
        countsAsHousing: false,
        liquidityTier: tierOfAsset(input.asset),
        securesHousing: false,
      },
      targetDate: input.snapshot.dateKey,
    });
    rows.push({
      countsAsHousing: identity.countsAsHousing,
      holdingId: input.asset.id,
      kind: "asset",
      label: existingRow?.label ?? input.asset.name,
      liquidityTier: identity.liquidityTier,
      securesHousing: identity.securesHousing,
      valueMinor: totalShareBps > 0 ? ownedMinor : (existingRow?.valueMinor ?? 0),
    });
  }

  return assembleRippleSnapshot({
    currency,
    frozenHoldings: input.frozenHoldings,
    rows,
    snapshot: input.snapshot,
  });
}
