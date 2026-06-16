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
  rungForLiability,
  securesHousingAsset,
  tierOfAsset,
} from "./classification";
import type { LiquidityTier } from "./classification";
import { coinCollectionValueAtDate } from "./connected-source";
import type { CoinPosition } from "./connected-source";
import type { DebtBalanceAnchor } from "./debt-balance";
import type { DecimalString } from "./decimal";
import { valueAt } from "./holding-valuation";
import type { HoldingValuationInput } from "./holding-valuation";
import type { HousingValuationAnchor } from "./housing-valuation";
import type { InvestmentOperation } from "./investment-types";
import type { DebtModel, Liability, ManualAsset, Workspace } from "./workspace-types";
import type { NetWorthSnapshot, ValuedNetWorthSnapshot } from "./snapshot-types";
import { captureValuedNetWorthSnapshot, createNetWorthSnapshot } from "./snapshot-types";
import { assertSnapshotHoldingsReconcile, deriveRowAxes } from "./snapshot-holdings";
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
 * (PRD #109, slice 9; two-date model ADR 0019, #188). Boundary 0 is the
 * disbursement (the debt appears at its initial capital — "la hipoteca empieza
 * con la vivienda"); boundary `m ≥ 1` is `firstPaymentDate + (m − 1) months` (the
 * first payment, then one per month, the last at term). This drives the "one
 * snapshot per past cuota" density of the amortizable ripple — the deliberate
 * exception to ADR 0012 recognised by PRD #109. Dates on or after `targetDate`
 * are excluded (the caller never generates for today/future, and a boundary equal
 * to the target is owned by the target).
 */
export function amortizationPaymentDatesUpTo(
  plan: AmortizationPlanInput,
  targetDate: string,
): string[] {
  const dates: string[] = [];
  for (let m = 0; m <= plan.termMonths; m += 1) {
    const dateKey =
      m === 0 ? plan.disbursementDate : addMonths(plan.firstPaymentDate, m - 1);
    if (dateKey < targetDate) {
      dates.push(dateKey);
    } else if (m > 0) {
      // Boundaries are ascending from m ≥ 1; once one reaches the target, stop.
      // Boundary 0 (disbursement) can be later than boundary 1 only if the data
      // is malformed, so the m === 0 case never early-breaks.
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
   * The positions of every connected coin-collection asset, keyed by the
   * materialized asset id (ADR 0017, #167). A coin collection present here is
   * valued by **purchase-date accretion** on the target date (Σ coinValue of
   * coins acquired ≤ date), instead of the manual full-current-value basis — so a
   * snapshot freshly generated at a past date never shows the whole collection
   * before its coins were bought. An asset absent from the map keeps the stored
   * basis (no regression).
   */
  coinPositionsByAsset?: ReadonlyMap<string, readonly CoinPosition[]>;
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
  /**
   * Investment asset ids that must be valued at COST BASIS, never at the latest
   * operation price (ADR 0006, #183). Use when fresh generation knows an
   * investment had no provider/manual price — the same cost-basis fallback live
   * capture takes (units present, unitPrice absent), so the generated row never
   * jumps to a last-operation-price valuation it could not have shown that day.
   * Ignored for an asset that also has a `capturedUnitPrices` entry (a real
   * captured price always wins).
   */
  costBasisAssetIds?: ReadonlySet<string>;
}

/**
 * The exact slice of `BuildSnapshotAtDateInput` the per-holding valuation-input
 * builders read. `BuildSnapshotAtDateInput` satisfies it structurally, so the
 * fresh-capture path passes itself unchanged; the single-holding lossless
 * re-valuation (`globalHoldingValueAtDate`, #187) passes a minimal object.
 */
interface HistoricalValuationContext {
  manualValueHistory: ReadonlyMap<string, ManualValuePoint[]>;
  operationsByAsset: ReadonlyMap<string, InvestmentOperation[]>;
  housingValuationByAsset?: ReadonlyMap<string, HousingCurveInputs>;
  capturedUnitPrices?: ReadonlyMap<string, DecimalString>;
  costBasisAssetIds?: ReadonlySet<string>;
  today?: string;
  targetDate: string;
}

/** The valuation input for an asset on the historical path, by its valuation method. */
function assetValuationInput(
  asset: ManualAsset,
  input: HistoricalValuationContext,
): HoldingValuationInput {
  // Precedence matches the live capture path and the pre-dispatcher historical
  // path (type-first): an investment is valued by its operation ledger even when
  // flagged a primary residence; housing-ness only chooses the method for
  // non-investments. Reordering this with isHousingAsset would silently re-value
  // an investment-flagged-primary-residence as housing (#148 regression).
  if (asset.type === "investment") {
    const capturedUnitPrice = input.capturedUnitPrices?.get(asset.id);
    // A no-price investment values at cost basis (ADR 0006, #183) — never at the
    // latest operation price, which the dispatcher would otherwise use as a proxy.
    const atCostBasis = input.costBasisAssetIds?.has(asset.id) === true;
    return {
      assetId: asset.id,
      currency: asset.currency,
      method: "derived",
      operations: input.operationsByAsset.get(asset.id) ?? [],
      ...(capturedUnitPrice !== undefined ? { capturedUnitPrice } : {}),
      ...(atCostBasis ? { atCostBasis: true } : {}),
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
  input: Pick<HistoricalValuationContext, "manualValueHistory">,
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
 * The single place a ripple's recomputed rows become a five-figure summary,
 * reconciled, and wrapped in a snapshot (#181 + #181-completion). Every
 * `recalculate*` function funnels through here so the breakdown axes
 * (`liquidNetWorth`, `housingEquity`, `totalNetWorth`) are RE-DERIVED from the
 * frozen rows the same way `calculateNetWorth` derives them from live holdings —
 * never hand-adjusted by a per-holding delta whose axis is chosen from live
 * identity. This collapses the four near-duplicate scaffolds (row construction +
 * figure math + reconcile) and removes the axis-by-axis drift.
 *
 * All five axes are now fully self-classifying from the frozen flags on each row:
 *   grossAssets   = Σ asset rows
 *   debts         = Σ liability rows
 *   totalNetWorth = grossAssets − debts
 *   liquidNetWorth= Σ(liquid-rung asset rows) − Σ(liquid, non-housing-securing liability rows)
 *   housingEquity = Σ(countsAsHousing asset rows) − Σ(securesHousing liability rows)
 * No live `isHousingAsset` / `housingAssetIds` lookup is needed anywhere.
 *
 * Returns null when no holdings remain (the caller drops the snapshot).
 */
function assembleRippleSnapshot(input: {
  snapshot: NetWorthSnapshot;
  currency: string;
  /** The original frozen rows, before the operated holding was swapped out. */
  frozenHoldings: readonly SnapshotHoldingRow[];
  /** The rows after the swap (frozen survivors + the recomputed row, if any). */
  rows: SnapshotHoldingRow[];
}): ValuedNetWorthSnapshot | null {
  if (input.rows.length === 0) return null;

  // Safety net (#181): assert that the INPUT snapshot's all five row-derivable
  // figures reconcile with the ORIGINAL frozen rows before producing a ripple.
  // A snapshot that imputed a value to the wrong axis fails here and never
  // propagates corruption to the next ripple in the chain.
  assertSnapshotHoldingsReconcile(input.frozenHoldings, {
    debtsMinor: input.snapshot.debts.amountMinor,
    grossAssetsMinor: input.snapshot.grossAssets.amountMinor,
    housingEquityMinor: input.snapshot.housingEquity.amountMinor,
    liquidNetWorthMinor: input.snapshot.liquidNetWorth.amountMinor,
    totalNetWorthMinor: input.snapshot.totalNetWorth.amountMinor,
  });

  // All five axes derived from the NEW row set — fully frozen, no live lookups.
  const axes = deriveRowAxes(input.rows);
  const currency = input.currency;
  const grossAssetsMinor = axes.grossAssetsMinor;
  const debtsMinor = axes.debtsMinor;
  const totalNetWorthMinor = grossAssetsMinor - debtsMinor;
  const liquidNetWorthMinor = axes.liquidAssetsMinor - axes.liquidDebtsMinor;
  const housingEquityMinor = axes.housingAssetsMinor - axes.housingDebtsMinor;

  const summary = {
    debts: { amountMinor: debtsMinor, currency },
    grossAssets: { amountMinor: grossAssetsMinor, currency },
    housingEquity: { amountMinor: housingEquityMinor, currency },
    liquidNetWorth: { amountMinor: liquidNetWorthMinor, currency },
    scopeId: input.snapshot.scopeId,
    totalNetWorth: { amountMinor: totalNetWorthMinor, currency },
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

  assertSnapshotHoldingsReconcile(input.rows, {
    debtsMinor,
    grossAssetsMinor,
    housingEquityMinor,
    liquidNetWorthMinor,
    totalNetWorthMinor,
  });

  return { holdings: input.rows, snapshot };
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
    // A connected coin collection is valued by purchase-date accretion (ADR 0017),
    // not the stored full-current-value basis — so a snapshot generated at a past
    // date only carries the coins acquired by then. A zero sum means no dated coin
    // was held yet → omit the holding (it was not held), matching the #167 ripple.
    const coinPositions = input.coinPositionsByAsset?.get(asset.id);
    if (coinPositions !== undefined) {
      const coinValueMinor = coinCollectionValueAtDate(coinPositions, input.targetDate);
      if (coinValueMinor === 0) continue;
      historicalAssets.push({
        ...asset,
        currentValue: money(coinValueMinor, asset.currency),
      });
      continue;
    }

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

/**
 * One snapshot's frozen capture of a holding's classification (#242): the
 * liquidity tier and the two housing flags that were frozen on its row at some
 * date, decoupled from the snapshot's value. Supplied to a recalc by the db
 * layer (a targeted read of one holding's frozen rows across every snapshot)
 * so the domain can recover the holding's CONTEMPORANEOUS frozen identity when
 * it must generate a brand-new row at a date/scope that never carried one —
 * instead of leaking the holding's LIVE identity into frozen history (ADR 0008).
 */
export interface FrozenIdentityCapture {
  /** The YYYY-MM-DD date the classification was frozen at. */
  dateKey: string;
  liquidityTier: LiquidityTier | null;
  countsAsHousing: boolean;
  securesHousing: boolean;
}

/** A holding's frozen classification for one recalc, resolved by `resolveFrozenIdentity`. */
interface ResolvedFrozenIdentity {
  liquidityTier: LiquidityTier | null;
  countsAsHousing: boolean;
  securesHousing: boolean;
}

/**
 * The single frozen-vs-live identity seam (#242). Resolves the FROZEN
 * classification (liquidity tier + the two housing flags) a recalc must freeze
 * onto a holding's row, in ONE place rather than re-read independently by each
 * recalc path. Precedence:
 *
 *  1. the value frozen on THIS snapshot's `existingRow` (preserves the #180/#181
 *     guarantee that an existing row is never reclassified);
 *  2. else the holding's frozen classification recovered from its rows in OTHER
 *     snapshots — the capture on-or-before `targetDate` (the contemporaneous
 *     freeze), else the nearest capture after it. A holding's tier/housing is
 *     frozen identically across captures until a reclassification, so this
 *     recovers the contemporaneous frozen identity for a brand-new row;
 *  3. else (no frozen capture exists in ANY snapshot — a genuinely first-ever
 *     row) the LIVE classification. Not a bug: there is no frozen record to
 *     recover, so live is the only available basis (matches the capture path).
 */
function resolveFrozenIdentity(input: {
  existingRow: SnapshotHoldingRow | undefined;
  frozenIdentity: readonly FrozenIdentityCapture[];
  targetDate: string;
  live: ResolvedFrozenIdentity;
}): ResolvedFrozenIdentity {
  if (input.existingRow !== undefined) {
    return {
      countsAsHousing: input.existingRow.countsAsHousing,
      liquidityTier: input.existingRow.liquidityTier,
      securesHousing: input.existingRow.securesHousing,
    };
  }

  // The contemporaneous frozen capture: the latest on-or-before the target date,
  // else (none on-or-before) the earliest after it. Both directions are picked
  // off the same captures, sorted ascending by date once.
  const sorted = [...input.frozenIdentity].sort((a, b) =>
    a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0,
  );
  const onOrBefore = sorted.filter((c) => c.dateKey <= input.targetDate).at(-1);
  const contemporaneous = onOrBefore ?? sorted.at(0);
  if (contemporaneous !== undefined) {
    return {
      countsAsHousing: contemporaneous.countsAsHousing,
      liquidityTier: contemporaneous.liquidityTier,
      securesHousing: contemporaneous.securesHousing,
    };
  }

  return input.live;
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
  /**
   * This asset's frozen classification captures across every snapshot (#242).
   * Lets a row newly generated at a date this snapshot never carried recover the
   * asset's CONTEMPORANEOUS frozen tier instead of leaking the live one. Omitted
   * → the seam falls back to live (no recovery basis), preserving old behaviour.
   */
  frozenIdentity?: readonly FrozenIdentityCapture[];
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
  const wasCapturedAtCostBasis =
    existingRow?.units !== undefined && existingRow.unitPrice === undefined;
  const valuation = valueAt(
    {
      assetId: input.asset.id,
      currency: input.asset.currency,
      method: "derived",
      operations: input.operations,
      ...(existingRow?.unitPrice !== undefined
        ? { capturedUnitPrice: existingRow.unitPrice }
        : {}),
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

/**
 * The inputs needed to re-value ONE holding's GLOBAL (100%, un-allocated) value
 * on a past date through the same valuation dispatcher the fresh capture uses
 * (#187). Mirrors the per-holding slice of `BuildSnapshotAtDateInput`: an asset
 * is valued by its operation ledger (investments), housing curve (real estate),
 * or last-known-value basis; a liability by its debt curve or last-known balance.
 */
export interface GlobalHoldingValueInput {
  /** The holding identity (asset or liability) carrying its current basis. */
  holding:
    | { kind: "asset"; asset: ManualAsset }
    | { kind: "liability"; liability: Liability };
  /** Every operation for the asset (investments); empty/omitted otherwise. */
  operations?: readonly InvestmentOperation[];
  /** The asset's housing curve (real estate); omitted for non-housing. */
  housingCurve?: HousingCurveInputs;
  /** The liability's debt-balance curve; omitted for a no-model liability. */
  debtCurve?: DebtBalanceCurveInputs;
  /** Audit history of manual values/balances for this holding (asc by date). */
  manualValueHistory?: readonly ManualValuePoint[];
  /**
   * The unit price the snapshot already captured for this asset that day, if any
   * (investments). Honored so the re-valued global matches the price the frozen
   * row used — never a later operation price the snapshot could not have shown.
   */
  capturedUnitPrice?: DecimalString;
  /** True when the asset was captured at COST BASIS that day (ADR 0006, #183). */
  atCostBasis?: boolean;
  /** "Today" as YYYY-MM-DD — forwarded to the housing curve for extrapolation. */
  today?: string;
}

/**
 * Re-derive ONE holding's GLOBAL (100%, un-allocated) value on `targetDate` from
 * its curve / operations / stored basis — the SAME lossless source
 * `buildSnapshotAtDate` values it from (#187). This replaces dividing the rounded
 * household snapshot row by its combined share to recover the global: that
 * division cannot invert allocation rounding, so it drifts ±1–2 minor units for a
 * holding co-owned with a non-member (the household share < 100%). Re-valuing
 * recovers the value losslessly while touching ONLY the value — never a live
 * identity/classification FK into frozen history (ADR 0008).
 *
 * Returns null when the holding was not held on that date (e.g. an investment
 * before its first operation or once fully sold) — the caller skips re-weighting.
 */
export function globalHoldingValueAtDate(
  input: GlobalHoldingValueInput,
  targetDate: string,
): number | null {
  const { holding } = input;
  const holdingId = holding.kind === "asset" ? holding.asset.id : holding.liability.id;
  const manualValueHistory: ReadonlyMap<string, ManualValuePoint[]> =
    input.manualValueHistory !== undefined
      ? new Map([[holdingId, [...input.manualValueHistory]]])
      : new Map();

  const valuationInput: HoldingValuationInput =
    holding.kind === "asset"
      ? assetValuationInput(holding.asset, {
          manualValueHistory,
          operationsByAsset: new Map([[holding.asset.id, [...(input.operations ?? [])]]]),
          targetDate,
          ...(input.capturedUnitPrice !== undefined
            ? {
                capturedUnitPrices: new Map([
                  [holding.asset.id, input.capturedUnitPrice],
                ]),
              }
            : {}),
          ...(input.atCostBasis === true
            ? { costBasisAssetIds: new Set([holding.asset.id]) }
            : {}),
          ...(input.housingCurve !== undefined
            ? {
                housingValuationByAsset: new Map([
                  [holding.asset.id, input.housingCurve],
                ]),
              }
            : {}),
          ...(input.today !== undefined ? { today: input.today } : {}),
        })
      : liabilityValuationInput(holding.liability, input.debtCurve, {
          manualValueHistory,
        });

  return valueAt(valuationInput, targetDate).valueMinor;
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
