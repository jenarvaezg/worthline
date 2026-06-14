/**
 * Historical snapshot reconstruction (ADR 0012, PRD #107).
 *
 * Pure module: given the current holdings' identities, the full operation
 * ledger, the audit history of manual values, and a target past date, it
 * reconstructs the valued portfolio *as it was* on that date and produces a
 * snapshot for it.
 *
 * Resolution rules: reconstruction builds a per-holding HoldingValuationInput
 * (assetValuationInput / liabilityValuationInput) and values it on the target
 * date through holding-valuation's `valueAt`, which dispatches on the holding's
 * valuation method (ADR 0014). `stored` is the manual last-known-value ≤ date
 * basis, falling back to the current value; `derived` folds the operation ledger
 * to that date (omitted before its first operation, or once fully sold);
 * `appreciating`, `amortized` and `anchored` value the housing / debt curves
 * (PRD #108/#109).
 *
 * The actual snapshot + holding rows are produced by the existing
 * `captureValuedNetWorthSnapshot`, so the reconciliation invariant (ADR 0008)
 * and the five headline figures stay identical to the daily-capture path.
 */

import type {
  AmortizationPlanInput,
  EarlyRepayment,
  InterestRateRevision,
} from "./amortization";
import {
  isHousingAsset,
  isLiquid,
  rungForLiability,
  securesHousingAsset,
  tierOfAsset,
} from "./classification";
import type { DebtBalanceAnchor } from "./debt-balance";
import type { DecimalString } from "./decimal";
import { valueAt } from "./holding-valuation";
import type { HoldingValuationInput } from "./holding-valuation";
import type { HousingValuationAnchor } from "./housing-valuation";
import type { InvestmentOperation } from "./investment-types";
import type { DebtModel, Liability, ManualAsset, Workspace } from "./workspace-types";
import type { NetWorthSnapshot, ValuedNetWorthSnapshot } from "./snapshot-types";
import { captureValuedNetWorthSnapshot, createNetWorthSnapshot } from "./snapshot-types";
import { assertSnapshotHoldingsReconcile } from "./snapshot-holdings";
import { money } from "./money";
import { resolveScopeMemberIds } from "./scope";
import { allocateScopedHolding } from "./scope-allocation";
import type { InvestmentCaptureDetail, SnapshotHoldingRow } from "./snapshot-holdings";
import type { ManualValuePoint } from "./value-history";

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
 * The debt-balance curve inputs of one liability (PRD #109, slice 9): its debt
 * model and the model-specific data needed to value the outstanding balance on
 * any past date via the pure `debtBalanceAtDate` dispatcher. A liability with an
 * entry here AND a non-null `debtModel` is valued from its curve in historical
 * reconstruction instead of the manual last-known-value basis. A liability
 * absent from the map (or carrying a null model) keeps the last-known basis —
 * no regression for liabilities without a model (PRD #109). The shape mirrors
 * `HousingCurveInputs` for assets.
 */
export interface DebtBalanceCurveInputs {
  /** How the liability is modelled. Null → no curve, last-known-value basis. */
  debtModel: DebtModel | null;
  /** Balance anchors (any order) for a revolving/informal liability. */
  anchors?: readonly DebtBalanceAnchor[];
  /** The amortization plan for an amortizable liability. */
  plan?: AmortizationPlanInput;
  /** Rate revisions for an amortizable liability (any order). */
  revisions?: readonly InterestRateRevision[];
  /** Early repayments for an amortizable liability (any order). */
  earlyRepayments?: readonly EarlyRepayment[];
  /** Initial capital for an informal liability, integer minor units. */
  initialCapitalMinor?: number;
  /** The liability's current stored balance, integer minor units (the fallback). */
  currentBalanceMinor: number;
}

/**
 * Map a liability's debt curve to the `valueAt` input for its model — the single
 * place a curve becomes a method-specific valuation input, shared by the fresh
 * capture (`liabilityValuationInput`) and the ripple (`recalculateSnapshotFor
 * Liability`). Returns null for a null model, leaving the manual stored fallback
 * to the caller (which sources its current value differently).
 */
function debtCurveValuationInput(
  curve: DebtBalanceCurveInputs,
): HoldingValuationInput | null {
  if (curve.debtModel === "amortizable") {
    return {
      currentBalanceMinor: curve.currentBalanceMinor,
      method: "amortized",
      ...(curve.plan !== undefined ? { plan: curve.plan } : {}),
      ...(curve.revisions !== undefined ? { revisions: curve.revisions } : {}),
      ...(curve.earlyRepayments !== undefined
        ? { earlyRepayments: curve.earlyRepayments }
        : {}),
    };
  }

  if (curve.debtModel === "revolving" || curve.debtModel === "informal") {
    return {
      currentBalanceMinor: curve.currentBalanceMinor,
      debtModel: curve.debtModel,
      method: "anchored",
      ...(curve.anchors !== undefined ? { anchors: curve.anchors } : {}),
      ...(curve.initialCapitalMinor !== undefined
        ? { initialCapitalMinor: curve.initialCapitalMinor }
        : {}),
    };
  }

  return null;
}

/** Last calendar day of the given year/month (1-based month). */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The YYYY-MM-DD `count` whole months after `dateKey`, day clamped to month end. */
function addMonths(dateKey: string, count: number): string {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const day = Number(dateKey.slice(8, 10));
  const zeroBased = month - 1 + count;
  const newYear = year + Math.floor(zeroBased / 12);
  const newMonth = (zeroBased % 12) + 1;
  const clampedDay = Math.min(day, lastDayOfMonth(newYear, newMonth));
  const mm = String(newMonth).padStart(2, "0");
  const dd = String(clampedDay).padStart(2, "0");
  return `${newYear}-${mm}-${dd}`;
}

/**
 * The amortizable payment-boundary dates strictly before `targetDate`, ascending
 * (PRD #109, slice 9). Each boundary is `startDate + m months` for m in
 * [0..termMonths] (the start date itself is the first, the final payment the
 * last). This drives the "one snapshot per past cuota" density of the
 * amortizable ripple — the deliberate exception to ADR 0012 recognised by PRD
 * #109. Dates on or after `targetDate` are excluded (the caller never generates
 * for today/future, and a boundary equal to the target is owned by the target).
 */
export function amortizationPaymentDatesUpTo(
  plan: AmortizationPlanInput,
  targetDate: string,
): string[] {
  const dates: string[] = [];
  for (let m = 0; m <= plan.termMonths; m += 1) {
    const dateKey = addMonths(plan.startDate, m);
    if (dateKey < targetDate) {
      dates.push(dateKey);
    } else {
      break;
    }
  }
  return dates;
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
   * Debt-balance curve inputs of every liability with a debt model, keyed by
   * liability id (PRD #109). A liability present here with a non-null model is
   * valued via the pure `debtBalanceAtDate` dispatcher on the target date; one
   * absent (or with a null model) keeps the manual last-known-value basis (no
   * regression). The liability path's analogue of `housingValuationByAsset`.
   */
  debtBalanceByLiability?: ReadonlyMap<string, DebtBalanceCurveInputs>;
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

/** The valuation input for an asset on the historical path, by its valuation method. */
function assetValuationInput(
  asset: ManualAsset,
  input: BuildSnapshotAtDateInput,
): HoldingValuationInput {
  // Precedence matches the live capture path and the pre-dispatcher historical
  // path (type-first): an investment is valued by its operation ledger even when
  // flagged a primary residence; housing-ness only chooses the method for
  // non-investments. Reordering this with isHousingAsset would silently re-value
  // an investment-flagged-primary-residence as housing (#148 regression).
  if (asset.type === "investment") {
    const capturedUnitPrice = input.capturedUnitPrices?.get(asset.id);
    return {
      assetId: asset.id,
      currency: asset.currency,
      method: "derived",
      operations: input.operationsByAsset.get(asset.id) ?? [],
      ...(capturedUnitPrice !== undefined ? { capturedUnitPrice } : {}),
    };
  }

  const valueHistory = input.manualValueHistory.get(asset.id);

  if (isHousingAsset(asset)) {
    const curve = input.housingValuationByAsset?.get(asset.id);
    const rate = curve?.annualAppreciationRate;
    return {
      anchors: curve?.anchors ?? [],
      currentValueMinor: curve?.currentValueMinor ?? asset.currentValue.amountMinor,
      method: "appreciating",
      today: input.today ?? input.targetDate,
      // Mirror the curve-active guard (rate "" is not a curve), so the fallback
      // path can never source currentValueMinor differently than the old code.
      ...(rate != null && rate !== "" ? { annualAppreciationRate: rate } : {}),
      ...(valueHistory !== undefined ? { valueHistory } : {}),
    };
  }

  return {
    currentValueMinor: asset.currentValue.amountMinor,
    method: "stored",
    ...(valueHistory !== undefined ? { valueHistory } : {}),
  };
}

/** The valuation input for a liability on the historical path, by its valuation method. */
function liabilityValuationInput(
  liability: Liability,
  curve: DebtBalanceCurveInputs | undefined,
  input: BuildSnapshotAtDateInput,
): HoldingValuationInput {
  const curveInput = curve ? debtCurveValuationInput(curve) : null;
  if (curveInput) return curveInput;

  const valueHistory = input.manualValueHistory.get(liability.id);
  return {
    currentValueMinor: liability.currentBalance.amountMinor,
    method: "stored",
    ...(valueHistory !== undefined ? { valueHistory } : {}),
  };
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
    const valuation = valueAt(assetValuationInput(asset, input), input.targetDate);
    if (valuation.valueMinor === null) continue; // not held on this date

    historicalAssets.push({
      ...asset,
      currentValue: money(valuation.valueMinor, asset.currency),
    });

    if (valuation.units !== undefined) {
      investmentDetails.set(asset.id, {
        units: valuation.units,
        ...(valuation.unitPrice !== undefined ? { unitPrice: valuation.unitPrice } : {}),
      });
    }
  }

  const historicalLiabilities: Liability[] = input.liabilities.map((liability) => {
    const curve = input.debtBalanceByLiability?.get(liability.id);
    const valuation = valueAt(
      liabilityValuationInput(liability, curve, input),
      input.targetDate,
    );
    return valuation.valueMinor !== null
      ? { ...liability, currentBalance: money(valuation.valueMinor, liability.currency) }
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

  // Recompute the operated asset's row at the snapshot's date via the same
  // dispatcher the fresh capture uses (#150 carry-over): `derived` folds the
  // ledger to the date, keeping the unit price the snapshot already captured
  // (else the last operation price ≤ the date), and yields null when the asset
  // was not held then — byte-identical to the positions math this used to inline.
  let newRow: SnapshotHoldingRow | undefined;
  const valuation = valueAt(
    {
      assetId: input.asset.id,
      currency: input.asset.currency,
      method: "derived",
      operations: input.operations,
      ...(existingRow?.unitPrice !== undefined
        ? { capturedUnitPrice: existingRow.unitPrice }
        : {}),
    },
    targetDate,
  );

  if (valuation.valueMinor !== null) {
    const { ownedMinor, totalShareBps } = allocateScopedHolding(valuation.valueMinor, {
      ownership: input.asset.ownership,
      scopeMemberIds,
    });

    if (totalShareBps > 0) {
      newRow = {
        holdingId: input.asset.id,
        kind: "asset",
        label: existingRow?.label ?? input.asset.name,
        liquidityTier: existingRow?.liquidityTier ?? tierOfAsset(input.asset),
        valueMinor: ownedMinor,
        ...(valuation.units !== undefined ? { units: valuation.units } : {}),
        ...(valuation.unitPrice !== undefined ? { unitPrice: valuation.unitPrice } : {}),
      };
      rows.push(newRow);
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
        (isHousingAsset(input.asset) ? deltaMinor : 0),
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
        ...(points !== undefined ? { valueHistory: points } : {}),
      },
      targetDate,
    ).valueMinor ?? input.curve.currentValueMinor;

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
        (isHousingAsset(input.asset) ? deltaMinor : 0),
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

  // What the debt's change moves (same basis as calculateNetWorth): a debt
  // securing a housing asset nets housing equity; otherwise, if it sits on a
  // liquid rung, it nets liquid net worth. The rung resolves from the frozen
  // asset rows even when the frozen liability row's own tier is null.
  const assetRungById = new Map(
    rows
      .filter((row) => row.kind === "asset" && row.liquidityTier !== null)
      .map((row) => [row.holdingId, row.liquidityTier!] as const),
  );
  const securesHousing = securesHousingAsset(input.liability, input.housingAssetIds);
  const affectsLiquid =
    !securesHousing && isLiquid(rungForLiability(input.liability, assetRungById));

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

  let newRow: SnapshotHoldingRow | undefined;
  if (totalShareBps > 0 && ownedMinor !== 0) {
    newRow = {
      holdingId: input.liability.id,
      kind: "liability",
      label: existingRow?.label ?? input.liability.name,
      liquidityTier: existingRow ? existingRow.liquidityTier : null,
      valueMinor: ownedMinor,
    };
    rows.push(newRow);
  }

  if (rows.length === 0) return null;

  const deltaMinor = (newRow?.valueMinor ?? 0) - (existingRow?.valueMinor ?? 0);

  const summary = {
    debts: {
      amountMinor: input.snapshot.debts.amountMinor + deltaMinor,
      currency,
    },
    grossAssets: {
      amountMinor: input.snapshot.grossAssets.amountMinor,
      currency,
    },
    housingEquity: {
      amountMinor:
        input.snapshot.housingEquity.amountMinor + (securesHousing ? -deltaMinor : 0),
      currency,
    },
    liquidNetWorth: {
      amountMinor:
        input.snapshot.liquidNetWorth.amountMinor + (affectsLiquid ? -deltaMinor : 0),
      currency,
    },
    scopeId: input.snapshot.scopeId,
    totalNetWorth: {
      amountMinor: input.snapshot.totalNetWorth.amountMinor - deltaMinor,
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
   * snapshot's date — i.e. the household-scope frozen value, which is invariant
   * under an ownership-split edit. Positive; for a liability it is the
   * outstanding balance. The new per-scope row is this value re-weighted by the
   * new split (`allocateScopedHolding`).
   */
  globalValueMinor: number;
  workspace: Workspace;
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

  let newRow: SnapshotHoldingRow | undefined;
  if (totalShareBps > 0 && ownedMinor !== 0) {
    newRow = {
      holdingId,
      kind: holding.kind,
      label:
        existingRow?.label ??
        (holding.kind === "asset" ? holding.asset.name : holding.liability.name),
      liquidityTier: existingRow
        ? existingRow.liquidityTier
        : holding.kind === "asset"
          ? tierOfAsset(holding.asset)
          : null,
      valueMinor: ownedMinor,
      ...(existingRow?.units !== undefined ? { units: existingRow.units } : {}),
      ...(existingRow?.unitPrice !== undefined
        ? { unitPrice: existingRow.unitPrice }
        : {}),
    };
    rows.push(newRow);
  }

  if (rows.length === 0) return null;

  const deltaMinor = (newRow?.valueMinor ?? 0) - (existingRow?.valueMinor ?? 0);

  let summary;
  if (holding.kind === "asset") {
    // An asset moves gross + total; housing equity when it is the home; liquid
    // when it sits on a liquid rung — same basis as recalculateSnapshotForAsset.
    const tier = existingRow?.liquidityTier ?? newRow?.liquidityTier ?? null;
    const movesHousing = isHousingAsset(holding.asset);
    summary = {
      debts: { amountMinor: input.snapshot.debts.amountMinor, currency },
      grossAssets: {
        amountMinor: input.snapshot.grossAssets.amountMinor + deltaMinor,
        currency,
      },
      housingEquity: {
        amountMinor:
          input.snapshot.housingEquity.amountMinor + (movesHousing ? deltaMinor : 0),
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
  } else {
    // A liability moves debts (+delta) and total (-delta); housing equity when it
    // secures the home, else liquid when it sits on a liquid rung — same basis as
    // recalculateSnapshotForLiability (the rung resolves from frozen asset rows).
    const assetRungById = new Map(
      rows
        .filter((row) => row.kind === "asset" && row.liquidityTier !== null)
        .map((row) => [row.holdingId, row.liquidityTier!] as const),
    );
    const securesHousing = securesHousingAsset(
      holding.liability,
      holding.housingAssetIds,
    );
    const affectsLiquid =
      !securesHousing && isLiquid(rungForLiability(holding.liability, assetRungById));
    summary = {
      debts: { amountMinor: input.snapshot.debts.amountMinor + deltaMinor, currency },
      grossAssets: { amountMinor: input.snapshot.grossAssets.amountMinor, currency },
      housingEquity: {
        amountMinor:
          input.snapshot.housingEquity.amountMinor + (securesHousing ? -deltaMinor : 0),
        currency,
      },
      liquidNetWorth: {
        amountMinor:
          input.snapshot.liquidNetWorth.amountMinor + (affectsLiquid ? -deltaMinor : 0),
        currency,
      },
      scopeId: input.snapshot.scopeId,
      totalNetWorth: {
        amountMinor: input.snapshot.totalNetWorth.amountMinor - deltaMinor,
        currency,
      },
    };
  }

  const ownershipSnapshot = createNetWorthSnapshot({
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

  return { holdings: rows, snapshot: ownershipSnapshot };
}
