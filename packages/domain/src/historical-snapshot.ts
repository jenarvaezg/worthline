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
  BalanceRebaselineInput,
  EarlyRepayment,
  InterestRateRevision,
} from "./amortization";
import type { LiquidityTier } from "./classification";
import {
  isHousingAsset,
  rungForLiability,
  securesHousingAsset,
  tierOfAsset,
} from "./classification";
import type { CoinPosition } from "./connected-source";
import { coinCollectionValueAtDate } from "./connected-source";
import type { DebtBalanceAnchor } from "./debt-balance";
import type { DecimalString } from "./decimal";
import type { HoldingValuationInput } from "./holding-valuation";
import { valueAt } from "./holding-valuation";
import type { HousingValuationAnchor } from "./housing-valuation";
import type { InvestmentOperation } from "./investment-types";
import { money } from "./money";
import { resolveScopeMemberIds } from "./scope";
import type { ScopedHolding } from "./scope-allocation";
import { allocateScopedHolding } from "./scope-allocation";
import type {
  InvestmentCaptureDetail,
  SnapshotHoldingKind,
  SnapshotHoldingRow,
  SnapshotPositionInput,
  SnapshotPositionRow,
} from "./snapshot-holdings";
import { assertSnapshotHoldingsReconcile, deriveRowAxes } from "./snapshot-holdings";
import type { NetWorthSnapshot, ValuedNetWorthSnapshot } from "./snapshot-types";
import { captureValuedNetWorthSnapshot, createNetWorthSnapshot } from "./snapshot-types";
import type { ValuationCadence } from "./valuation-cadence";
import type { ManualValuePoint } from "./value-history";
import type {
  DebtModel,
  Liability,
  ManualAsset,
  OwnershipShare,
  Workspace,
} from "./workspace-types";

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
  /** Current-state re-baselines for an amortizable liability. */
  balanceRebaselines?: readonly BalanceRebaselineInput[];
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
      ...(curve.balanceRebaselines !== undefined
        ? { balanceRebaselines: curve.balanceRebaselines }
        : {}),
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

/**
 * The amortizable start date the membership predicate reads (#1438): the first
 * `startsAtBaseline`, else the earliest re-baseline, else the plan's
 * disbursement — exported so the preflight and the data-quality signal answer
 * «¿cuándo empieza L?» with the SAME rule the predicate applies, never a
 * re-implementation that can drift.
 */
export function amortizableLiabilityStartDate(
  curve: DebtBalanceCurveInputs | undefined,
): string | undefined {
  const startingBaseline = (curve?.balanceRebaselines ?? [])
    .filter((fact) => fact.startsAtBaseline)
    .map((fact) => fact.baselineDate)
    .sort()[0];
  if (startingBaseline !== undefined) return startingBaseline;

  const firstRebaseline = (curve?.balanceRebaselines ?? [])
    .map((fact) => fact.baselineDate)
    .sort()[0];
  if (curve?.plan === undefined) return firstRebaseline;
  if (firstRebaseline === undefined) return curve.plan.disbursementDate;
  return curve.plan.disbursementDate < firstRebaseline
    ? curve.plan.disbursementDate
    : firstRebaseline;
}

/**
 * The rung a HOUSING-securing debt freezes, or null when it secures nothing that
 * is housing — leaving the associated-asset lookup to answer (#1436).
 *
 * `securesHousingAsset` already answers the housing question from the live housing
 * classification; this reads the rung off the same fact so the two can never
 * disagree on one row (a `securesHousing: true` on the `cash` rung).
 */
function housingSecuringRung(
  liability: Liability,
  housingAssetIds: ReadonlySet<string>,
): LiquidityTier | null {
  return securesHousingAsset(liability, housingAssetIds) ? "housing" : null;
}

/**
 * Whether a liability belongs in the snapshot at a historical date.
 *
 * A debt exists by ITS OWN dated facts — its plan/baseline date (ADR 0056: history
 * starts when truth starts) or its first balance anchor — and NEVER by whether the
 * asset it secures happens to be valued on that date (#1436). The old rule dropped
 * an associated debt whose asset had no historical row, which erased the mortgage
 * from all 256 points a real user had just reconstructed: his loan starts in 2004
 * and the flat that secures it has appraisals only from 2026. It also made the same
 * date carry the debt or not depending on how its snapshot was born — the
 * recalculation path (`recalculateSnapshotForLiability`) never applied that rule.
 * Now both paths answer this question the same way.
 *
 * The cost of keeping the debt is a housing equity that can go negative where the
 * home is not valued yet. That is the honest reading (the loan was real; what is
 * missing is the home's value, not the home) and it is what the recalculated
 * snapshots already showed. What it must NOT do is leak onto the liquid axis:
 * `classificationAssets` keeps such a debt on its home's rung (see the capture call
 * below).
 *
 * Exported so the reconstruction preflight and recalc call the SAME predicate
 * generate already uses (#1438) — never a re-implementation that can drift.
 */
export function liabilityExistsAtHistoricalDate(input: {
  liability: Liability;
  curve: DebtBalanceCurveInputs | undefined;
  targetDate: string;
}): boolean {
  const { curve, targetDate } = input;

  if (curve?.debtModel === "amortizable") {
    const startDate = amortizableLiabilityStartDate(curve);
    return startDate === undefined || targetDate >= startDate;
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
 * How many of `dates` a generate would persist WITHOUT this liability (#1438).
 * The reconstruction card reads `missing === total` as "do not offer Confirmar"
 * and a partial miss as a warning; it never redraws the SVG from this.
 */
export interface DebtSnapshotMembership {
  total: number;
  missing: number;
  startDate?: string;
}

export function debtSnapshotMembership(input: {
  dates: readonly string[];
  liability: Liability;
  curve: DebtBalanceCurveInputs | undefined;
}): DebtSnapshotMembership {
  const startDate =
    input.curve?.debtModel === "amortizable"
      ? amortizableLiabilityStartDate(input.curve)
      : undefined;
  let missing = 0;
  for (const targetDate of input.dates) {
    if (
      !liabilityExistsAtHistoricalDate({
        curve: input.curve,
        liability: input.liability,
        targetDate,
      })
    ) {
      missing += 1;
    }
  }
  return {
    missing,
    total: input.dates.length,
    ...(startDate === undefined ? {} : { startDate }),
  };
}

/** The sentence a zero-of-N generate must say — preflight and the ripple throw. */
export function debtMissingFromAllGeneratedMessage(count: number): string {
  return `Ninguno de los ${count} puntos escribirá esta deuda en el histórico: no existiría en esas fechas.`;
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
    // A frozen snapshot was captured in the base currency, so there is nothing left
    // unconverted to report (#1065) — the FX guard applies only to live aggregation.
    fxExcluded: [],
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

  const historicalLiabilities: Liability[] = [];
  for (const liability of input.liabilities) {
    const curve = input.debtBalanceByLiability?.get(liability.id);
    if (
      !liabilityExistsAtHistoricalDate({
        curve,
        liability,
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
    // A debt is classified against the LIVE assets, not against the ones valued on
    // this date (#1436): a mortgage kept while its home has no valuation yet nets
    // against housing equity — where a reader looks for it — instead of dropping to
    // the `cash` rung and inventing a hole in the liquid net worth.
    classificationAssets: input.assets,
    id: input.id,
    investmentDetails,
    liabilities: historicalLiabilities,
    // The units held ON THE TARGET DATE, so this snapshot's warnings answer the
    // question as of its own date (#1364): a holding whose closing sell left
    // sub-unit dust by then asks for no provider symbol, while an earlier date —
    // when the pending task WAS real — still freezes it. Read off the details
    // this function just derived, so it is contemporaneous by construction; a
    // fully-sold position never gets here at all (`valueAt` reports "not held"
    // and the holding is omitted above).
    netUnitsByAssetId: new Map(
      [...investmentDetails].map(([assetId, detail]) => [assetId, detail.units]),
    ),
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
  // else (none on-or-before) the earliest overall. Resolved in a single O(n) pass
  // instead of a sort + filter (#447), preserving the old stable-sort tie-break:
  // among equal dateKeys, onOrBefore keeps the LAST in input order (matches
  // .at(-1)), earliest keeps the FIRST (matches .at(0)).
  let onOrBefore: FrozenIdentityCapture | undefined;
  let earliest: FrozenIdentityCapture | undefined;
  for (const capture of input.frozenIdentity) {
    if (earliest === undefined || capture.dateKey < earliest.dateKey) {
      earliest = capture;
    }
    if (
      capture.dateKey <= input.targetDate &&
      (onOrBefore === undefined || capture.dateKey >= onOrBefore.dateKey)
    ) {
      onOrBefore = capture;
    }
  }
  const contemporaneous = onOrBefore ?? earliest;
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
 * The amendment seam (ADR 0028, revised #1027). Every `recalculateSnapshotFor*`
 * function below swaps ONE holding's row on an already-frozen snapshot and
 * re-derives the five headline figures, preserving every other frozen row
 * verbatim (ADR 0012, ADR 0008). They funnel through the shared seam defined
 * above — `resolveFrozenIdentity` (the single frozen-vs-live identity seam,
 * #242), `allocateScopedHolding`, and `assembleRippleSnapshot` (the
 * row-reconcile-and-capture seam, #181) — plus `debtCurveValuationInput` for the
 * curve triggers. They were briefly split into four `historical-snapshot-*-ripple`
 * modules (#320/#321); #1027 folds them back because the split only produced
 * round-trip imports (each module imported its seam back from this core, which
 * then re-exported the module outward) and four no-op existence tests, shrinking
 * no interface. The real behaviour lives in `historical-snapshot.test.ts`.
 */

// ── Operations trigger (ADR 0012) ───────────────────────────────────────────

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

// ── The ripple row primitive (#1601) ─────────────────────────────────────────

/**
 * Everything a lane needs to decide what ONE holding's row is on this snapshot's
 * date. The primitive has already opened the frozen rows: the holding's own row
 * is set aside as `existingRow`, every other row waits verbatim in `otherRows`.
 */
interface RippleRowContext {
  /** The holding's frozen row on THIS snapshot, if it carried one. */
  existingRow: SnapshotHoldingRow | undefined;
  /**
   * Every OTHER frozen row of the snapshot, preserved verbatim (ADR 0008). Read
   * by a lane that resolves its row against its siblings (an associated debt's
   * rung) — the holding's own new row is appended only after `revalue` returns.
   */
  otherRows: readonly SnapshotHoldingRow[];
  /** The snapshot's date, YYYY-MM-DD. */
  targetDate: string;
  /** Re-weight a GLOBAL (100%) value into this snapshot's scope — the same
   *  allocation the headline figures use, so ADR 0008 holds by construction. */
  allocate: (globalValueMinor: number) => ScopedHolding;
}

/**
 * What a lane decides the holding's row IS on this date. Null means NO row: the
 * holding was not held then, or this scope holds no stake in it.
 */
interface RippleRowValuation {
  /** The SCOPE-WEIGHTED value the row freezes, integer minor units. */
  valueMinor: number;
  /**
   * The LIVE classification — the last resort of `resolveFrozenIdentity`, used
   * only for a row NO snapshot has ever frozen (precedence 3, #242).
   */
  liveIdentity: ResolvedFrozenIdentity;
  /** The fields only some lanes carry: units/unitPrice for an investment, the
   *  per-position breakdown for a connected collection (ADR 0035). */
  detail?: {
    units?: DecimalString | undefined;
    unitPrice?: DecimalString | undefined;
    positions?: SnapshotPositionRow[] | undefined;
  };
}

/**
 * The ripple row primitive (#1601). Every `recalculateSnapshotFor*` below is
 * THIS skeleton — open the frozen rows, re-value the holding, allocate it to the
 * scope, freeze its identity through `resolveFrozenIdentity` (#242), reassemble
 * and reconcile the snapshot (#181) — with exactly one lane-specific step:
 * `revalue`, how that holding is worth something on that date. Adding a trigger
 * is writing a `revalue`, not cloning the skeleton; changing "does this frozen
 * row exist?" is one edit, not six.
 *
 * Returns null when no holdings remain (the caller drops the snapshot), and
 * preserves every untouched frozen row verbatim: a ripple swaps ONE row and
 * re-derives the five headline figures from the new row set (ADR 0012).
 */
function rippleHoldingRow(
  input: {
    /** The existing snapshot (its id, scope, date, capturedAt are preserved). */
    snapshot: NetWorthSnapshot;
    /** The snapshot's currently frozen holding rows. */
    frozenHoldings: SnapshotHoldingRow[];
    workspace: Workspace;
    holding: {
      id: string;
      kind: SnapshotHoldingKind;
      /** The holding's live name — the label a brand-new row freezes. */
      name: string;
      ownership: OwnershipShare[];
    };
    /** The holding's frozen classification captures across every snapshot
     *  (#242) — the recovery basis for a row this snapshot never carried. */
    frozenIdentity?: readonly FrozenIdentityCapture[] | undefined;
  },
  revalue: (ctx: RippleRowContext) => RippleRowValuation | null,
): ValuedNetWorthSnapshot | null {
  const { holding, snapshot, workspace } = input;
  const scopeMemberIds = new Set(resolveScopeMemberIds(workspace, snapshot.scopeId));
  const rows = input.frozenHoldings.filter((row) => row.holdingId !== holding.id);
  const existingRow = input.frozenHoldings.find(
    (row) => row.holdingId === holding.id && row.kind === holding.kind,
  );

  const valuation = revalue({
    allocate: (globalValueMinor) =>
      allocateScopedHolding(globalValueMinor, {
        ownership: holding.ownership,
        scopeMemberIds,
      }),
    existingRow,
    otherRows: rows,
    targetDate: snapshot.dateKey,
  });

  if (valuation !== null) {
    // The FROZEN classification through the one seam (#242): this snapshot's own
    // row, else the contemporaneous capture from another snapshot, else live.
    const identity = resolveFrozenIdentity({
      existingRow,
      frozenIdentity: input.frozenIdentity ?? [],
      live: valuation.liveIdentity,
      targetDate: snapshot.dateKey,
    });
    const detail = valuation.detail;
    rows.push({
      countsAsHousing: identity.countsAsHousing,
      holdingId: holding.id,
      kind: holding.kind,
      label: existingRow?.label ?? holding.name,
      liquidityTier: identity.liquidityTier,
      securesHousing: identity.securesHousing,
      valueMinor: valuation.valueMinor,
      ...(detail?.units !== undefined ? { units: detail.units } : {}),
      ...(detail?.unitPrice !== undefined ? { unitPrice: detail.unitPrice } : {}),
      ...(detail?.positions !== undefined ? { positions: detail.positions } : {}),
    });
  }

  return assembleRippleSnapshot({
    currency: workspace.baseCurrency,
    frozenHoldings: input.frozenHoldings,
    rows,
    snapshot,
  });
}

/**
 * The LIVE classification of a LIABILITY's rippled row — the ONE place the rung /
 * securesHousing rule for a debt lives (#1601). Both the debt-curve ripple and
 * the ownership ripple mint debt rows, and they used to answer this with copied
 * branches that had drifted apart.
 *
 * A debt that secures HOUSING freezes the `housing` rung even when its home has
 * no frozen row on that date (#1436): the rung follows the asset's IDENTITY, not
 * its presence, exactly as the capture path resolves it against the live asset
 * set. Without it a mortgage born in a recalculation froze `cash` and stayed
 * there forever, since an existing row's rung is preserved by every later ripple
 * (ADR 0008) — it never moved a figure (`securesHousing` wins in `deriveRowAxes`)
 * but it drew a mortgage on the cash rung of the liquidity ladder.
 *
 * Otherwise an associated debt inherits its asset's frozen rung from the
 * surviving rows, else `cash` (`rungForLiability`); an unassociated debt freezes
 * null. A liability never counts as a housing ASSET.
 *
 * This lands on the SAME answer as the capture path (`buildSnapshotHoldingRows`)
 * by a different route, which is why the two read differently: the capture
 * resolves the rung against the LIVE asset set, where a securing home is always
 * present; a ripple has only the snapshot's frozen rows, where it may not be. The
 * `housing` short-circuit is what closes that gap, so every ripple and the capture
 * still produce the same row set for a date (#181).
 */
function liveLiabilityIdentity(
  liability: Liability,
  input: {
    housingAssetIds: ReadonlySet<string>;
    /** The snapshot's other frozen rows — where an associated debt reads its
     *  asset's frozen rung from. */
    otherRows: readonly SnapshotHoldingRow[];
  },
): ResolvedFrozenIdentity {
  const assetRungById = new Map(
    input.otherRows
      .filter((row) => row.kind === "asset" && row.liquidityTier !== null)
      .map((row) => [row.holdingId, row.liquidityTier!] as const),
  );
  return {
    countsAsHousing: false,
    liquidityTier: liability.associatedAssetId
      ? (housingSecuringRung(liability, input.housingAssetIds) ??
        rungForLiability(liability, assetRungById))
      : null,
    securesHousing: securesHousingAsset(liability, input.housingAssetIds),
  };
}

/**
 * Recalculate an existing snapshot after one investment's operations changed
 * (ADR 0012 ripple). Only that asset's row is recomputed; every other frozen
 * row — manual holdings, liabilities (including ones frozen with a null tier),
 * other investments, and holdings later renamed, re-valued, or trashed — is
 * preserved verbatim. The five headline figures are re-derived from the new row
 * set, so the tier classification of every untouched holding survives exactly as
 * captured (rows alone cannot reproduce it — a null-tier debt could be a mortgage
 * or a loan). The asset keeps the unit price the snapshot already captured; a
 * newly-appearing asset uses the last operation price ≤ the date.
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
  return rippleHoldingRow(
    {
      frozenHoldings: input.frozenHoldings,
      frozenIdentity: input.frozenIdentity,
      holding: {
        id: input.asset.id,
        kind: "asset",
        name: input.asset.name,
        ownership: input.asset.ownership,
      },
      snapshot: input.snapshot,
      workspace: input.workspace,
    },
    ({ allocate, existingRow, targetDate }) => {
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
      // Not held on that date, or this scope holds no stake: no row.
      if (valuation.valueMinor === null) return null;
      const { ownedMinor, totalShareBps } = allocate(valuation.valueMinor);
      if (totalShareBps <= 0) return null;

      return {
        detail: { units: valuation.units, unitPrice: valuation.unitPrice },
        // An investment is never housing / never secures housing.
        liveIdentity: {
          countsAsHousing: false,
          liquidityTier: tierOfAsset(input.asset),
          securesHousing: false,
        },
        valueMinor: ownedMinor,
      };
    },
  );
}

// ── Curve-anchor trigger (PRD #108/#109) ─────────────────────────────────────

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
  return rippleHoldingRow(
    {
      frozenHoldings: input.frozenHoldings,
      frozenIdentity: input.frozenIdentity,
      holding: {
        id: input.asset.id,
        kind: "asset",
        name: input.asset.name,
        ownership: input.asset.ownership,
      },
      snapshot: input.snapshot,
      workspace: input.workspace,
    },
    ({ allocate, targetDate }) => {
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

      const { ownedMinor, totalShareBps } = allocate(fullValueMinor);
      if (totalShareBps <= 0) return null;

      return {
        // This ripple is called only for housing assets, so live is
        // countsAsHousing=true / illiquid tier, matching the capture path; an
        // asset never secures housing (#180).
        liveIdentity: {
          countsAsHousing: true,
          liquidityTier: tierOfAsset(input.asset),
          securesHousing: false,
        },
        valueMinor: ownedMinor,
      };
    },
  );
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
  return rippleHoldingRow(
    {
      frozenHoldings: input.frozenHoldings,
      // The one lane that supplies NO frozen captures: a debt's tier and
      // securesHousing were always resolved from this snapshot's own row or from
      // live, never recovered from another snapshot. Passing them is a parameter
      // away the day a debt needs contemporaneous recovery (#242).
      holding: {
        id: input.liability.id,
        kind: "liability",
        name: input.liability.name,
        ownership: input.liability.ownership,
      },
      snapshot: input.snapshot,
      workspace: input.workspace,
    },
    ({ allocate, otherRows, targetDate }) => {
      // Same question, same answer as generate (#1438, ADR 0013): a date the debt
      // does not belong to yet carries NO row — not a recomputed one, and not an
      // existing frozen one either, which would preserve a membership the write
      // path (`buildSnapshotAtDate`) never would have produced.
      if (
        !liabilityExistsAtHistoricalDate({
          curve: input.curve,
          liability: input.liability,
          targetDate,
        })
      ) {
        return null;
      }

      // Value the liability on the target date via the unified dispatcher (#150
      // carry-over): the curve's model picks amortized / anchored, and a null model
      // falls back to the curve's current balance — byte-identical to the engines
      // this used to inline, but now threading early repayments in one place.
      const curveInput = debtCurveValuationInput(input.curve);
      const fullBalanceMinor =
        (curveInput ? valueAt(curveInput, targetDate).valueMinor : null) ??
        input.curve.currentBalanceMinor;
      const { ownedMinor, totalShareBps } = allocate(fullBalanceMinor);
      // The row keeps the SAME existence rule the capture path applies (a row for
      // any scope stake, even a zero balance) so every ripple and the capture
      // produce the same row set for a date (#181).
      if (totalShareBps <= 0) return null;

      return {
        // The debt's rung / securesHousing rule lives ONCE (#1601); an existing
        // row's frozen values still win inside the primitive's identity seam.
        liveIdentity: liveLiabilityIdentity(input.liability, {
          housingAssetIds: input.housingAssetIds,
          otherRows,
        }),
        valueMinor: ownedMinor,
      };
    },
  );
}

// ── Ownership-split trigger (#172, ADR 0020) ─────────────────────────────────

/** The edited holding's identity, carrying its NEW ownership split (#172). */
export type OwnershipRippleHolding =
  | { kind: "asset"; asset: ManualAsset }
  | {
      kind: "liability";
      liability: Liability;
      housingAssetIds: ReadonlySet<string>;
    };

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
  const { holding } = input;

  return rippleHoldingRow(
    {
      frozenHoldings: input.frozenHoldings,
      frozenIdentity: input.frozenIdentity,
      holding:
        holding.kind === "asset"
          ? {
              id: holding.asset.id,
              kind: "asset",
              name: holding.asset.name,
              ownership: holding.asset.ownership,
            }
          : {
              id: holding.liability.id,
              kind: "liability",
              name: holding.liability.name,
              ownership: holding.liability.ownership,
            },
      snapshot: input.snapshot,
      workspace: input.workspace,
    },
    ({ allocate, existingRow, otherRows }) => {
      // Re-weight the holding's (unchanged) global value into THIS scope by the
      // new split. Keep the SAME existence rule the capture path applies (a row
      // for any scope stake) so every ripple and the capture produce the same row
      // set for a date (#181) — a re-weight to a zero value still keeps the row.
      const { ownedMinor, totalShareBps } = allocate(input.globalValueMinor);
      if (totalShareBps <= 0) return null;

      return {
        // A re-weight never re-derives units or price: it carries the frozen ones.
        detail: { units: existingRow?.units, unitPrice: existingRow?.unitPrice },
        // The LIVE classification (precedence 3): an asset's housing-ness / tier
        // from its live identity; a debt's rung and securesHousing from the ONE
        // shared rule (#1601), the same one the debt-curve ripple applies.
        liveIdentity:
          holding.kind === "asset"
            ? {
                countsAsHousing: isHousingAsset(holding.asset),
                liquidityTier: tierOfAsset(holding.asset),
                securesHousing: false,
              }
            : liveLiabilityIdentity(holding.liability, {
                housingAssetIds: holding.housingAssetIds,
                otherRows,
              }),
        valueMinor: ownedMinor,
      };
    },
  );
}

// ── Position-revalue trigger (ADR 0017/0021) ─────────────────────────────────

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
   *
   * Used only for a row that carries NO per-position breakdown (a legacy capture
   * predating ADR 0035, or a fresh row with no trades to attach). When the row does
   * carry children, the increment is Σ of the children appended from `newTrades`
   * instead — see the decision comment in the body.
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
  /**
   * The newly-acquired coins rippling on this snapshot date (ADR 0035). Each
   * trade's GLOBAL value is scope-allocated into one frozen position child row;
   * existing position rows on the holding are preserved verbatim, and a trade
   * already frozen under the same `positionKey` is skipped (a re-delivery never
   * duplicates a child nor double-counts its value). Ignored for a row that
   * carries no breakdown — see {@link globalDeltaMinor}.
   */
  newTrades?: readonly {
    purchaseDate: string;
    position: SnapshotPositionInput;
  }[];
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
  return rippleHoldingRow(
    {
      frozenHoldings: input.frozenHoldings,
      frozenIdentity: input.frozenIdentity,
      holding: {
        id: input.asset.id,
        kind: "asset",
        name: input.asset.name,
        ownership: input.asset.ownership,
      },
      snapshot: input.snapshot,
      workspace: input.workspace,
    },
    ({ allocate, existingRow, targetDate }) => {
      const { ownedMinor, totalShareBps } = allocate(input.globalDeltaMinor);
      // Keep an existing row even when this scope gains no stake (totalShareBps 0),
      // so a re-weight to zero never silently drops it.
      if (existingRow === undefined && totalShareBps <= 0) return null;

      // Does this row CARRY a frozen breakdown (ADR 0035)? `undefined` means it does
      // not: either a legacy capture predating ADR 0035 — which froze the per-position
      // children going-forward only, so an older snapshot has the collection's row
      // with a value and no children — or a row an earlier ripple added before the
      // children existed. The distinction drives everything below, because the
      // per-position invariant (#181) applies ONLY to a row that carries children.
      const frozenPositions = existingRow?.positions;
      const seenPositionKeys = new Set(
        (frozenPositions ?? []).map((row) => row.positionKey),
      );
      const newPositionRows: SnapshotPositionRow[] = [];
      // Σ of the per-trade scope allocations of the children ACTUALLY appended — the
      // one figure the row's value grows by when the row carries a breakdown.
      let appendedPositionsMinor = 0;
      for (const trade of input.newTrades ?? []) {
        if (
          trade.purchaseDate > targetDate ||
          trade.position.valueMinor <= 0 ||
          seenPositionKeys.has(trade.position.positionKey)
        ) {
          continue;
        }
        // A trade this scope owns nothing of contributes no child row — and no value
        // either: ownership is a property of the COLLECTION, not of the trade, so
        // `totalShareBps === 0` here means the aggregate's share is 0 too and its
        // allocation is 0. The skip is therefore not an asymmetry in value; it only
        // avoids writing 0-valued children into a scope with no stake at all.
        const scoped = allocate(trade.position.valueMinor);
        if (scoped.totalShareBps === 0) {
          continue;
        }
        newPositionRows.push({
          positionKey: trade.position.positionKey,
          label: trade.position.label,
          valueMinor: scoped.ownedMinor,
          metal: trade.position.metal,
          imageUrl: trade.position.imageUrl,
        });
        appendedPositionsMinor += scoped.ownedMinor;
        seenPositionKeys.add(trade.position.positionKey);
      }

      // A row with NO frozen breakdown never grows a PARTIAL one: appending only the
      // new coins would make the row "carry positions" while the older coins baked
      // into its value have no children, and the per-position invariant — which
      // exempts a childless row explicitly — would then demand the new coins alone
      // sum to the whole row and fail the ripple (the sync that rolled back on every
      // retry: `sum to 7960 but the holding value is 331162`). Reconstructing the
      // missing children is impossible here: a coin's frozen historical value is not
      // recoverable (worthline never fetches a coin's past price, ADR 0017), so the
      // row stays childless and only its value grows, exactly as before ADR 0035.
      const positions =
        existingRow !== undefined && frozenPositions === undefined
          ? []
          : [...(frozenPositions ?? []), ...newPositionRows];
      const carriesBreakdown = positions.length > 0;

      // DECISION (#181 invariant vs ADR 0017 allocation): when the row carries a
      // breakdown, its value grows by Σ of the children appended above — never by
      // this scope's share of the AGGREGATE delta. Rounding the aggregate once and
      // rounding each trade separately can differ by a cent per trade under a
      // fractional split (3333 / 6667 bps), and the two figures also disagree
      // whenever a trade is skipped (already frozen by `positionKey` on a
      // re-delivery, or non-positive), so deriving the increment from the children
      // is the only way sum and value cannot desynchronize. The cost is that a
      // scope's frozen coin value is the sum of per-coin roundings rather than one
      // rounding of the total — cents apart at most, and the breakdown is what the
      // drilldown renders, so the children are the truth. A childless row keeps the
      // aggregate allocation: it has no children to derive an increment from, and no
      // invariant to satisfy.
      const incrementMinor = carriesBreakdown
        ? appendedPositionsMinor
        : totalShareBps > 0
          ? ownedMinor
          : 0;

      return {
        ...(carriesBreakdown ? { detail: { positions } } : {}),
        // A coin collection is constant illiquid, never a housing asset, never
        // secures housing.
        liveIdentity: {
          countsAsHousing: false,
          liquidityTier: tierOfAsset(input.asset),
          securesHousing: false,
        },
        valueMinor: (existingRow?.valueMinor ?? 0) + incrementMinor,
      };
    },
  );
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
  return rippleHoldingRow(
    {
      frozenHoldings: input.frozenHoldings,
      frozenIdentity: input.frozenIdentity,
      holding: {
        id: input.asset.id,
        kind: "asset",
        name: input.asset.name,
        ownership: input.asset.ownership,
      },
      snapshot: input.snapshot,
      workspace: input.workspace,
    },
    ({ allocate, existingRow }) => {
      const { ownedMinor, totalShareBps } = allocate(input.globalValueMinor);
      // SET (replace) the market holding's row to this scope's share of the date's
      // reconstructed value — never added onto the existing value (that is the
      // coin-acquisition path's contract, not this one). Keep an existing row even
      // when this scope gains no stake (totalShareBps 0), so a re-weight to zero never
      // silently drops it; a zero value with a stake still records the row (the holding
      // existed at 0 — unpriceable, ADR 0021).
      if (existingRow === undefined && totalShareBps <= 0) return null;

      return {
        // A connected crypto holding is constant market rung, never a housing
        // asset, never secures housing.
        liveIdentity: {
          countsAsHousing: false,
          liquidityTier: tierOfAsset(input.asset),
          securesHousing: false,
        },
        valueMinor: totalShareBps > 0 ? ownedMinor : (existingRow?.valueMinor ?? 0),
      };
    },
  );
}
