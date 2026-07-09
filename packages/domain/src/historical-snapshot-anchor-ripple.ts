/**
 * Anchor-ripple recalculation (PRD #108/#109, ADR 0028, #321).
 *
 * The amendment seam for the **curve-anchor** trigger category: a real-estate
 * asset's valuation curve (valuation anchors + rate) or a liability's debt curve
 * (balance anchors OR an amortization plan) changed. Each swaps the affected
 * holding's row on an already-frozen snapshot and re-derives the five headline
 * figures, preserving every other frozen row verbatim. Balance anchors and
 * amortization plans share one function (`recalculateSnapshotForLiability`):
 * `debtCurveValuationInput` dispatches anchored vs. amortized by `debtModel`, so
 * both balance-anchor and amortization-plan ripple logic live here. The
 * amortization-plan per-cuota density stays in the core's
 * `amortizationPaymentDatesUpTo`, called by the db orchestrator (not duplicated).
 *
 * The shared snapshot/reconciliation math (`resolveFrozenIdentity` +
 * `assembleRippleSnapshot`) and the curve→valuation-input dispatcher
 * (`debtCurveValuationInput`) live in the core (`./historical-snapshot`); this
 * module adds only the per-trigger row-shaping.
 *
 * Pure module: imports only sibling domain modules and the core seam. No `db`.
 */

import { rungForLiability, securesHousingAsset, tierOfAsset } from "./classification";
import type {
  DebtBalanceCurveInputs,
  FrozenIdentityCapture,
  HousingCurveInputs,
} from "./historical-snapshot";
import {
  assembleRippleSnapshot,
  debtCurveValuationInput,
  resolveFrozenIdentity,
} from "./historical-snapshot";
import { valueAt } from "./holding-valuation";
import { resolveScopeMemberIds } from "./scope";
import { allocateScopedHolding } from "./scope-allocation";
import type { SnapshotHoldingRow } from "./snapshot-holdings";
import type { NetWorthSnapshot, ValuedNetWorthSnapshot } from "./snapshot-types";
import type { ManualValuePoint } from "./value-history";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";

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
  /**
   * This asset's frozen classification captures across every snapshot (#242).
   * Routes the newly-appearing housing row through the same frozen-vs-live seam
   * the asset ripple uses, for uniformity (housing tier is forced illiquid, so
   * this is not independently triggerable today). Omitted → live fallback.
   */
  frozenIdentity?: readonly FrozenIdentityCapture[];
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

  // Value the housing asset on the target date via the same dispatcher (#148):
  // the appreciating method already encodes "curve when active, else the
  // last-known-value / currentValue basis" — keeping this ripple consistent with
  // buildSnapshotAtDate (fix 1, PRD #108).
  const points = input.manualValueHistory?.get(input.asset.id);
  const rate = input.curve.annualAppreciationRate;
  const fullValueMinor =
    valueAt(
      {
        anchors: input.curve.anchors,
        currentValueMinor: input.curve.currentValueMinor,
        method: "appreciating",
        today: input.today,
        ...(rate != null && rate !== "" ? { annualAppreciationRate: rate } : {}),
        ...(input.curve.cadence != null ? { cadence: input.curve.cadence } : {}),
        ...(points !== undefined ? { valueHistory: points } : {}),
      },
      targetDate,
    ).valueMinor ?? input.curve.currentValueMinor;

  const { ownedMinor, totalShareBps } = allocateScopedHolding(fullValueMinor, {
    ownership: input.asset.ownership,
    scopeMemberIds,
  });

  if (totalShareBps > 0) {
    // Resolve the FROZEN classification through the one seam (#242): existing row,
    // else the contemporaneous frozen capture, else live. This ripple is called
    // only for housing assets, so live is countsAsHousing=true / illiquid tier,
    // matching the capture path; an asset never secures housing (#180).
    const identity = resolveFrozenIdentity({
      existingRow,
      frozenIdentity: input.frozenIdentity ?? [],
      live: {
        countsAsHousing: true,
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
    });
  }

  // housingEquity is now fully row-derived from the frozen countsAsHousing flags
  // on asset rows (#181 completion) — the helper needs no delta parameter.
  return assembleRippleSnapshot({
    currency,
    frozenHoldings: input.frozenHoldings,
    rows,
    snapshot: input.snapshot,
  });
}

export interface RecalculateLiabilitySnapshotInput {
  /** The existing snapshot to recalculate (its id, scope, date, capturedAt are preserved). */
  snapshot: NetWorthSnapshot;
  /** The snapshot's currently frozen holding rows. */
  frozenHoldings: SnapshotHoldingRow[];
  /** The identity of the single liability whose debt curve changed. */
  liability: Liability;
  /** That liability's debt-balance curve inputs (model + anchors/plan/revisions). */
  curve: DebtBalanceCurveInputs;
  /**
   * Ids of the scope's housing assets (real estate / primary residence). A debt
   * securing one of these nets housing equity; the liquidity rung alone can no
   * longer tell housing from other illiquid holdings (ADR 0013 bridge).
   */
  housingAssetIds: ReadonlySet<string>;
  workspace: Workspace;
}

/**
 * Recalculate an existing snapshot after one liability's debt curve changed
 * (PRD #109, slice 9 ripple) — a declared/edited/deleted plan, anchor, or rate
 * revision. Only that liability's row is recomputed from `debtBalanceAtDate` at
 * the snapshot's date; every other frozen row is preserved verbatim, exactly
 * like the asset/housing ripples. Figures are adjusted by the liability's value
 * delta against the snapshot's own frozen figures: debts move by +delta and
 * total net worth by -delta (a higher balance lowers net worth). Housing equity
 * moves by -delta when the debt secures a housing asset (`housingAssetIds`);
 * otherwise liquid net worth moves by -delta when the debt sits on a liquid
 * rung — resolved from the frozen asset rows, since the frozen liability row's
 * own tier is null for an unassociated debt (ADR 0013).
 *
 * Returns null when no holdings remain (the caller drops the snapshot). The
 * liability is scope-weighted with the same allocation the headline figures use,
 * so the reconciliation invariant holds by construction.
 */
export function recalculateSnapshotForLiability(
  input: RecalculateLiabilitySnapshotInput,
): ValuedNetWorthSnapshot | null {
  const targetDate = input.snapshot.dateKey;
  const currency = input.workspace.baseCurrency;
  const scopeMemberIds = new Set(
    resolveScopeMemberIds(input.workspace, input.snapshot.scopeId),
  );

  const existingRow = input.frozenHoldings.find(
    (row) => row.holdingId === input.liability.id && row.kind === "liability",
  );
  const rows = input.frozenHoldings.filter((row) => row.holdingId !== input.liability.id);

  // Value the liability on the target date via the unified dispatcher (#150
  // carry-over): the curve's model picks amortized / anchored, and a null model
  // falls back to the curve's current balance — byte-identical to the engines
  // this used to inline, but now threading early repayments in one place.
  const curveInput = debtCurveValuationInput(input.curve);
  const fullBalanceMinor =
    (curveInput ? valueAt(curveInput, targetDate).valueMinor : null) ??
    input.curve.currentBalanceMinor;
  const { ownedMinor, totalShareBps } = allocateScopedHolding(fullBalanceMinor, {
    ownership: input.liability.ownership,
    scopeMemberIds,
  });

  // The new row keeps the SAME existence rule the capture path applies (a row for
  // any scope stake, even a zero balance) so every ripple and the capture produce
  // the same row set for a date (#181). Its rung is resolved consistently with the
  // live calculateNetWorth path: an associated debt inherits its asset's frozen
  // rung from the surviving asset rows, else `cash` (rungForLiability) — never
  // null, so a non-housing associated debt lands on the right liquid axis.
  if (totalShareBps > 0) {
    const assetRungById = new Map(
      rows
        .filter((row) => row.kind === "asset" && row.liquidityTier !== null)
        .map((row) => [row.holdingId, row.liquidityTier!] as const),
    );
    rows.push({
      // Liabilities never count as housing assets (#181).
      countsAsHousing: false,
      holdingId: input.liability.id,
      kind: "liability",
      label: existingRow?.label ?? input.liability.name,
      // Preserve the frozen rung for an existing row; for a newly-appearing row
      // mirror the capture path EXACTLY (buildSnapshotHoldingRows): an associated
      // debt freezes its asset's rung (resolved from the frozen asset rows like
      // the live net-worth path), an unassociated debt freezes null — so every
      // ripple and the capture produce the same row set for a date (#181).
      liquidityTier: existingRow
        ? existingRow.liquidityTier
        : input.liability.associatedAssetId
          ? rungForLiability(input.liability, assetRungById)
          : null,
      // Preserve the frozen signal for an existing row; for a newly-appearing
      // row freeze it from the same classification the figures use (#180).
      securesHousing: existingRow
        ? existingRow.securesHousing
        : securesHousingAsset(input.liability, input.housingAssetIds),
      valueMinor: ownedMinor,
    });
  }

  // A liability never moves the housing-ASSET axis; its housing/liquid effect is
  // re-derived from the frozen rows (frozen securesHousing + frozen rung) inside
  // the shared helper — never from a live securesHousingAsset / housingAssetIds
  // lookup, so a later reclassification can't drift historical figures (#181).
  return assembleRippleSnapshot({
    currency,
    frozenHoldings: input.frozenHoldings,
    rows,
    snapshot: input.snapshot,
  });
}
