import type { AssetClassResolution, ExposureCoverage } from "./exposure-lookthrough";
import type { InvestmentOperation } from "./investment-types";
import type { CurrencyCode, MoneyMinor } from "./money";
import { money } from "./money";
import type {
  DatedPayout,
  IrrResult,
  MonthlyCloseValue,
  SimpleGain,
  TwrResult,
} from "./returns";
import type { SubsetReturnsSlice } from "./returns-subset";
import { FULL_SHARE_BPS, subsetReturns } from "./returns-subset";

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
  /**
   * Whether the class has no value attributed today: it is here because it once
   * held something, not because it holds it now (#1456). The class is still
   * emitted with all its measures — the domain MARKS, it never omits, so no
   * consumer loses a figure it could want — but a reader that ranks classes by
   * their weight in today's portfolio can fold it away. Same reasoning as a
   * closed position (`isClosedPosition`, #1348) one level up: a value that
   * multiplies nothing cannot compromise today's split.
   */
  closed: boolean;
}

export interface ReturnsByAssetClassInput {
  holdings: readonly AssetClassReturnsHolding[];
  currency: CurrencyCode;
  valuationDate: string;
}

export interface ReturnsByAssetClass {
  /**
   * One entry per class present, sorted by attributed value desc, then key — so
   * the classes marked `closed` (zero value today, #1456) sit last.
   */
  classes: AssetClassReturns[];
  /** Three-way coverage of attributed value (asset class has no not-applicable). */
  coverage: ExposureCoverage;
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

  // Upstream validation rejects a breakdown over 100%, so a negative
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
  // One bucket per class, each a list of SLICES of the contributing holdings: the
  // aggregation itself — the double scaling, the same-day netting, the monthly
  // alignment — belongs to `subsetReturns`, which the cartera gestionada rides too
  // (#1552). A class and a cartera are the same question about a different subset.
  const buckets = new Map<string, SubsetReturnsSlice[]>();

  for (const holding of input.holdings) {
    for (const [bucket, bps] of classShares(holding.assetClass)) {
      const slices = buckets.get(bucket);
      const slice: SubsetReturnsSlice = {
        marketValueMinor: holding.marketValueMinor,
        monthlyCloses: holding.monthlyCloses,
        operations: holding.operations,
        shareBps: bps,
        ...(holding.ownershipBps === undefined
          ? {}
          : { ownershipBps: holding.ownershipBps }),
        ...(holding.payouts === undefined ? {} : { payouts: holding.payouts }),
      };
      if (slices) {
        slices.push(slice);
      } else {
        buckets.set(bucket, [slice]);
      }
    }
  }

  const classes: AssetClassReturns[] = [...buckets.entries()]
    .map(([key, slices]) => {
      const returns = subsetReturns({
        currency: input.currency,
        slices,
        valuationDate: input.valuationDate,
      });
      return {
        // Callers feed this engine operation-bearing holdings only, so a zero
        // attributed value means the class was left (sold, transferred away) and
        // not that nothing was ever bought. A market value is never negative — the
        // `<=` is defensive, and treats an impossible negative the same way: a
        // class in that state sustains nothing either.
        closed: returns.marketValueMinor <= 0,
        irr: returns.irr,
        key,
        payoutsIncluded: returns.payoutsIncluded,
        simpleGain: returns.simpleGain,
        twr: returns.twr,
        value: money(returns.marketValueMinor, input.currency),
      };
    })
    .sort(
      (left, right) =>
        right.value.amountMinor - left.value.amountMinor ||
        left.key.localeCompare(right.key),
    );

  return { classes, coverage: coverageFrom(classes, input.currency) };
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
