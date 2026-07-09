import type { AssetClassResolution, ExposureCoverage } from "./exposure-lookthrough";
import type { InvestmentOperation } from "./investment-types";
import type { CurrencyCode, MoneyMinor } from "./money";
import { allocateByBps, money } from "./money";
import type {
  DatedCashflow,
  DatedPayout,
  IrrResult,
  MonthlyCloseValue,
  SimpleGain,
  TwrCashflow,
  TwrResult,
} from "./returns";
import {
  operationCashflows,
  operationTwrCashflows,
  payoutCashflows,
  simpleGainFromCashflows,
  timeWeightedReturn,
  xirr,
} from "./returns";

/**
 * Per-asset-class investment returns (#552, ADR 0040 fast-follow, gated on #539
 * S0). Groups holdings by their resolved exposure-profile **asset class** and
 * reports each class's simple gain / IRR / TWR — reusing the S0/S1 return engines
 * over each class bucket, and the same asset-class resolution the exposure
 * look-through uses (`resolveAssetClassBreakdown`), so grouping stays consistent
 * with the exposure surface.
 *
 * Attribution is **fractional and present-time**, mirroring the look-through: a
 * 60/40 fund contributes 60% of its cashflows, market value and monthly closes to
 * `equity` and 40% to `bond`. A breakdown that declares under 100% sends the
 * remainder to `other` (as the look-through does); a holding with no resolvable
 * class falls whole into `unclassified` — honest coverage, never a fabricated
 * class (#539's coverage model). Because the class weight is a present-time lens
 * (never frozen), it is applied uniformly across a holding's history — the same
 * approximation the look-through makes, declared not hidden.
 *
 * Pure: it takes pre-resolved class weights and an injected valuation date, so it
 * is deterministic and delegates every figure to the proven pure engines.
 *
 * Value allocation rounds each class weight to basis points (`allocateByBps`),
 * where the exposure look-through uses an exact largest-remainder split. For a
 * non-clean weight the two can differ by a minor unit or two, so a class `value`
 * reconciles with the matching `exposure.byAssetClass` slice at display (€)
 * granularity, not necessarily to the cent — acceptable for a derived, non-figure
 * lens (returns never feed the net-worth math).
 */

/** The bucket that collects holdings whose asset class cannot be resolved. */
export const UNCLASSIFIED_ASSET_CLASS_KEY = "unclassified";
/** The bucket that collects the declared-under-100% remainder of a breakdown. */
export const OTHER_ASSET_CLASS_KEY = "other";

const FULL_SHARE_BPS = 10_000;

/** One holding's return inputs plus its resolved asset-class breakdown. */
export interface AssetClassReturnsHolding {
  operations: readonly InvestmentOperation[];
  /** Current market value in minor units (0 when fully sold or unpriced). */
  marketValueMinor: number;
  /**
   * This holding's monthly-close value series (for TWR); empty when unavailable.
   * Must be on the SAME basis as `marketValueMinor` (both gross, or both scoped).
   */
  monthlyCloses: readonly MonthlyCloseValue[];
  /** The resolved asset-class weights, from `resolveAssetClassBreakdown`. */
  assetClass: AssetClassResolution;
  /**
   * The owner's share in basis points (default 10000 = whole holding), applied to
   * the operation cashflows BEFORE the class weight. `marketValueMinor` and
   * `monthlyCloses` must ALREADY be on the caller's chosen basis: pass the scoped
   * `ownedMinor` value + `ownershipBps` for an ownership-scoped decomposition (the
   * agent view, matching the portfolio block), or the full value + omit
   * `ownershipBps` for a gross one (the dashboard). Keeping the three inputs on one
   * basis is what makes each class's simple gain / IRR internally consistent.
   */
  ownershipBps?: number;
  /**
   * Recorded distributions (dividends/coupons/rent, #657), scaled by ownership
   * then class weight exactly like the operation cashflows, so a class's simple
   * gain / IRR stays coherent with the portfolio measures.
   */
  payouts?: readonly DatedPayout[];
}

/** One asset class's blended returns over the fractional slice of every holding. */
export interface AssetClassReturns {
  /** `equity` | `bond` | … | `other` | `unclassified`. */
  key: string;
  /** Present-time market value attributed to the class. */
  value: MoneyMinor;
  simpleGain: SimpleGain;
  irr: IrrResult;
  twr: TwrResult;
  /** Whether any recorded payout was folded into this class (#657) — per-class so a
   *  payout-free class never claims income it did not receive. */
  payoutsIncluded: boolean;
}

export interface ReturnsByAssetClassInput {
  holdings: readonly AssetClassReturnsHolding[];
  currency: CurrencyCode;
  valuationDate: string;
}

export interface ReturnsByAssetClass {
  /** One entry per class present, sorted by attributed value desc, then key. */
  classes: AssetClassReturns[];
  /** Three-way coverage of attributed value (asset class has no not-applicable). */
  coverage: ExposureCoverage;
}

interface BucketAccumulator {
  cashflows: DatedCashflow[];
  twrCashflows: TwrCashflow[];
  marketValueMinor: number;
  monthlyByDate: Map<string, number>;
  payoutsIncluded: boolean;
}

/**
 * A holding's asset-class weights as `[bucketKey, shareBps]` pairs. Classified
 * breakdowns map each bucket to its weight in basis points; a declared-under-100%
 * remainder goes to `other`. An unknown class sends the whole holding to
 * `unclassified`.
 */
function classShares(resolution: AssetClassResolution): Array<[string, number]> {
  if (resolution.kind === "unknown") {
    return [[UNCLASSIFIED_ASSET_CLASS_KEY, FULL_SHARE_BPS]];
  }

  const shares: Array<[string, number]> = [];
  let assignedBps = 0;
  for (const [bucket, weight] of Object.entries(resolution.breakdown)) {
    const bps = Math.round(Number(weight) * FULL_SHARE_BPS);
    if (bps <= 0) {
      continue;
    }
    assignedBps += bps;
    shares.push([bucket, bps]);
  }

  // Upstream `createExposureProfile` rejects a breakdown over 100%, so a negative
  // remainder cannot occur here; the guard is defensive (no `other` when full).
  const remainderBps = FULL_SHARE_BPS - assignedBps;
  if (remainderBps > 0) {
    shares.push([OTHER_ASSET_CLASS_KEY, remainderBps]);
  }

  return shares;
}

export function returnsByAssetClass(
  input: ReturnsByAssetClassInput,
): ReturnsByAssetClass {
  const buckets = new Map<string, BucketAccumulator>();
  const ensure = (key: string): BucketAccumulator => {
    const existing = buckets.get(key);
    if (existing) {
      return existing;
    }
    const created: BucketAccumulator = {
      cashflows: [],
      marketValueMinor: 0,
      monthlyByDate: new Map(),
      payoutsIncluded: false,
      twrCashflows: [],
    };
    buckets.set(key, created);
    return created;
  };

  for (const holding of input.holdings) {
    const ownershipBps = holding.ownershipBps ?? FULL_SHARE_BPS;
    // Ownership scales the operation cashflows to the owned slice (mirroring the
    // portfolio block's per-flow scaling); `marketValueMinor` / `monthlyCloses`
    // arrive already on the caller's basis, so only the class weight applies to
    // them below. Both on one basis → each class's simple gain / IRR is coherent.
    // Operations and recorded payouts share one signed stream (a payout is a
    // positive inflow); TWR excludes payouts (#657 scope) and stays on operations.
    const hasPayouts = (holding.payouts?.length ?? 0) > 0;
    const cashflows = [
      ...operationCashflows(holding.operations),
      ...payoutCashflows(holding.payouts),
    ].map((flow) => ({
      amountMinor: allocateByBps(flow.amountMinor, ownershipBps),
      date: flow.date,
    }));
    const twrCashflows = operationTwrCashflows(holding.operations).map((flow) => ({
      amountMinor: allocateByBps(flow.amountMinor, ownershipBps),
      date: flow.date,
    }));

    for (const [bucket, bps] of classShares(holding.assetClass)) {
      const acc = ensure(bucket);
      if (hasPayouts) {
        acc.payoutsIncluded = true;
      }
      for (const flow of cashflows) {
        acc.cashflows.push({
          amountMinor: allocateByBps(flow.amountMinor, bps),
          date: flow.date,
        });
      }
      for (const flow of twrCashflows) {
        acc.twrCashflows.push({
          amountMinor: allocateByBps(flow.amountMinor, bps),
          date: flow.date,
        });
      }
      acc.marketValueMinor += allocateByBps(holding.marketValueMinor, bps);
      // Merge closes by date across the class's holdings. Worthline snapshots are
      // portfolio-wide (one capture/day covering every holding, ADR 0005), so a
      // month's close date is shared across co-existing holdings — the union does
      // not desync them. A holding that ENTERS or EXITS mid-span shifts the class
      // value on that boundary, but its buy/sell is in `twrCashflows` (scaled the
      // same way), so Modified Dietz offsets the step rather than reading it as a
      // price move.
      for (const close of holding.monthlyCloses) {
        acc.monthlyByDate.set(
          close.date,
          (acc.monthlyByDate.get(close.date) ?? 0) + allocateByBps(close.valueMinor, bps),
        );
      }
    }
  }

  const classes: AssetClassReturns[] = [...buckets.entries()]
    .map(([key, acc]) => ({
      irr: xirr([
        ...acc.cashflows,
        ...(acc.marketValueMinor > 0
          ? [{ amountMinor: acc.marketValueMinor, date: input.valuationDate }]
          : []),
      ]),
      key,
      payoutsIncluded: acc.payoutsIncluded,
      simpleGain: simpleGainFromCashflows({
        cashflows: acc.cashflows,
        currency: input.currency,
        marketValueMinor: acc.marketValueMinor,
        valuationDate: input.valuationDate,
      }),
      twr: timeWeightedReturn({
        cashflows: acc.twrCashflows,
        monthlyCloses: monthlyClosesFrom(acc.monthlyByDate),
      }),
      value: money(acc.marketValueMinor, input.currency),
    }))
    .sort(
      (left, right) =>
        right.value.amountMinor - left.value.amountMinor ||
        left.key.localeCompare(right.key),
    );

  return { classes, coverage: coverageFrom(classes, input.currency) };
}

function monthlyClosesFrom(byDate: ReadonlyMap<string, number>): MonthlyCloseValue[] {
  return [...byDate.entries()]
    .map(([date, valueMinor]) => ({ date, valueMinor }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function coverageFrom(
  classes: readonly AssetClassReturns[],
  currency: CurrencyCode,
): ExposureCoverage {
  let unknownMinor = 0;
  let classifiedMinor = 0;
  for (const entry of classes) {
    if (entry.key === UNCLASSIFIED_ASSET_CLASS_KEY) {
      unknownMinor += entry.value.amountMinor;
    } else {
      classifiedMinor += entry.value.amountMinor;
    }
  }

  return {
    classified: money(classifiedMinor, currency),
    notApplicable: money(0, currency),
    unknown: money(unknownMinor, currency),
  };
}
