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
import { addMonths } from "./amortization";
import { isHousingAsset } from "./classification";
import type { LiquidityTier } from "./classification";
import { coinCollectionValueAtDate } from "./connected-source";
import type { CoinPosition } from "./connected-source";
import type { DebtBalanceAnchor } from "./debt-balance";
import type { DecimalString } from "./decimal";
import { valueAt } from "./holding-valuation";
import type { HoldingValuationInput } from "./holding-valuation";
import type { HousingValuationAnchor } from "./housing-valuation";
import type { InvestmentOperation } from "./investment-types";
import type { ValuationCadence } from "./valuation-cadence";
import type { DebtModel, Liability, ManualAsset, Workspace } from "./workspace-types";
import type { NetWorthSnapshot, ValuedNetWorthSnapshot } from "./snapshot-types";
import { captureValuedNetWorthSnapshot, createNetWorthSnapshot } from "./snapshot-types";
import { assertSnapshotHoldingsReconcile, deriveRowAxes } from "./snapshot-holdings";
import { money } from "./money";
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
  /**
   * How the appreciation drift moves between events (ADR 0031, #394). Null/absent
   * reads as the default `step`; threaded into the appreciating valuation input so
   * a per-holding opt-in to `interpolated` reaches the housing engine.
   */
  cadence?: ValuationCadence | null;
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
  /**
   * How the modeled balance moves between events (ADR 0031, #393). Null/absent
   * reads as the default `step`; threaded into the amortized and anchored
   * valuation inputs so a per-holding opt-in to `interpolated` reaches the engine.
   */
  cadence?: ValuationCadence | null;
}

/**
 * Map a liability's debt curve to the `valueAt` input for its model — the single
 * place a curve becomes a method-specific valuation input, shared by the fresh
 * capture (`liabilityValuationInput`) and the ripple (`recalculateSnapshotFor
 * Liability`). Returns null for a null model, leaving the manual stored fallback
 * to the caller (which sources its current value differently). Exported as part
 * of the amendment seam (ADR 0028, #321): the anchor ripple
 * (`recalculateSnapshotForLiability`) dispatches the liability's curve through it.
 */
export function debtCurveValuationInput(
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
      ...(curve.cadence != null ? { cadence: curve.cadence } : {}),
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
      ...(curve.cadence != null ? { cadence: curve.cadence } : {}),
    };
  }

  return null;
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
      ...(curve?.cadence != null ? { cadence: curve.cadence } : {}),
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

function firstMarketAppraisalDate(
  curve: HousingCurveInputs | undefined,
): string | undefined {
  const appraisals = (curve?.anchors ?? [])
    .filter((anchor) => anchor.adjustsPriorCurve)
    .map((anchor) => anchor.valuationDate)
    .sort();

  return appraisals[0];
}

function assetExistsAtHistoricalDate(
  asset: ManualAsset,
  input: Pick<HistoricalValuationContext, "housingValuationByAsset" | "targetDate">,
): boolean {
  // Investments remain operation-led even when legacy data flags them as a
  // primary residence (#148). Their existence is decided by valueAt(...derived).
  if (asset.type === "investment" || !isHousingAsset(asset)) {
    return true;
  }

  const firstAppraisal = firstMarketAppraisalDate(
    input.housingValuationByAsset?.get(asset.id),
  );
  return firstAppraisal === undefined || input.targetDate >= firstAppraisal;
}

function firstBalanceAnchorDate(
  curve: DebtBalanceCurveInputs | undefined,
): string | undefined {
  const anchors = (curve?.anchors ?? []).map((anchor) => anchor.anchorDate).sort();
  return anchors[0];
}

function liabilityExistsAtHistoricalDate(input: {
  liability: Liability;
  curve: DebtBalanceCurveInputs | undefined;
  liveAssetIds: ReadonlySet<string>;
  historicalAssetIds: ReadonlySet<string>;
  targetDate: string;
}): boolean {
  const { curve, liability, targetDate } = input;

  if (
    liability.associatedAssetId !== undefined &&
    input.liveAssetIds.has(liability.associatedAssetId) &&
    !input.historicalAssetIds.has(liability.associatedAssetId)
  ) {
    return false;
  }

  if (curve?.debtModel === "amortizable" && curve.plan !== undefined) {
    return targetDate >= curve.plan.disbursementDate;
  }

  if (
    (curve?.debtModel === "revolving" || curve?.debtModel === "informal") &&
    curve.initialCapitalMinor === undefined
  ) {
    const firstAnchor = firstBalanceAnchorDate(curve);
    if (firstAnchor !== undefined && targetDate < firstAnchor) {
      return false;
    }
  }

  return true;
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
export function assembleRippleSnapshot(input: {
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
  const historicalAssetIds = new Set<string>();
  const liveAssetIds = new Set(input.assets.map((asset) => asset.id));
  const investmentDetails = new Map<string, InvestmentCaptureDetail>();

  for (const asset of input.assets) {
    if (!assetExistsAtHistoricalDate(asset, input)) continue;

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
      historicalAssetIds.add(asset.id);
      continue;
    }

    const valuation = valueAt(assetValuationInput(asset, input), input.targetDate);
    if (valuation.valueMinor === null) continue; // not held on this date

    historicalAssets.push({
      ...asset,
      currentValue: money(valuation.valueMinor, asset.currency),
    });
    historicalAssetIds.add(asset.id);

    if (valuation.units !== undefined) {
      investmentDetails.set(asset.id, {
        units: valuation.units,
        ...(valuation.unitPrice !== undefined ? { unitPrice: valuation.unitPrice } : {}),
      });
    }
  }

  const historicalLiabilities: Liability[] = [];
  for (const liability of input.liabilities) {
    const curve = input.debtBalanceByLiability?.get(liability.id);
    if (
      !liabilityExistsAtHistoricalDate({
        curve,
        historicalAssetIds,
        liability,
        liveAssetIds,
        targetDate: input.targetDate,
      })
    ) {
      continue;
    }

    const valuation = valueAt(
      liabilityValuationInput(liability, curve, input),
      input.targetDate,
    );
    historicalLiabilities.push(
      valuation.valueMinor !== null
        ? {
            ...liability,
            currentBalance: money(valuation.valueMinor, liability.currency),
          }
        : liability,
    );
  }

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
export interface ResolvedFrozenIdentity {
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
export function resolveFrozenIdentity(input: {
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

/**
 * Re-export the trigger modules' recalc functions and their input types from the
 * core (ADR 0028, #320 + #321). Splitting them into their own modules keeps the
 * core's relative-path surface byte-stable: `./historical-snapshot` still
 * resolves all six `recalculateSnapshotFor*` functions (and their
 * `Recalculate*Input` / `OwnershipRippleHolding` types) for the barrel and the
 * existing tests, while the implementations now live in the four trigger
 * modules. The barrel and the relative-path importers resolve unchanged.
 */
export { recalculateSnapshotForAsset } from "./historical-snapshot-operation-ripple";
export type { RecalculateSnapshotInput } from "./historical-snapshot-operation-ripple";
export {
  recalculateSnapshotForCoinAcquisition,
  recalculateSnapshotForConnectedValue,
} from "./historical-snapshot-position-ripple";
export type {
  RecalculateCoinAcquisitionSnapshotInput,
  RecalculateConnectedValueSnapshotInput,
} from "./historical-snapshot-position-ripple";
export {
  recalculateSnapshotForHousing,
  recalculateSnapshotForLiability,
} from "./historical-snapshot-anchor-ripple";
export type {
  RecalculateHousingSnapshotInput,
  RecalculateLiabilitySnapshotInput,
} from "./historical-snapshot-anchor-ripple";
export { recalculateSnapshotForOwnership } from "./historical-snapshot-ownership-ripple";
export type {
  OwnershipRippleHolding,
  RecalculateOwnershipSnapshotInput,
} from "./historical-snapshot-ownership-ripple";
